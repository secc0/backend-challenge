import { randomUUID } from 'node:crypto';
import type { LedgerEntry } from './ledger-entry';
import type { WagerTransaction } from './wager-transaction';
import type { Wallet } from './wallet';

export interface EventEnvelope<TPayload = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  correlationId: string | null;
  payload: TPayload;
}

/**
 * Base for every integration event. Subclasses only define their type and
 * payload; the envelope (ids, timestamps, versioning) is uniform. Money is
 * always serialized as decimal strings.
 */
export abstract class DomainEvent<TPayload extends object = Record<string, unknown>> {
  readonly eventId: string = randomUUID();
  abstract readonly eventType: string;
  readonly eventVersion: number = 1;
  abstract readonly aggregateType: string;

  protected constructor(
    readonly aggregateId: string,
    readonly occurredAt: Date,
  ) {}

  abstract payload(): TPayload;

  toEnvelope(correlationId: string | null): EventEnvelope<TPayload> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      eventVersion: this.eventVersion,
      aggregateType: this.aggregateType,
      aggregateId: this.aggregateId,
      occurredAt: this.occurredAt.toISOString(),
      correlationId,
      payload: this.payload(),
    };
  }
}

interface TransactionPayload {
  transactionId: string;
  provider: string;
  externalId: string;
  type: string;
  status: string;
  playerId: string;
  walletId: string | null;
  roundId: string | null;
  amount: string;
  currency: string;
  referenceExternalId: string | null;
  referenceTransactionId: string | null;
}

function transactionPayload(tx: WagerTransaction): TransactionPayload {
  return {
    transactionId: tx.id,
    provider: tx.provider,
    externalId: tx.externalId,
    type: tx.kind,
    status: tx.status,
    playerId: tx.playerId,
    walletId: tx.walletId,
    roundId: tx.roundId,
    amount: tx.amount.toString(),
    currency: tx.currency,
    referenceExternalId: tx.referenceExternalId,
    referenceTransactionId: tx.referenceTransactionId,
  };
}

abstract class WagerTransactionEvent<P extends object> extends DomainEvent<P> {
  readonly aggregateType = 'WagerTransaction';

  protected constructor(protected readonly tx: WagerTransaction, occurredAt: Date) {
    super(tx.id, occurredAt);
  }
}

export class WagerTransactionProcessed extends WagerTransactionEvent<TransactionPayload & { balanceAfter: string | null }> {
  readonly eventType = 'WagerTransactionProcessed';

  constructor(tx: WagerTransaction, occurredAt: Date) {
    super(tx, occurredAt);
  }

  payload() {
    return { ...transactionPayload(this.tx), balanceAfter: this.tx.balanceAfter?.toString() ?? null };
  }
}

/** Emitted for REJECTED and FAILED transactions; `status` tells them apart. */
export class WagerTransactionRejected extends WagerTransactionEvent<
  TransactionPayload & { failureCode: string | null; failureReason: string | null }
> {
  readonly eventType = 'WagerTransactionRejected';

  constructor(tx: WagerTransaction, occurredAt: Date) {
    super(tx, occurredAt);
  }

  payload() {
    return {
      ...transactionPayload(this.tx),
      failureCode: this.tx.failureCode,
      failureReason: this.tx.failureReason,
    };
  }
}

export class WagerTransactionPendingReference extends WagerTransactionEvent<
  TransactionPayload & { referenceExpiresAt: string | null }
> {
  readonly eventType = 'WagerTransactionPendingReference';

  constructor(tx: WagerTransaction, occurredAt: Date) {
    super(tx, occurredAt);
  }

  payload() {
    return { ...transactionPayload(this.tx), referenceExpiresAt: this.tx.referenceExpiresAt?.toISOString() ?? null };
  }
}

/** Emitted only when a balance actually changes (one per ledger entry). */
export class WalletBalanceChanged extends DomainEvent<{
  walletId: string;
  playerId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  version: number;
}> {
  readonly eventType = 'WalletBalanceChanged';
  readonly aggregateType = 'Wallet';

  constructor(
    private readonly wallet: Wallet,
    private readonly entry: LedgerEntry,
    occurredAt: Date,
  ) {
    super(wallet.id, occurredAt);
  }

  payload() {
    return {
      walletId: this.wallet.id,
      playerId: this.wallet.playerId,
      transactionId: this.entry.transactionId,
      direction: this.entry.direction,
      amount: this.entry.amount.toString(),
      currency: this.entry.amount.currency,
      balanceBefore: this.entry.balanceBefore.toString(),
      balanceAfter: this.entry.balanceAfter.toString(),
      version: this.entry.sequence,
    };
  }
}

/** Builds the events that describe the final state of a processed transaction. */
export function eventsFor(tx: WagerTransaction, wallet: Wallet | null, entry: LedgerEntry | null, now: Date): DomainEvent[] {
  const events: DomainEvent[] = [];
  switch (tx.status) {
    case 'PROCESSED':
      events.push(new WagerTransactionProcessed(tx, now));
      if (entry && wallet) events.push(new WalletBalanceChanged(wallet, entry, now));
      break;
    case 'REJECTED':
    case 'FAILED':
      events.push(new WagerTransactionRejected(tx, now));
      break;
    case 'PENDING_REFERENCE':
      events.push(new WagerTransactionPendingReference(tx, now));
      break;
    case 'PENDING':
      break;
  }
  return events;
}
