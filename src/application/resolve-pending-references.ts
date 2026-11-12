import type { Database } from '../infrastructure/database/database';
import type { JsonLogger } from '../infrastructure/observability/logger';
import type { Metrics } from '../infrastructure/observability/metrics';
import type { WagerTransactionRepository } from '../infrastructure/persistence/wager-transaction.repository';
import type { WalletRepository } from '../infrastructure/persistence/wallet.repository';
import type { WagerEngine } from './wager-engine';

const CLAIM_LEASE_MS = 30_000;

/**
 * Retries REFUND / ROLLBACK transactions whose original had not arrived yet.
 *
 * Lock order is the same as the submission path (wallet row first, then the
 * transaction row), so the two can never deadlock each other.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly db: Database,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly engine: WagerEngine,
    private readonly metrics: Metrics,
    private readonly logger: JsonLogger,
    private readonly batchSize: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Processes one batch of due transactions; returns how many were examined. */
  async runOnce(): Promise<number> {
    const ids = await this.db.transaction((sql) =>
      this.transactions.claimDuePendingReferences(sql, this.clock(), this.batchSize, CLAIM_LEASE_MS),
    );
    for (const id of ids) {
      try {
        await this.resolve(id);
      } catch (error) {
        this.metrics.pendingReferenceResolutions.inc({ result: 'error' });
        this.logger.error('pending reference resolution failed', { transactionId: id }, error as Error);
      }
    }
    return ids.length;
  }

  private async resolve(id: string): Promise<void> {
    const status = await this.db.transaction(async (sql) => {
      const snapshot = await this.transactions.findById(sql, id);
      if (!snapshot || snapshot.status !== 'PENDING_REFERENCE') return 'skipped';

      const wallet = await this.wallets.lockByPlayerAndCurrency(sql, snapshot.playerId, snapshot.currency);
      const tx = await this.transactions.findById(sql, id, { forUpdate: true });
      if (!wallet || !tx || tx.status !== 'PENDING_REFERENCE') return 'skipped';

      const now = this.clock();
      await this.engine.apply(sql, { transaction: tx, wallet, isNew: false, now, correlationId: `pending-reference:${id}` });
      return tx.status;
    });

    const result = status === 'PENDING_REFERENCE' ? 'still_pending' : status.toLowerCase();
    this.metrics.pendingReferenceResolutions.inc({ result });
    if (status !== 'skipped' && status !== 'PENDING_REFERENCE') {
      this.logger.info('pending reference resolved', { transactionId: id, status });
    }
  }
}
