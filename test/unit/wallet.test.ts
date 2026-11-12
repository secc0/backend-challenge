import { describe, expect, test } from 'bun:test';
import { InsufficientFundsError, InvariantViolationError, UnsupportedCurrencyError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const now = new Date('2026-01-01T00:00:00Z');
const brl = (amount: string) => Money.of(amount, 'BRL');

describe('Wallet', () => {
  test('starts empty at version 0', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL', now });
    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(0);
    expect(wallet.hasChanges()).toBe(false);
  });

  test('every balance change produces one ledger entry and bumps the version', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL', now });
    const credit = wallet.credit(brl('100.00'), 'tx-1', now);
    const debit = wallet.debit(brl('30.00'), 'tx-2', now);

    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(wallet.persistedVersion).toBe(0);
    expect(wallet.pendingLedgerEntries()).toHaveLength(2);
    expect(credit.sequence).toBe(1);
    expect(credit.balanceBefore.toString()).toBe('0.00');
    expect(credit.balanceAfter.toString()).toBe('100.00');
    expect(debit.sequence).toBe(2);
    expect(debit.direction).toBe('DEBIT');
    expect(debit.balanceAfter.toString()).toBe('70.00');
  });

  test('never goes negative', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL', now });
    wallet.credit(brl('10.00'), 'tx-1', now);
    expect(wallet.canDebit(brl('10.01'))).toBe(false);
    expect(() => wallet.debit(brl('10.01'), 'tx-2', now)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('allows spending the exact balance', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL', now });
    wallet.credit(brl('10.00'), 'tx-1', now);
    wallet.debit(brl('10.00'), 'tx-2', now);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('rejects zero-amount balance changes (they would create empty ledger entries)', () => {
    const wallet = Wallet.create({ playerId: 'p1', currency: 'BRL', now });
    expect(() => wallet.credit(brl('0.00'), 'tx-1', now)).toThrow(InvariantViolationError);
  });

  test('only supported currencies', () => {
    expect(() => Wallet.create({ playerId: 'p1', currency: 'USD', now })).toThrow(UnsupportedCurrencyError);
  });

  test('rehydrated wallets remember the persisted version for compare-and-set', () => {
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: 'p1',
      currency: 'BRL',
      balance: brl('50.00'),
      version: 7,
      createdAt: now,
      updatedAt: now,
    });
    wallet.debit(brl('5.00'), 'tx', now);
    expect(wallet.persistedVersion).toBe(7);
    expect(wallet.version).toBe(8);
  });
});
