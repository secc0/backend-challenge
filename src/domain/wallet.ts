import { randomUUID } from 'node:crypto';
import { resolveCurrency } from './currency';
import { CurrencyMismatchError, InsufficientFundsError, InvariantViolationError } from './errors';
import { LedgerEntry, type LedgerDirection } from './ledger-entry';
import { Money } from './money';

export interface WalletProps {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate root. One wallet per (player, currency).
 *
 * Invariants:
 *  - the balance is never negative;
 *  - every balance change produces exactly one LedgerEntry;
 *  - `version` is incremented only when the balance changes, and the ledger
 *    entry sequence equals the new version.
 *
 * The aggregate remembers the version it was loaded with so the repository
 * can perform a compare-and-set update (defence in depth on top of the row lock).
 */
export class Wallet {
  private readonly loadedVersion: number;
  private newEntries: LedgerEntry[] = [];

  private constructor(private props: WalletProps) {
    this.loadedVersion = props.version;
  }

  static create(params: { playerId: string; currency: string; now: Date; id?: string }): Wallet {
    resolveCurrency(params.currency);
    if (!params.playerId.trim()) {
      throw new InvariantViolationError('playerId is required');
    }
    return new Wallet({
      id: params.id ?? randomUUID(),
      playerId: params.playerId,
      currency: params.currency,
      balance: Money.zero(params.currency),
      version: 0,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static rehydrate(props: WalletProps): Wallet {
    if (props.balance.currency !== props.currency) {
      throw new InvariantViolationError('Wallet balance currency mismatch');
    }
    return new Wallet({ ...props });
  }

  get id(): string { return this.props.id; }
  get playerId(): string { return this.props.playerId; }
  get currency(): string { return this.props.currency; }
  get balance(): Money { return this.props.balance; }
  get version(): number { return this.props.version; }
  get persistedVersion(): number { return this.loadedVersion; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }

  canDebit(amount: Money): boolean {
    this.assertCurrency(amount);
    return this.props.balance.isGreaterThanOrEqual(amount);
  }

  credit(amount: Money, transactionId: string, now: Date): LedgerEntry {
    return this.apply('CREDIT', amount, transactionId, now);
  }

  /** @throws InsufficientFundsError when the balance is lower than the amount. */
  debit(amount: Money, transactionId: string, now: Date): LedgerEntry {
    if (!this.canDebit(amount)) {
      throw new InsufficientFundsError('Insufficient funds');
    }
    return this.apply('DEBIT', amount, transactionId, now);
  }

  /** Ledger entries produced since the wallet was loaded (to be persisted). */
  pendingLedgerEntries(): readonly LedgerEntry[] {
    return this.newEntries;
  }

  hasChanges(): boolean {
    return this.newEntries.length > 0;
  }

  private apply(direction: LedgerDirection, amount: Money, transactionId: string, now: Date): LedgerEntry {
    this.assertCurrency(amount);
    if (!amount.isPositive()) {
      throw new InvariantViolationError('Balance changes must have a positive amount');
    }
    const before = this.props.balance;
    const after = direction === 'CREDIT' ? before.add(amount) : before.subtract(amount);
    const version = this.props.version + 1;
    const entry = LedgerEntry.create({
      id: randomUUID(),
      walletId: this.props.id,
      transactionId,
      sequence: version,
      direction,
      amount,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: now,
    });
    this.props = { ...this.props, balance: after, version, updatedAt: now };
    this.newEntries.push(entry);
    return entry;
  }

  private assertCurrency(amount: Money): void {
    if (amount.currency !== this.props.currency) {
      throw new CurrencyMismatchError(`Wallet currency is ${this.props.currency}, got ${amount.currency}`);
    }
  }
}
