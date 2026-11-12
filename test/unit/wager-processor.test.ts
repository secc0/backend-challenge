import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../src/domain/errors';
import { eventsFor } from '../../src/domain/events';
import { Money } from '../../src/domain/money';
import { processWager } from '../../src/domain/wager-processor';
import { WagerTransaction, type WagerKind } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

const now = new Date('2026-01-01T00:00:00Z');
const brl = (amount: string) => Money.of(amount, 'BRL');

function walletWith(balance: string, playerId = 'p1'): Wallet {
  const wallet = Wallet.create({ playerId, currency: 'BRL', now, id: `wallet-${playerId}` });
  if (balance !== '0.00') wallet.credit(brl(balance), 'opening', now);
  return Wallet.rehydrate({
    id: wallet.id,
    playerId,
    currency: 'BRL',
    balance: wallet.balance,
    version: wallet.version,
    createdAt: now,
    updatedAt: now,
  });
}

let counter = 0;
function tx(kind: WagerKind, amount: string, extra: { reference?: string; playerId?: string; roundId?: string } = {}) {
  const externalId = `ext-${++counter}`;
  return WagerTransaction.create({
    idempotencyKey: externalId,
    payloadHash: 'h'.repeat(64),
    provider: 'prov',
    externalId,
    playerId: extra.playerId ?? 'p1',
    roundId: extra.roundId ?? 'r1',
    kind,
    amount: brl(amount),
    referenceExternalId: extra.reference ?? null,
    now,
  });
}

/** A transaction that was already processed against `wallet`. */
function processed(kind: WagerKind, amount: string, wallet: Wallet): WagerTransaction {
  const t = tx(kind, amount);
  const result = processWager({ transaction: t, wallet, reference: null, referenceAlreadyReversed: false, now });
  expect(result.type).toBe('PROCESSED');
  return t;
}

describe('processWager: BET / WIN / LOSS', () => {
  test('BET debits the wallet', () => {
    const wallet = walletWith('100.00');
    const bet = tx('BET', '30.00');
    const result = processWager({ transaction: bet, wallet, reference: null, referenceAlreadyReversed: false, now });
    expect(result.type).toBe('PROCESSED');
    expect(bet.status).toBe('PROCESSED');
    expect(bet.balanceAfter?.toString()).toBe('70.00');
    expect(wallet.balance.toString()).toBe('70.00');
  });

  test('BET without funds is rejected with INSUFFICIENT_FUNDS and changes nothing', () => {
    const wallet = walletWith('10.00');
    const bet = tx('BET', '10.01');
    const result = processWager({ transaction: bet, wallet, reference: null, referenceAlreadyReversed: false, now });
    expect(result).toEqual({ type: 'REJECTED', code: 'INSUFFICIENT_FUNDS' });
    expect(bet.status).toBe('REJECTED');
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.hasChanges()).toBe(false);
  });

  test('WIN credits the wallet', () => {
    const wallet = walletWith('0.00');
    const win = tx('WIN', '55.55');
    processWager({ transaction: win, wallet, reference: null, referenceAlreadyReversed: false, now });
    expect(wallet.balance.toString()).toBe('55.55');
  });

  test('LOSS is processed without touching the balance or the ledger', () => {
    const wallet = walletWith('10.00');
    const loss = tx('LOSS', '0.00');
    const result = processWager({ transaction: loss, wallet, reference: null, referenceAlreadyReversed: false, now });
    expect(result).toEqual({ type: 'PROCESSED', ledgerEntry: null });
    expect(wallet.hasChanges()).toBe(false);
    expect(wallet.version).toBe(1);
  });
});

describe('processWager: reversals', () => {
  test('REFUND of a BET credits the stake back', () => {
    const wallet = walletWith('100.00');
    const bet = processed('BET', '40.00', wallet);
    const refund = tx('REFUND', '40.00', { reference: bet.externalId });
    const result = processWager({ transaction: refund, wallet, reference: bet, referenceAlreadyReversed: false, now });
    expect(result.type).toBe('PROCESSED');
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('ROLLBACK of a WIN debits the prize back', () => {
    const wallet = walletWith('0.00');
    const win = processed('WIN', '25.00', wallet);
    const rollback = tx('ROLLBACK', '25.00', { reference: win.externalId });
    processWager({ transaction: rollback, wallet, reference: win, referenceAlreadyReversed: false, now });
    expect(rollback.status).toBe('PROCESSED');
    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('ROLLBACK of a REFUND debits the refund back', () => {
    const wallet = walletWith('50.00');
    const bet = processed('BET', '50.00', wallet);
    const refund = tx('REFUND', '50.00', { reference: bet.externalId });
    processWager({ transaction: refund, wallet, reference: bet, referenceAlreadyReversed: false, now });
    const rollback = tx('ROLLBACK', '50.00', { reference: refund.externalId });
    processWager({ transaction: rollback, wallet, reference: refund, referenceAlreadyReversed: false, now });
    expect(rollback.status).toBe('PROCESSED');
    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('reversing a credit without funds has its own failure code', () => {
    const wallet = walletWith('0.00');
    const win = processed('WIN', '25.00', wallet);
    processed('BET', '20.00', wallet);
    const rollback = tx('ROLLBACK', '25.00', { reference: win.externalId });
    const result = processWager({ transaction: rollback, wallet, reference: win, referenceAlreadyReversed: false, now });
    expect(result).toEqual({ type: 'REJECTED', code: 'INSUFFICIENT_FUNDS_FOR_REVERSAL' });
    expect(wallet.balance.toString()).toBe('5.00');
  });

  test('missing reference parks the transaction', () => {
    const wallet = walletWith('10.00');
    const refund = tx('REFUND', '10.00', { reference: 'unknown' });
    const result = processWager({ transaction: refund, wallet, reference: null, referenceAlreadyReversed: false, now });
    expect(result.type).toBe('AWAITING_REFERENCE');
    expect(refund.status).toBe('PENDING');
  });

  const rejectionCases: Array<[string, () => { wallet: Wallet; reversal: WagerTransaction; reference: WagerTransaction; reversed?: boolean }, string]> = [
    [
      'REFUND targeting a WIN',
      () => {
        const wallet = walletWith('0.00');
        const win = processed('WIN', '5.00', wallet);
        return { wallet, reference: win, reversal: tx('REFUND', '5.00', { reference: win.externalId }) };
      },
      'INVALID_REFERENCE_TYPE',
    ],
    [
      'different amount',
      () => {
        const wallet = walletWith('10.00');
        const bet = processed('BET', '5.00', wallet);
        return { wallet, reference: bet, reversal: tx('REFUND', '4.99', { reference: bet.externalId }) };
      },
      'AMOUNT_MISMATCH',
    ],
    [
      'different round',
      () => {
        const wallet = walletWith('10.00');
        const bet = processed('BET', '5.00', wallet);
        return { wallet, reference: bet, reversal: tx('REFUND', '5.00', { reference: bet.externalId, roundId: 'r2' }) };
      },
      'REFERENCE_MISMATCH',
    ],
    [
      'reference from another wallet',
      () => {
        const other = walletWith('10.00', 'p2');
        const bet = tx('BET', '5.00', { playerId: 'p2' });
        processWager({ transaction: bet, wallet: other, reference: null, referenceAlreadyReversed: false, now });
        const wallet = walletWith('10.00');
        return { wallet, reference: bet, reversal: tx('REFUND', '5.00', { reference: bet.externalId }) };
      },
      'REFERENCE_MISMATCH',
    ],
    [
      'already reversed',
      () => {
        const wallet = walletWith('10.00');
        const bet = processed('BET', '5.00', wallet);
        return { wallet, reference: bet, reversal: tx('ROLLBACK', '5.00', { reference: bet.externalId }), reversed: true };
      },
      'ALREADY_REVERSED',
    ],
    [
      'reference was rejected',
      () => {
        const wallet = walletWith('1.00');
        const bet = tx('BET', '5.00');
        processWager({ transaction: bet, wallet, reference: null, referenceAlreadyReversed: false, now });
        return { wallet, reference: bet, reversal: tx('REFUND', '5.00', { reference: bet.externalId }) };
      },
      'REFERENCE_NOT_PROCESSED',
    ],
  ];

  test.each(rejectionCases)('rejects %s', (_name, build, code) => {
    const { wallet, reversal, reference, reversed } = build();
    const before = wallet.balance.toString();
    const result = processWager({ transaction: reversal, wallet, reference, referenceAlreadyReversed: reversed ?? false, now });
    expect(result).toEqual({ type: 'REJECTED', code: code as never });
    expect(reversal.failureCode).toBe(code as never);
    expect(wallet.balance.toString()).toBe(before);
  });
});

describe('WagerTransaction lifecycle', () => {
  test('terminal statuses are final', () => {
    const wallet = walletWith('10.00');
    const bet = processed('BET', '5.00', wallet);
    expect(() => bet.reject({ code: 'INSUFFICIENT_FUNDS', reason: 'x', walletId: wallet.id, now })).toThrow(InvariantViolationError);
  });

  test('reversals require a reference and others must not have one', () => {
    expect(() => tx('REFUND', '1.00')).toThrow(InvariantViolationError);
    expect(() => tx('BET', '1.00', { reference: 'x' })).toThrow(InvariantViolationError);
  });

  test('LOSS must be zero and other kinds positive', () => {
    expect(() => tx('LOSS', '1.00')).toThrow(InvariantViolationError);
    expect(() => tx('BET', '0.00')).toThrow(InvariantViolationError);
  });

  test('pending reference can expire into FAILED', () => {
    const refund = tx('REFUND', '1.00', { reference: 'x' });
    refund.awaitReference({ walletId: 'w', nextRetryAt: now, expiresAt: now, now });
    refund.fail({ code: 'REFERENCE_NOT_FOUND', reason: 'expired', now });
    expect(refund.status).toBe('FAILED');
    expect(refund.isTerminal()).toBe(true);
  });
});

describe('events', () => {
  test('balance change event only when the balance changed', () => {
    const wallet = walletWith('10.00');
    const loss = tx('LOSS', '0.00');
    const lossResult = processWager({ transaction: loss, wallet, reference: null, referenceAlreadyReversed: false, now });
    const lossEvents = eventsFor(loss, wallet, lossResult.type === 'PROCESSED' ? lossResult.ledgerEntry : null, now);
    expect(lossEvents.map((e) => e.eventType)).toEqual(['WagerTransactionProcessed']);

    const bet = tx('BET', '1.00');
    const betResult = processWager({ transaction: bet, wallet, reference: null, referenceAlreadyReversed: false, now });
    const betEvents = eventsFor(bet, wallet, betResult.type === 'PROCESSED' ? betResult.ledgerEntry : null, now);
    expect(betEvents.map((e) => e.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const envelope = betEvents[1]!.toEnvelope('corr-1');
    expect(envelope).toMatchObject({
      eventType: 'WalletBalanceChanged',
      aggregateType: 'Wallet',
      correlationId: 'corr-1',
      payload: { amount: '1.00', balanceBefore: '10.00', balanceAfter: '9.00', direction: 'DEBIT', version: 2 },
    });
  });

  test('rejections emit WagerTransactionRejected with the failure code', () => {
    const wallet = walletWith('0.00');
    const bet = tx('BET', '1.00');
    processWager({ transaction: bet, wallet, reference: null, referenceAlreadyReversed: false, now });
    const [event] = eventsFor(bet, wallet, null, now);
    expect(event?.toEnvelope(null)).toMatchObject({
      eventType: 'WagerTransactionRejected',
      payload: { failureCode: 'INSUFFICIENT_FUNDS', amount: '1.00', status: 'REJECTED' },
    });
  });
});
