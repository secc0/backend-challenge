import { Money } from './money';
import { InvariantViolationError } from './errors';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

export interface LedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  /** Equals the wallet version produced by this entry; strictly increasing per wallet. */
  sequence: number;
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/** Immutable record of a single balance change. Never updated nor deleted. */
export class LedgerEntry {
  private constructor(private readonly props: LedgerEntryProps) {
    Object.freeze(this);
  }

  static create(props: LedgerEntryProps): LedgerEntry {
    if (!props.amount.isPositive()) {
      throw new InvariantViolationError('Ledger amount must be positive');
    }
    const expected =
      props.direction === 'CREDIT'
        ? props.balanceBefore.add(props.amount)
        : props.balanceBefore.subtract(props.amount);
    if (!expected.equals(props.balanceAfter)) {
      throw new InvariantViolationError('Ledger entry balances do not add up');
    }
    return new LedgerEntry({ ...props });
  }

  static rehydrate(props: LedgerEntryProps): LedgerEntry {
    return new LedgerEntry({ ...props });
  }

  get id(): string { return this.props.id; }
  get walletId(): string { return this.props.walletId; }
  get transactionId(): string { return this.props.transactionId; }
  get sequence(): number { return this.props.sequence; }
  get direction(): LedgerDirection { return this.props.direction; }
  get amount(): Money { return this.props.amount; }
  get balanceBefore(): Money { return this.props.balanceBefore; }
  get balanceAfter(): Money { return this.props.balanceAfter; }
  get createdAt(): Date { return this.props.createdAt; }
}
