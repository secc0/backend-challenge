import { randomUUID } from 'node:crypto';
import { InvariantViolationError } from './errors';
import type { FailureCode } from './failure-codes';
import { Money } from './money';

export const WAGER_KINDS = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerKind = (typeof WAGER_KINDS)[number];

/** Kinds that a provider may submit (OPENING is internal only). */
export const PROVIDER_WAGER_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type ProviderWagerKind = (typeof PROVIDER_WAGER_KINDS)[number];

export const WAGER_STATUSES = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] as const;
export type WagerStatus = (typeof WAGER_STATUSES)[number];

export const TERMINAL_STATUSES: readonly WagerStatus[] = ['PROCESSED', 'REJECTED', 'FAILED'];

export const REVERSAL_KINDS: readonly WagerKind[] = ['REFUND', 'ROLLBACK'];

/** Which original kinds each reversal kind may target. */
export const REVERSIBLE_TARGETS: Record<'REFUND' | 'ROLLBACK', readonly WagerKind[]> = {
  REFUND: ['BET'],
  ROLLBACK: ['BET', 'WIN', 'REFUND'],
};

export interface WagerTransactionProps {
  id: string;
  idempotencyKey: string;
  payloadHash: string;
  provider: string;
  externalId: string;
  playerId: string;
  currency: string;
  walletId: string | null;
  roundId: string | null;
  kind: WagerKind;
  amount: Money;
  referenceExternalId: string | null;
  referenceTransactionId: string | null;
  status: WagerStatus;
  failureCode: FailureCode | null;
  failureReason: string | null;
  balanceAfter: Money | null;
  referenceAttempts: number;
  nextReferenceRetryAt: Date | null;
  referenceExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}

export interface CreateWagerTransactionParams {
  idempotencyKey: string;
  payloadHash: string;
  provider: string;
  externalId: string;
  playerId: string;
  roundId: string | null;
  kind: WagerKind;
  amount: Money;
  referenceExternalId?: string | null;
  now: Date;
  id?: string;
}

/**
 * A financial operation reported by a game provider (or OPENING, created
 * internally together with a wallet). Starts as PENDING and ends in exactly
 * one terminal status. Financial fields never change after creation.
 *
 *   PENDING ──► PROCESSED | REJECTED
 *      └─────► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
 */
export class WagerTransaction {
  private constructor(private props: WagerTransactionProps) {}

  static create(params: CreateWagerTransactionParams): WagerTransaction {
    const isReversal = REVERSAL_KINDS.includes(params.kind);
    if (isReversal && !params.referenceExternalId) {
      throw new InvariantViolationError(`${params.kind} requires a reference`);
    }
    if (!isReversal && params.referenceExternalId) {
      throw new InvariantViolationError(`${params.kind} cannot carry a reference`);
    }
    if (params.kind === 'LOSS') {
      // A LOSS only closes the round; the stake was already debited by the BET.
      if (!params.amount.isZero()) {
        throw new InvariantViolationError('LOSS amount must be zero');
      }
    } else if (!params.amount.isPositive()) {
      throw new InvariantViolationError(`${params.kind} amount must be positive`);
    }
    return new WagerTransaction({
      id: params.id ?? randomUUID(),
      idempotencyKey: params.idempotencyKey,
      payloadHash: params.payloadHash,
      provider: params.provider,
      externalId: params.externalId,
      playerId: params.playerId,
      currency: params.amount.currency,
      walletId: null,
      roundId: params.roundId,
      kind: params.kind,
      amount: params.amount,
      referenceExternalId: params.referenceExternalId ?? null,
      referenceTransactionId: null,
      status: 'PENDING',
      failureCode: null,
      failureReason: null,
      balanceAfter: null,
      referenceAttempts: 0,
      nextReferenceRetryAt: null,
      referenceExpiresAt: null,
      createdAt: params.now,
      updatedAt: params.now,
      processedAt: null,
    });
  }

  static rehydrate(props: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction({ ...props });
  }

  get id(): string { return this.props.id; }
  get idempotencyKey(): string { return this.props.idempotencyKey; }
  get payloadHash(): string { return this.props.payloadHash; }
  get provider(): string { return this.props.provider; }
  get externalId(): string { return this.props.externalId; }
  get playerId(): string { return this.props.playerId; }
  get currency(): string { return this.props.currency; }
  get walletId(): string | null { return this.props.walletId; }
  get roundId(): string | null { return this.props.roundId; }
  get kind(): WagerKind { return this.props.kind; }
  get amount(): Money { return this.props.amount; }
  get referenceExternalId(): string | null { return this.props.referenceExternalId; }
  get referenceTransactionId(): string | null { return this.props.referenceTransactionId; }
  get status(): WagerStatus { return this.props.status; }
  get failureCode(): FailureCode | null { return this.props.failureCode; }
  get failureReason(): string | null { return this.props.failureReason; }
  get balanceAfter(): Money | null { return this.props.balanceAfter; }
  get referenceAttempts(): number { return this.props.referenceAttempts; }
  get nextReferenceRetryAt(): Date | null { return this.props.nextReferenceRetryAt; }
  get referenceExpiresAt(): Date | null { return this.props.referenceExpiresAt; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }
  get processedAt(): Date | null { return this.props.processedAt; }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this.props.status);
  }

  isReversal(): boolean {
    return REVERSAL_KINDS.includes(this.props.kind);
  }

  markProcessed(params: {
    walletId: string;
    balanceAfter: Money;
    referenceTransactionId?: string | null;
    now: Date;
  }): void {
    this.assertOpen();
    this.props = {
      ...this.props,
      status: 'PROCESSED',
      walletId: params.walletId,
      balanceAfter: params.balanceAfter,
      referenceTransactionId: params.referenceTransactionId ?? null,
      nextReferenceRetryAt: null,
      updatedAt: params.now,
      processedAt: params.now,
    };
  }

  reject(params: {
    code: FailureCode;
    reason: string;
    walletId: string | null;
    referenceTransactionId?: string | null;
    now: Date;
  }): void {
    this.assertOpen();
    this.props = {
      ...this.props,
      status: 'REJECTED',
      walletId: params.walletId,
      failureCode: params.code,
      failureReason: params.reason,
      referenceTransactionId: params.referenceTransactionId ?? null,
      nextReferenceRetryAt: null,
      updatedAt: params.now,
      processedAt: params.now,
    };
  }

  /** Permanent failure: the reference never showed up within its TTL / attempt budget. */
  fail(params: { code: FailureCode; reason: string; now: Date }): void {
    if (this.props.status !== 'PENDING_REFERENCE') {
      throw new InvariantViolationError(`Cannot fail a ${this.props.status} transaction`);
    }
    this.props = {
      ...this.props,
      status: 'FAILED',
      failureCode: params.code,
      failureReason: params.reason,
      nextReferenceRetryAt: null,
      updatedAt: params.now,
      processedAt: params.now,
    };
  }

  awaitReference(params: { walletId: string; nextRetryAt: Date; expiresAt: Date; now: Date }): void {
    if (this.props.status !== 'PENDING') {
      throw new InvariantViolationError(`Cannot park a ${this.props.status} transaction`);
    }
    this.props = {
      ...this.props,
      status: 'PENDING_REFERENCE',
      walletId: params.walletId,
      nextReferenceRetryAt: params.nextRetryAt,
      referenceExpiresAt: params.expiresAt,
      updatedAt: params.now,
    };
  }

  scheduleReferenceRetry(params: { nextRetryAt: Date; now: Date }): void {
    if (this.props.status !== 'PENDING_REFERENCE') {
      throw new InvariantViolationError(`Cannot reschedule a ${this.props.status} transaction`);
    }
    this.props = {
      ...this.props,
      referenceAttempts: this.props.referenceAttempts + 1,
      nextReferenceRetryAt: params.nextRetryAt,
      updatedAt: params.now,
    };
  }

  private assertOpen(): void {
    if (this.isTerminal()) {
      throw new InvariantViolationError(`Transaction ${this.props.id} is already ${this.props.status}`);
    }
  }
}
