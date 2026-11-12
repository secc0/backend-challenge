import { LedgerEntry } from '../../domain/ledger-entry';
import { Wallet } from '../../domain/wallet';
import type { Row, SqlExecutor } from '../database/database';
import { toDate, toInt, toMoney } from './row-mapping';

const WALLET_COLUMNS = `id, player_id, currency, balance::text AS balance, version::text AS version, created_at, updated_at`;
const LEDGER_COLUMNS = `id, wallet_id, transaction_id, sequence::text AS sequence, direction, amount::text AS amount,
  currency, balance_before::text AS balance_before, balance_after::text AS balance_after, created_at`;

/** Thrown when a compare-and-set update finds a different version (should never happen under the row lock). */
export class StaleWalletError extends Error {
  constructor(walletId: string) {
    super(`Wallet ${walletId} was modified concurrently`);
    this.name = 'StaleWalletError';
  }
}

export class WalletRepository {
  async insert(sql: SqlExecutor, wallet: Wallet): Promise<void> {
    await sql.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?)`,
      [wallet.id, wallet.playerId, wallet.currency, wallet.createdAt, wallet.updatedAt],
    );
  }

  async findById(sql: SqlExecutor, id: string): Promise<Wallet | null> {
    const rows = await sql.query(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?`, [id]);
    return rows[0] ? mapWallet(rows[0]) : null;
  }

  async findByPlayerAndCurrency(sql: SqlExecutor, playerId: string, currency: string): Promise<Wallet | null> {
    const rows = await sql.query(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE player_id = ? AND currency = ?`, [
      playerId,
      currency,
    ]);
    return rows[0] ? mapWallet(rows[0]) : null;
  }

  /**
   * Pessimistic lock on the wallet row. Every balance-changing operation of a
   * wallet goes through this, so operations on one wallet are serialized while
   * different wallets proceed in parallel.
   */
  async lockByPlayerAndCurrency(sql: SqlExecutor, playerId: string, currency: string): Promise<Wallet | null> {
    const rows = await sql.query(
      `SELECT ${WALLET_COLUMNS} FROM wallets WHERE player_id = ? AND currency = ? FOR UPDATE`,
      [playerId, currency],
    );
    return rows[0] ? mapWallet(rows[0]) : null;
  }

  /**
   * Persists balance changes made to the aggregate: compare-and-set on the
   * version plus one ledger row per change, in the caller's transaction.
   */
  async saveChanges(sql: SqlExecutor, wallet: Wallet): Promise<void> {
    const entries = wallet.pendingLedgerEntries();
    if (entries.length === 0) return;

    const updated = await sql.query(
      `UPDATE wallets SET balance = CAST(? AS numeric), version = ?, updated_at = ?
       WHERE id = ? AND version = ?
       RETURNING id`,
      [wallet.balance.toString(), wallet.version, wallet.updatedAt, wallet.id, wallet.persistedVersion],
    );
    if (updated.length !== 1) throw new StaleWalletError(wallet.id);

    for (const entry of entries) {
      await sql.query(
        `INSERT INTO wallet_ledger_entries
           (id, wallet_id, transaction_id, sequence, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, ?, ?, CAST(? AS numeric), ?, CAST(? AS numeric), CAST(? AS numeric), ?)`,
        [
          entry.id,
          entry.walletId,
          entry.transactionId,
          entry.sequence,
          entry.direction,
          entry.amount.toString(),
          entry.amount.currency,
          entry.balanceBefore.toString(),
          entry.balanceAfter.toString(),
          entry.createdAt,
        ],
      );
    }
  }

  /** Keyset pagination over the ledger, newest first. */
  async ledgerPage(
    sql: SqlExecutor,
    walletId: string,
    options: { limit: number; beforeSequence?: number },
  ): Promise<LedgerEntry[]> {
    const params: unknown[] = [walletId];
    let cursor = '';
    if (options.beforeSequence !== undefined) {
      cursor = 'AND sequence < ?';
      params.push(options.beforeSequence);
    }
    params.push(options.limit);
    const rows = await sql.query(
      `SELECT ${LEDGER_COLUMNS} FROM wallet_ledger_entries
       WHERE wallet_id = ? ${cursor}
       ORDER BY sequence DESC
       LIMIT ?`,
      params,
    );
    return rows.map(mapLedgerEntry);
  }
}

export function mapWallet(row: Row): Wallet {
  const currency = String(row.currency).trim();
  return Wallet.rehydrate({
    id: String(row.id),
    playerId: String(row.player_id),
    currency,
    balance: toMoney(row.balance, currency),
    version: toInt(row.version),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });
}

export function mapLedgerEntry(row: Row): LedgerEntry {
  const currency = String(row.currency).trim();
  return LedgerEntry.rehydrate({
    id: String(row.id),
    walletId: String(row.wallet_id),
    transactionId: String(row.transaction_id),
    sequence: toInt(row.sequence),
    direction: row.direction as 'CREDIT' | 'DEBIT',
    amount: toMoney(row.amount, currency),
    balanceBefore: toMoney(row.balance_before, currency),
    balanceAfter: toMoney(row.balance_after, currency),
    createdAt: toDate(row.created_at),
  });
}
