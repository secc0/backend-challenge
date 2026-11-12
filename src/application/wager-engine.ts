import type { AppConfig } from '../config';
import { eventsFor } from '../domain/events';
import type { LedgerEntry } from '../domain/ledger-entry';
import { processWager } from '../domain/wager-processor';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { SqlExecutor } from '../infrastructure/database/database';
import type { OutboxRepository } from '../infrastructure/persistence/outbox.repository';
import type { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository';
import type { WalletRepository } from '../infrastructure/persistence/wallet.repository';

export interface EngineResult {
  transaction: WagerTransaction;
  ledgerEntry: LedgerEntry | null;
}

/**
 * Applies the business rules to a transaction whose wallet is already locked
 * and persists everything (transaction, wallet, ledger, outbox) through the
 * given SQL executor, i.e. inside the caller's single SQL transaction.
 *
 * Shared by the submission use case (new transactions) and the
 * pending-reference worker (transactions waiting for their original).
 */
export class WagerEngine {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly outbox: OutboxRepository,
    private readonly settings: AppConfig['pendingReference'],
  ) {}

  async apply(
    sql: SqlExecutor,
    params: { transaction: WagerTransaction; wallet: Wallet; isNew: boolean; now: Date; correlationId: string | null },
  ): Promise<EngineResult> {
    const { transaction: tx, wallet, isNew, now } = params;

    let reference: WagerTransaction | null = null;
    let alreadyReversed = false;
    if (tx.isReversal() && tx.referenceExternalId) {
      reference = await this.transactions.findByProviderExternalId(sql, tx.provider, tx.referenceExternalId);
      if (reference) alreadyReversed = await this.transactions.hasProcessedReversal(sql, reference.id);
    }

    const outcome = processWager({ transaction: tx, wallet, reference, referenceAlreadyReversed: alreadyReversed, now });

    let emitEvents = true;
    if (outcome.type === 'AWAITING_REFERENCE') {
      if (isNew) {
        tx.awaitReference({
          walletId: wallet.id,
          nextRetryAt: new Date(now.getTime() + this.settings.initialBackoffMs),
          expiresAt: new Date(now.getTime() + this.settings.ttlMs),
          now,
        });
      } else {
        emitEvents = this.scheduleOrFail(tx, now);
      }
    }

    // Order matters: the ledger row references the transaction row.
    if (isNew) await this.transactions.insert(sql, tx);
    else await this.transactions.updateState(sql, tx);
    await this.wallets.saveChanges(sql, wallet);

    if (tx.status === 'PROCESSED') {
      // Reversals that arrived before this transaction can now be resolved.
      await this.transactions.wakeTransactionsWaitingFor(sql, tx.provider, tx.externalId, now);
    }

    const ledgerEntry = outcome.type === 'PROCESSED' ? outcome.ledgerEntry : null;
    if (emitEvents) {
      await this.outbox.append(sql, eventsFor(tx, wallet, ledgerEntry, now), params.correlationId);
    }
    return { transaction: tx, ledgerEntry };
  }

  /** Records a WALLET_NOT_FOUND rejection (no wallet to lock). */
  async persistWithoutWallet(sql: SqlExecutor, tx: WagerTransaction, now: Date, correlationId: string | null): Promise<void> {
    await this.transactions.insert(sql, tx);
    await this.outbox.append(sql, eventsFor(tx, null, null, now), correlationId);
  }

  /**
   * The reference is still missing: retry later with exponential backoff, or
   * give up once the TTL or the attempt budget is exhausted.
   * Returns whether the new state must be announced through an event.
   */
  private scheduleOrFail(tx: WagerTransaction, now: Date): boolean {
    const attempts = tx.referenceAttempts + 1;
    const expired = tx.referenceExpiresAt !== null && now.getTime() >= tx.referenceExpiresAt.getTime();
    if (expired || attempts >= this.settings.maxAttempts) {
      tx.fail({
        code: 'REFERENCE_NOT_FOUND',
        reason: expired ? 'Referenced transaction did not arrive before the deadline' : 'Reference resolution attempts exhausted',
        now,
      });
      return true;
    }
    const backoff = Math.min(this.settings.initialBackoffMs * 2 ** attempts, this.settings.maxBackoffMs);
    let next = now.getTime() + backoff;
    if (tx.referenceExpiresAt) next = Math.min(next, tx.referenceExpiresAt.getTime());
    tx.scheduleReferenceRetry({ nextRetryAt: new Date(next), now });
    return false;
  }
}
