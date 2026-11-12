import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../src/application/errors';
import type { Container } from '../../src/container';
import {
  createTestContainer,
  createWallet,
  expectConsistent,
  http,
  ledgerCount,
  outboxEventTypes,
  truncateAll,
  wager,
  walletBalance,
} from '../helpers/harness';

describe('wager processing against PostgreSQL', () => {
  let c: Container;
  let now = new Date();

  beforeAll(async () => {
    c = await createTestContainer(
      { pendingReference: { initialBackoffMs: 0, ttlMs: 60_000, maxAttempts: 3, maxBackoffMs: 0 } },
      { clock: () => now },
    );
  });
  afterAll(async () => c.close());
  beforeEach(async () => {
    now = new Date();
    await truncateAll(c.db);
  });

  test('opening balance is recorded as an OPENING transaction with its ledger entry', async () => {
    const wallet = await createWallet(c, '100.00');
    expect(await walletBalance(c, wallet.id)).toBe('100.00');
    expect(await ledgerCount(c, wallet.id)).toBe(1);
    expect(await outboxEventTypes(c)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    await expectConsistent(c);
  });

  test('BET, WIN and LOSS update balance, ledger and outbox in one go', async () => {
    const wallet = await createWallet(c, '100.00');
    const bet = await c.submitWager.execute(wager({ playerId: wallet.playerId, amount: '30.00' }), http);
    const win = await c.submitWager.execute(wager({ playerId: wallet.playerId, type: 'WIN', amount: '45.50' }), http);
    const loss = await c.submitWager.execute(wager({ playerId: wallet.playerId, type: 'LOSS', amount: '0.00' }), http);

    expect([bet, win, loss].map((r) => r.transaction.status)).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED']);
    expect(await walletBalance(c, wallet.id)).toBe('115.50');
    expect(await ledgerCount(c, wallet.id)).toBe(3); // opening + bet + win, LOSS has no entry
    expect((await c.queries.wallet(wallet.id)).version).toBe(3);
    expect(await outboxEventTypes(c, loss.transaction.id)).toEqual(['WagerTransactionProcessed']);
    await expectConsistent(c);
  });

  test('rejections are persisted with a failure code and do not touch the ledger', async () => {
    const wallet = await createWallet(c, '10.00');
    const result = await c.submitWager.execute(wager({ playerId: wallet.playerId, amount: '10.01' }), http);
    expect(result.transaction.status).toBe('REJECTED');
    expect(result.transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletBalance(c, wallet.id)).toBe('10.00');
    expect(await ledgerCount(c, wallet.id)).toBe(1);
    expect(await outboxEventTypes(c, result.transaction.id)).toEqual(['WagerTransactionRejected']);
  });

  test('unknown wallet is a business rejection', async () => {
    const result = await c.submitWager.execute(wager({ playerId: 'nobody' }), http);
    expect(result.transaction.status).toBe('REJECTED');
    expect(result.transaction.failureCode).toBe('WALLET_NOT_FOUND');
  });

  describe('idempotency', () => {
    test('a replay returns the original result without a second movement', async () => {
      const wallet = await createWallet(c, '100.00');
      const command = wager({ playerId: wallet.playerId, amount: '30.00' });
      const first = await c.submitWager.execute(command, http);
      const second = await c.submitWager.execute(command, http);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.transaction.id).toBe(first.transaction.id);
      expect(await walletBalance(c, wallet.id)).toBe('70.00');
      expect(await ledgerCount(c, wallet.id)).toBe(2);
    });

    test('a replay of a rejection is still the same rejection, even if funds arrived meanwhile', async () => {
      const wallet = await createWallet(c, '10.00');
      const command = wager({ playerId: wallet.playerId, amount: '50.00' });
      const first = await c.submitWager.execute(command, http);
      await c.submitWager.execute(wager({ playerId: wallet.playerId, type: 'WIN', amount: '100.00' }), http);
      const second = await c.submitWager.execute(command, http);
      expect(first.transaction.status).toBe('REJECTED');
      expect(second.transaction.status).toBe('REJECTED');
      expect(second.transaction.id).toBe(first.transaction.id);
    });

    test('same key with a different payload is a conflict', async () => {
      const wallet = await createWallet(c, '100.00');
      const command = wager({ playerId: wallet.playerId, amount: '30.00' });
      await c.submitWager.execute(command, http);
      await expect(c.submitWager.execute({ ...command, amount: '31.00' }, http)).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(await walletBalance(c, wallet.id)).toBe('70.00');
    });

    test('same provider transaction id under another key is the same transaction', async () => {
      const wallet = await createWallet(c, '100.00');
      const command = wager({ playerId: wallet.playerId, amount: '30.00' });
      const first = await c.submitWager.execute(command, http);
      const second = await c.submitWager.execute({ ...command, idempotencyKey: 'another-key' }, http);
      expect(second.replayed).toBe(true);
      expect(second.transaction.id).toBe(first.transaction.id);
      await expect(
        c.submitWager.execute({ ...command, idempotencyKey: 'yet-another', amount: '1.00' }, http),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    test('idempotency survives a restart (it lives in PostgreSQL)', async () => {
      const wallet = await createWallet(c, '100.00');
      const command = wager({ playerId: wallet.playerId, amount: '30.00' });
      await c.submitWager.execute(command, http);
      const fresh = await createTestContainer();
      try {
        const replay = await fresh.submitWager.execute(command, http);
        expect(replay.replayed).toBe(true);
      } finally {
        await fresh.close();
      }
      expect(await walletBalance(c, wallet.id)).toBe('70.00');
    });
  });

  describe('atomicity', () => {
    test('a crash before commit leaves no trace: no transaction, balance, ledger, inbox nor event', async () => {
      const wallet = await createWallet(c, '100.00');
      const command = wager({ playerId: wallet.playerId, amount: '30.00' });
      const eventsBefore = (await outboxEventTypes(c)).length;
      await expect(
        c.submitWager.execute(command, {
          ...http,
          channel: 'sqs',
          inbox: { consumer: 'test', messageId: 'm-1' },
          beforeCommit: () => {
            throw new Error('simulated crash');
          },
        }),
      ).rejects.toThrow('simulated crash');

      expect(await walletBalance(c, wallet.id)).toBe('100.00');
      expect(await ledgerCount(c, wallet.id)).toBe(1);
      expect((await outboxEventTypes(c)).length).toBe(eventsBefore);
      expect(await c.db.reader().query('SELECT 1 FROM wager_transactions WHERE external_id = ?', [command.externalId])).toHaveLength(0);
      expect(await c.db.reader().query(`SELECT 1 FROM inbox_messages WHERE message_id = 'm-1'`)).toHaveLength(0);

      // The redelivery is processed normally.
      const retry = await c.submitWager.execute(command, { ...http, channel: 'sqs', inbox: { consumer: 'test', messageId: 'm-1' } });
      expect(retry.transaction.status).toBe('PROCESSED');
      expect(await walletBalance(c, wallet.id)).toBe('70.00');
      await expectConsistent(c);
    });
  });

  describe('reversals', () => {
    test('REFUND of a BET returns the stake; a second reversal is ALREADY_REVERSED', async () => {
      const wallet = await createWallet(c, '100.00');
      const bet = await c.submitWager.execute(wager({ playerId: wallet.playerId, amount: '40.00' }), http);
      const refund = await c.submitWager.execute(
        wager({ playerId: wallet.playerId, type: 'REFUND', amount: '40.00', referenceExternalId: bet.transaction.externalId }),
        http,
      );
      const rollback = await c.submitWager.execute(
        wager({ playerId: wallet.playerId, type: 'ROLLBACK', amount: '40.00', referenceExternalId: bet.transaction.externalId }),
        http,
      );
      expect(refund.transaction.status).toBe('PROCESSED');
      expect(refund.transaction.referenceTransactionId).toBe(bet.transaction.id);
      expect(rollback.transaction.failureCode).toBe('ALREADY_REVERSED');
      expect(await walletBalance(c, wallet.id)).toBe('100.00');
      await expectConsistent(c);
    });

    test('reference must match player, round and amount', async () => {
      const wallet = await createWallet(c, '100.00');
      const other = await createWallet(c, '100.00');
      const bet = await c.submitWager.execute(wager({ playerId: wallet.playerId, amount: '40.00' }), http);
      const ref = bet.transaction.externalId;
      const cases = [
        [wager({ playerId: other.playerId, type: 'REFUND', amount: '40.00', referenceExternalId: ref }), 'REFERENCE_MISMATCH'],
        [wager({ playerId: wallet.playerId, type: 'REFUND', amount: '40.00', roundId: 'r9', referenceExternalId: ref }), 'REFERENCE_MISMATCH'],
        [wager({ playerId: wallet.playerId, type: 'REFUND', amount: '39.99', referenceExternalId: ref }), 'AMOUNT_MISMATCH'],
      ] as const;
      for (const [command, code] of cases) {
        const result = await c.submitWager.execute(command, http);
        expect(result.transaction.failureCode).toBe(code);
      }
      expect(await walletBalance(c, wallet.id)).toBe('60.00');
    });

    test('a reversal from another provider does not see the original', async () => {
      const wallet = await createWallet(c, '100.00');
      const bet = await c.submitWager.execute(wager({ playerId: wallet.playerId, amount: '40.00' }), http);
      const refund = await c.submitWager.execute(
        wager({ playerId: wallet.playerId, provider: 'provider-b', type: 'REFUND', amount: '40.00', referenceExternalId: bet.transaction.externalId }),
        http,
      );
      expect(refund.transaction.status).toBe('PENDING_REFERENCE');
    });
  });

  describe('out of order delivery (PENDING_REFERENCE)', () => {
    test('a REFUND that arrives before its BET is resolved once the BET arrives', async () => {
      const wallet = await createWallet(c, '100.00');
      const betCommand = wager({ playerId: wallet.playerId, amount: '25.00' });
      const refund = await c.submitWager.execute(
        wager({ playerId: wallet.playerId, type: 'REFUND', amount: '25.00', referenceExternalId: betCommand.externalId }),
        http,
      );
      expect(refund.transaction.status).toBe('PENDING_REFERENCE');
      expect(await outboxEventTypes(c, refund.transaction.id)).toEqual(['WagerTransactionPendingReference']);

      await c.submitWager.execute(betCommand, http);
      expect(await walletBalance(c, wallet.id)).toBe('75.00');

      await c.resolvePendingReferences.runOnce();
      const resolved = await c.queries.transaction(refund.transaction.id);
      expect(resolved.status).toBe('PROCESSED');
      expect(await walletBalance(c, wallet.id)).toBe('100.00');
      expect(await outboxEventTypes(c, refund.transaction.id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed']);

      // Replaying the REFUND now returns its final state.
      const replay = await c.submitWager.execute(
        wager({ playerId: wallet.playerId, type: 'REFUND', amount: '25.00', referenceExternalId: betCommand.externalId, externalId: refund.transaction.externalId }),
        http,
      );
      expect(replay.transaction.status).toBe('PROCESSED');
      await expectConsistent(c);
    });

    test('a pending reversal whose original was rejected is rejected', async () => {
      const wallet = await createWallet(c, '10.00');
      const betCommand = wager({ playerId: wallet.playerId, amount: '50.00' });
      const refund = await c.submitWager.execute(
        wager({ playerId: wallet.playerId, type: 'REFUND', amount: '50.00', referenceExternalId: betCommand.externalId }),
        http,
      );
      await c.submitWager.execute(betCommand, http);
      await c.resolvePendingReferences.runOnce();
      const resolved = await c.queries.transaction(refund.transaction.id);
      expect(resolved.status).toBe('REJECTED');
      expect(resolved.failureCode).toBe('REFERENCE_NOT_PROCESSED');
      expect(await walletBalance(c, wallet.id)).toBe('10.00');
    });

    test('after the attempt budget the transaction FAILS with REFERENCE_NOT_FOUND', async () => {
      const wallet = await createWallet(c, '10.00');
      const refund = await c.submitWager.execute(
        wager({ playerId: wallet.playerId, type: 'REFUND', amount: '5.00', referenceExternalId: 'never-arrives' }),
        http,
      );
      for (let i = 0; i < 3; i++) await c.resolvePendingReferences.runOnce();
      const failed = await c.queries.transaction(refund.transaction.id);
      expect(failed.status).toBe('FAILED');
      expect(failed.failureCode).toBe('REFERENCE_NOT_FOUND');
      expect(await outboxEventTypes(c, refund.transaction.id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    });

    test('after the TTL the transaction FAILS even with attempts left', async () => {
      const wallet = await createWallet(c, '10.00');
      const refund = await c.submitWager.execute(
        wager({ playerId: wallet.playerId, type: 'REFUND', amount: '5.00', referenceExternalId: 'late' }),
        http,
      );
      now = new Date(now.getTime() + 61_000);
      await c.resolvePendingReferences.runOnce();
      expect((await c.queries.transaction(refund.transaction.id)).status).toBe('FAILED');
    });
  });
});
