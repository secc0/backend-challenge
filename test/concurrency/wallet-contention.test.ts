import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SubmitResult } from '../../src/application/submit-wager-transaction';
import type { Container } from '../../src/container';
import {
  createTestContainer,
  createWallet,
  expectConsistent,
  http,
  ledgerCount,
  sleep,
  truncateAll,
  wager,
  walletBalance,
} from '../helpers/harness';

/**
 * Two containers = two independent connection pools, i.e. two application
 * instances sharing one database. Requests are fired with Promise.all, so
 * they really run concurrently inside PostgreSQL.
 */
describe('concurrency on a single database with two instances', () => {
  let a: Container;
  let b: Container;
  const instance = (i: number) => (i % 2 === 0 ? a : b);

  beforeAll(async () => {
    a = await createTestContainer();
    b = await createTestContainer({}, {});
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });
  beforeEach(async () => truncateAll(a.db));

  test('required scenario: 100.00, two concurrent BETs of 80.00 → exactly one succeeds', async () => {
    const wallet = await createWallet(a, '100.00');
    const results = await Promise.all([
      a.submitWager.execute(wager({ playerId: wallet.playerId, amount: '80.00' }), http),
      b.submitWager.execute(wager({ playerId: wallet.playerId, amount: '80.00' }), http),
    ]);

    const statuses = results.map((r) => r.transaction.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.transaction.status === 'REJECTED')?.transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletBalance(a, wallet.id)).toBe('20.00');
    const debits = await a.db.reader().query(`SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [
      wallet.id,
    ]);
    expect(debits).toHaveLength(1);
    await expectConsistent(a);
  });

  test('the required scenario holds over many repetitions', async () => {
    for (let round = 0; round < 25; round++) {
      const wallet = await createWallet(a, '100.00');
      const results = await Promise.all([
        a.submitWager.execute(wager({ playerId: wallet.playerId, amount: '80.00' }), http),
        b.submitWager.execute(wager({ playerId: wallet.playerId, amount: '80.00' }), http),
      ]);
      expect(results.filter((r) => r.transaction.status === 'PROCESSED')).toHaveLength(1);
      expect(await walletBalance(a, wallet.id)).toBe('20.00');
    }
    await expectConsistent(a);
  });

  test('50 parallel identical BETs (same idempotency key) → one debit, 49 replays', async () => {
    const wallet = await createWallet(a, '100.00');
    const command = wager({ playerId: wallet.playerId, amount: '10.00' });
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => instance(i).submitWager.execute(command, http)));

    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.every((r) => r.transaction.status === 'PROCESSED')).toBe(true);
    expect(await walletBalance(a, wallet.id)).toBe('90.00');
    expect(await ledgerCount(a, wallet.id)).toBe(2);
    await expectConsistent(a);
  });

  test('50 parallel identical BETs under different idempotency keys (same provider id) → one debit', async () => {
    const wallet = await createWallet(a, '100.00');
    const command = wager({ playerId: wallet.playerId, amount: '10.00' });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => instance(i).submitWager.execute({ ...command, idempotencyKey: `key-${i}` }, http)),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await walletBalance(a, wallet.id)).toBe('90.00');
  });

  test('50 parallel distinct BETs of 10.00 on 100.00 → exactly 10 succeed, balance never negative', async () => {
    const wallet = await createWallet(a, '100.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => instance(i).submitWager.execute(wager({ playerId: wallet.playerId, amount: '10.00' }), http)),
    );
    expect(results.filter((r) => r.transaction.status === 'PROCESSED')).toHaveLength(10);
    expect(results.filter((r) => r.transaction.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(40);
    expect(await walletBalance(a, wallet.id)).toBe('0.00');
    expect(await ledgerCount(a, wallet.id)).toBe(11);
    await expectConsistent(a);
  });

  test('concurrent REFUND and ROLLBACK of the same BET → only one reversal', async () => {
    const wallet = await createWallet(a, '100.00');
    const bet = await a.submitWager.execute(wager({ playerId: wallet.playerId, amount: '30.00' }), http);
    const ref = bet.transaction.externalId;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        instance(i).submitWager.execute(
          wager({ playerId: wallet.playerId, type: i % 2 ? 'REFUND' : 'ROLLBACK', amount: '30.00', referenceExternalId: ref }),
          http,
        ),
      ),
    );
    expect(results.filter((r) => r.transaction.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.transaction.failureCode === 'ALREADY_REVERSED')).toHaveLength(9);
    expect(await walletBalance(a, wallet.id)).toBe('100.00');
    await expectConsistent(a);
  });

  test('mixed load over many wallets: every balance equals the ledger', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(a, '50.00')));
    const operations: Array<Promise<SubmitResult>> = [];
    for (let i = 0; i < 300; i++) {
      const wallet = wallets[i % wallets.length]!;
      const roll = i % 5;
      const type = roll < 3 ? 'BET' : roll === 3 ? 'WIN' : 'LOSS';
      const amount = type === 'LOSS' ? '0.00' : `${(i % 7) + 1}.${String(i % 100).padStart(2, '0')}`;
      operations.push(instance(i).submitWager.execute(wager({ playerId: wallet.playerId, type, amount }), http));
    }
    const results = await Promise.all(operations);

    for (const wallet of wallets) {
      // Balance must equal opening + processed credits − processed debits, computed from the results.
      let expected = 5000n;
      for (const r of results) {
        const tx = r.transaction;
        if (tx.walletId !== wallet.id || tx.status !== 'PROCESSED') continue;
        if (tx.kind === 'WIN') expected += tx.amount.minorUnits;
        if (tx.kind === 'BET') expected -= tx.amount.minorUnits;
      }
      const balance = (await a.queries.wallet(wallet.id)).balance;
      expect(balance.minorUnits).toBe(expected);
      expect(balance.minorUnits >= 0n).toBe(true);
    }
    await expectConsistent(a);
  });

  test('wallets do not block each other (no global lock)', async () => {
    const busy = await createWallet(a, '100.00');
    const free = await createWallet(a, '100.00');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locker = a.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [busy.id]);
      await held;
    });
    try {
      const started = Date.now();
      const result = await b.submitWager.execute(wager({ playerId: free.playerId, amount: '1.00' }), http);
      expect(result.transaction.status).toBe('PROCESSED');
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      release();
      await locker;
    }
  });

  test('two SQS consumers receiving duplicates of the same transaction apply it once', async () => {
    const wallet = await createWallet(a, '100.00');
    const command = wager({ playerId: wallet.playerId, amount: '10.00' });
    // Different message groups so both consumers can receive them at the same time.
    for (let i = 0; i < 6; i++) {
      await a.sqs.send(
        new SendMessageCommand({
          QueueUrl: a.queues.wager,
          MessageBody: JSON.stringify(command),
          MessageGroupId: `group-${i}`,
          MessageDeduplicationId: crypto.randomUUID(),
        }),
      );
    }
    // Container b reads a's queue through a second consumer instance.
    const { WagerConsumer } = await import('../../src/infrastructure/sqs/wager-consumer');
    const second = new WagerConsumer(b.sqs, a.queues.wager, a.queues.dlq, b.submitWager, b.config.sqs, b.metrics, b.logger);
    const results: string[] = [];
    const deadline = Date.now() + 15_000;
    while (results.length < 6 && Date.now() < deadline) {
      const [x, y] = await Promise.all([a.consumer.pollOnce(1), second.pollOnce(1)]);
      results.push(...x, ...y);
      if (results.length < 6) await sleep(50);
    }
    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(5);
    expect(await walletBalance(a, wallet.id)).toBe('90.00');
  });
});
