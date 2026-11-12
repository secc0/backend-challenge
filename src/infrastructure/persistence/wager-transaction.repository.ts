import type { FailureCode } from '../../domain/failure-codes';
import { WagerTransaction, type WagerKind, type WagerStatus } from '../../domain/wager-transaction';
import type { Row, SqlExecutor } from '../database/database';
import { toDate, toDateOrNull, toInt, toMoney, toMoneyOrNull } from './row-mapping';

const COLUMNS = `id, idempotency_key, payload_hash, provider, external_id, player_id, currency, wallet_id, round_id, kind,
  amount::text AS amount, reference_external_id, reference_transaction_id, status, failure_code, failure_reason,
  balance_after::text AS balance_after, reference_attempts, next_reference_retry_at, reference_expires_at,
  created_at, updated_at, processed_at`;

export class WagerTransactionRepository {
  async insert(sql: SqlExecutor, tx: WagerTransaction): Promise<void> {
    await sql.query(
      `INSERT INTO wager_transactions (
         id, idempotency_key, payload_hash, provider, external_id, player_id, currency, wallet_id, round_id, kind,
         amount, reference_external_id, reference_transaction_id, status, failure_code, failure_reason, balance_after,
         reference_attempts, next_reference_retry_at, reference_expires_at, created_at, updated_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS numeric), ?, ?, ?, ?, ?, CAST(? AS numeric), ?, ?, ?, ?, ?, ?)`,
      [
        tx.id,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.provider,
        tx.externalId,
        tx.playerId,
        tx.currency,
        tx.walletId,
        tx.roundId,
        tx.kind,
        tx.amount.toString(),
        tx.referenceExternalId,
        tx.referenceTransactionId,
        tx.status,
        tx.failureCode,
        tx.failureReason,
        tx.balanceAfter?.toString() ?? null,
        tx.referenceAttempts,
        tx.nextReferenceRetryAt,
        tx.referenceExpiresAt,
        tx.createdAt,
        tx.updatedAt,
        tx.processedAt,
      ],
    );
  }

  /** Persists a state transition of a non-final transaction (the DB trigger rejects anything else). */
  async updateState(sql: SqlExecutor, tx: WagerTransaction): Promise<void> {
    const rows = await sql.query(
      `UPDATE wager_transactions SET
         wallet_id = ?, reference_transaction_id = ?, status = ?, failure_code = ?, failure_reason = ?,
         balance_after = CAST(? AS numeric), reference_attempts = ?, next_reference_retry_at = ?,
         reference_expires_at = ?, updated_at = ?, processed_at = ?
       WHERE id = ? AND status IN ('PENDING', 'PENDING_REFERENCE')
       RETURNING id`,
      [
        tx.walletId,
        tx.referenceTransactionId,
        tx.status,
        tx.failureCode,
        tx.failureReason,
        tx.balanceAfter?.toString() ?? null,
        tx.referenceAttempts,
        tx.nextReferenceRetryAt,
        tx.referenceExpiresAt,
        tx.updatedAt,
        tx.processedAt,
        tx.id,
      ],
    );
    if (rows.length !== 1) throw new Error(`Transaction ${tx.id} is not in an updatable state`);
  }

  async findById(sql: SqlExecutor, id: string, options: { forUpdate?: boolean } = {}): Promise<WagerTransaction | null> {
    const rows = await sql.query(
      `SELECT ${COLUMNS} FROM wager_transactions WHERE id = ? ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? mapTransaction(rows[0]) : null;
  }

  async findByIdempotencyKey(sql: SqlExecutor, key: string): Promise<WagerTransaction | null> {
    const rows = await sql.query(`SELECT ${COLUMNS} FROM wager_transactions WHERE idempotency_key = ?`, [key]);
    return rows[0] ? mapTransaction(rows[0]) : null;
  }

  async findByProviderExternalId(sql: SqlExecutor, provider: string, externalId: string): Promise<WagerTransaction | null> {
    const rows = await sql.query(
      `SELECT ${COLUMNS} FROM wager_transactions WHERE provider = ? AND external_id = ?`,
      [provider, externalId],
    );
    return rows[0] ? mapTransaction(rows[0]) : null;
  }

  /** True when the original already has a PROCESSED REFUND/ROLLBACK pointing to it. */
  async hasProcessedReversal(sql: SqlExecutor, referenceTransactionId: string): Promise<boolean> {
    const rows = await sql.query(
      `SELECT 1 FROM wager_transactions WHERE reference_transaction_id = ? AND status = 'PROCESSED' LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  /**
   * When an original transaction arrives, transactions waiting for it are
   * rescheduled for immediate resolution by the pending-reference worker.
   */
  async wakeTransactionsWaitingFor(sql: SqlExecutor, provider: string, externalId: string, now: Date): Promise<number> {
    const rows = await sql.query(
      `UPDATE wager_transactions SET next_reference_retry_at = ?
       WHERE status = 'PENDING_REFERENCE' AND provider = ? AND reference_external_id = ?
       RETURNING id`,
      [now, provider, externalId],
    );
    return rows.length;
  }

  /**
   * Claims due PENDING_REFERENCE transactions by pushing their retry time a
   * lease into the future. SKIP LOCKED lets several worker instances share the
   * work without blocking each other; if a worker dies the lease expires and
   * another instance picks the transaction up.
   */
  async claimDuePendingReferences(sql: SqlExecutor, now: Date, limit: number, leaseMs: number): Promise<string[]> {
    const rows = await sql.query(
      `UPDATE wager_transactions SET next_reference_retry_at = ?
       WHERE id IN (
         SELECT id FROM wager_transactions
         WHERE status = 'PENDING_REFERENCE' AND next_reference_retry_at <= ?
         ORDER BY next_reference_retry_at
         LIMIT ?
         FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [new Date(now.getTime() + leaseMs), now, limit],
    );
    return rows.map((row) => String(row.id));
  }

  async countByStatus(sql: SqlExecutor): Promise<Record<string, number>> {
    const rows = await sql.query(`SELECT status, count(*)::text AS total FROM wager_transactions GROUP BY status`);
    return Object.fromEntries(rows.map((row) => [String(row.status), toInt(row.total)]));
  }
}

export function mapTransaction(row: Row): WagerTransaction {
  const currency = String(row.currency).trim();
  return WagerTransaction.rehydrate({
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    payloadHash: String(row.payload_hash).trim(),
    provider: String(row.provider),
    externalId: String(row.external_id),
    playerId: String(row.player_id),
    currency,
    walletId: (row.wallet_id as string | null) ?? null,
    roundId: (row.round_id as string | null) ?? null,
    kind: row.kind as WagerKind,
    amount: toMoney(row.amount, currency),
    referenceExternalId: (row.reference_external_id as string | null) ?? null,
    referenceTransactionId: (row.reference_transaction_id as string | null) ?? null,
    status: row.status as WagerStatus,
    failureCode: (row.failure_code as FailureCode | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    balanceAfter: toMoneyOrNull(row.balance_after, currency),
    referenceAttempts: toInt(row.reference_attempts),
    nextReferenceRetryAt: toDateOrNull(row.next_reference_retry_at),
    referenceExpiresAt: toDateOrNull(row.reference_expires_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    processedAt: toDateOrNull(row.processed_at),
  });
}
