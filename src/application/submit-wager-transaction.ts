import { Money } from '../domain/money';
import { FailureCode } from '../domain/failure-codes';
import { WagerTransaction } from '../domain/wager-transaction';
import type { Database, SqlExecutor } from '../infrastructure/database/database';
import { isUniqueViolation, transientKind } from '../infrastructure/database/db-errors';
import type { JsonLogger } from '../infrastructure/observability/logger';
import type { Metrics } from '../infrastructure/observability/metrics';
import type { InboxRepository } from '../infrastructure/persistence/inbox.repository';
import type { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository';
import type { WalletRepository } from '../infrastructure/persistence/wallet.repository';
import { payloadHash } from './canonical-json';
import type { SubmitWagerCommand } from './commands';
import { IdempotencyConflictError, TransientError } from './errors';
import type { WagerEngine } from './wager-engine';

export type Channel = 'http' | 'sqs';

export interface SubmitContext {
  channel: Channel;
  correlationId: string | null;
  /** Present when the command comes from a queue: recorded in the inbox atomically. */
  inbox?: { consumer: string; messageId: string };
  /** Test hook: runs inside the SQL transaction right before commit. */
  beforeCommit?: () => Promise<void> | void;
}

export interface SubmitResult {
  transaction: WagerTransaction;
  /** True when the answer comes from an earlier, already committed execution. */
  replayed: boolean;
}

/** Constraints whose violation means "a concurrent duplicate won the race": retry and replay. */
const DUPLICATE_CONSTRAINTS = ['wager_tx_idempotency_key_uq', 'wager_tx_provider_external_uq', 'inbox_messages_pkey'];
const MAX_ATTEMPTS = 3;

/**
 * Use case shared by the HTTP API and the SQS consumer.
 *
 * Everything happens in ONE SQL transaction: inbox record, transaction row,
 * wallet balance, ledger entry and outbox events. Either all of it commits or
 * nothing does.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly db: Database,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly inbox: InboxRepository,
    private readonly engine: WagerEngine,
    private readonly metrics: Metrics,
    private readonly logger: JsonLogger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(command: SubmitWagerCommand, context: SubmitContext): Promise<SubmitResult> {
    const stopTimer = this.metrics.processingDuration.startTimer({ channel: context.channel });
    const hash = hashOf(command);
    try {
      const result = await this.withRetries(() =>
        this.db.transaction(async (sql) => {
          const outcome = await this.run(sql, command, hash, context);
          await context.beforeCommit?.();
          return outcome;
        }),
      );
      this.record(result, context);
      return result;
    } finally {
      stopTimer();
    }
  }

  private async run(sql: SqlExecutor, cmd: SubmitWagerCommand, hash: string, ctx: SubmitContext): Promise<SubmitResult> {
    if (ctx.inbox) {
      const firstDelivery = await this.inbox.tryRecord(sql, ctx.inbox.consumer, ctx.inbox.messageId);
      if (!firstDelivery) {
        this.metrics.duplicates.inc({ channel: ctx.channel, source: 'inbox' });
        const existing = await this.findExisting(sql, cmd);
        if (!existing) throw new Error(`Inbox has message ${ctx.inbox.messageId} but no transaction was found`);
        return this.replay(existing, hash, ctx);
      }
    }

    // Fast path: a committed duplicate is answered without touching the wallet.
    const existing = await this.findExisting(sql, cmd);
    if (existing) return this.replay(existing, hash, ctx);

    const now = this.clock();
    const transaction = WagerTransaction.create({
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: hash,
      provider: cmd.provider,
      externalId: cmd.externalId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      kind: cmd.type,
      amount: Money.of(cmd.amount, cmd.currency),
      referenceExternalId: cmd.referenceExternalId ?? null,
      now,
    });

    const wallet = await this.wallets.lockByPlayerAndCurrency(sql, cmd.playerId, cmd.currency);
    if (!wallet) {
      transaction.reject({ code: FailureCode.WALLET_NOT_FOUND, reason: 'No wallet for player and currency', walletId: null, now });
      await this.engine.persistWithoutWallet(sql, transaction, now, ctx.correlationId);
      await this.attachInbox(sql, ctx, transaction.id);
      return { transaction, replayed: false };
    }

    // A concurrent duplicate may have committed while we waited for the lock.
    const raced = await this.findExisting(sql, cmd);
    if (raced) return this.replay(raced, hash, ctx);

    await this.engine.apply(sql, { transaction, wallet, isNew: true, now, correlationId: ctx.correlationId });
    await this.attachInbox(sql, ctx, transaction.id);
    return { transaction, replayed: false };
  }

  private async findExisting(sql: SqlExecutor, cmd: SubmitWagerCommand): Promise<WagerTransaction | null> {
    return (
      (await this.transactions.findByIdempotencyKey(sql, cmd.idempotencyKey)) ??
      (await this.transactions.findByProviderExternalId(sql, cmd.provider, cmd.externalId))
    );
  }

  private replay(existing: WagerTransaction, hash: string, ctx: SubmitContext): SubmitResult {
    if (existing.payloadHash !== hash) {
      this.metrics.idempotencyConflicts.inc();
      throw new IdempotencyConflictError(
        'This idempotency key or provider transaction id was already used with a different payload',
        existing.id,
      );
    }
    this.metrics.duplicates.inc({ channel: ctx.channel, source: 'idempotency' });
    return { transaction: existing, replayed: true };
  }

  private async attachInbox(sql: SqlExecutor, ctx: SubmitContext, transactionId: string): Promise<void> {
    if (ctx.inbox) await this.inbox.attachTransaction(sql, ctx.inbox.consumer, ctx.inbox.messageId, transactionId);
  }

  /**
   * Retries the whole unit of work on races and transient lock problems.
   * A unique violation on the idempotency constraints means a concurrent
   * duplicate committed first: the retry will find it and replay it.
   */
  private async withRetries<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        const duplicateRace = isUniqueViolation(error, DUPLICATE_CONSTRAINTS);
        const kind = transientKind(error);
        if (duplicateRace) this.metrics.lockConflicts.inc({ kind: 'duplicate_race' });
        else if (kind) this.metrics.lockConflicts.inc({ kind });

        const retryable = duplicateRace || kind === 'deadlock' || kind === 'serialization';
        if (retryable && attempt < MAX_ATTEMPTS) {
          this.logger.warn('retrying wager transaction', { attempt, reason: duplicateRace ? 'duplicate_race' : kind });
          await sleep(10 * attempt + Math.random() * 20);
          continue;
        }
        if (kind) throw new TransientError('Temporary infrastructure failure, retry later', kind, error);
        throw error;
      }
    }
  }

  private record(result: SubmitResult, ctx: SubmitContext): void {
    if (result.replayed) return;
    const tx = result.transaction;
    this.metrics.transactions.inc({ type: tx.kind, status: tx.status, channel: ctx.channel });
    if (tx.failureCode) this.metrics.rejections.inc({ failure_code: tx.failureCode });
    this.logger.info('wager transaction handled', {
      transactionId: tx.id,
      provider: tx.provider,
      externalId: tx.externalId,
      type: tx.kind,
      status: tx.status,
      failureCode: tx.failureCode ?? undefined,
      walletId: tx.walletId ?? undefined,
      channel: ctx.channel,
    });
  }
}

/**
 * The idempotency fingerprint: canonical JSON of the business payload (the
 * idempotency key itself excluded), with the amount normalized so "10.5" and
 * "10.50" are the same request.
 */
export function hashOf(cmd: SubmitWagerCommand): string {
  return payloadHash({
    provider: cmd.provider,
    externalId: cmd.externalId,
    playerId: cmd.playerId,
    currency: cmd.currency,
    roundId: cmd.roundId,
    type: cmd.type,
    amount: Money.of(cmd.amount, cmd.currency).toString(),
    referenceExternalId: cmd.referenceExternalId,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
