import type { Database } from '../infrastructure/database/database';

export interface Divergence {
  check: string;
  walletId: string | null;
  transactionId?: string | null;
  details: Record<string, unknown>;
}

export interface ReconciliationReport {
  checkedAt: string;
  walletsChecked: number;
  consistent: boolean;
  divergences: Divergence[];
}

/**
 * Compares the materialized state with the ledger and REPORTS divergences.
 * It never fixes anything: correcting financial data is a human decision.
 */
export class Reconciliation {
  constructor(private readonly db: Database) {}

  async run(walletId?: string): Promise<ReconciliationReport> {
    const sql = this.db.reader();
    const scope = walletId ? 'WHERE w.id = ?' : '';
    const scopeParams = walletId ? [walletId] : [];
    const divergences: Divergence[] = [];

    // 1. Balance vs. ledger: sum of movements, last balance_after, version vs. entries.
    const balances = await sql.query(
      `SELECT w.id, w.balance::text AS balance, w.version::text AS version,
              COALESCE(l.net, 0)::numeric(20, 2)::text AS ledger_net,
              COALESCE(l.entries, 0)::text AS entries,
              COALESCE(l.max_sequence, 0)::text AS max_sequence,
              COALESCE(last.balance_after, 0)::numeric(20, 2)::text AS last_balance_after
       FROM wallets w
       LEFT JOIN (
         SELECT wallet_id,
                SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS net,
                COUNT(*) AS entries,
                MAX(sequence) AS max_sequence
         FROM wallet_ledger_entries GROUP BY wallet_id
       ) l ON l.wallet_id = w.id
       LEFT JOIN LATERAL (
         SELECT balance_after FROM wallet_ledger_entries e
         WHERE e.wallet_id = w.id ORDER BY sequence DESC LIMIT 1
       ) last ON true
       ${scope}`,
      scopeParams,
    );
    for (const row of balances) {
      const id = String(row.id);
      if (row.balance !== row.ledger_net) {
        divergences.push({ check: 'BALANCE_EQUALS_LEDGER_SUM', walletId: id, details: { balance: row.balance, ledgerSum: row.ledger_net } });
      }
      if (row.balance !== row.last_balance_after) {
        divergences.push({ check: 'BALANCE_EQUALS_LAST_ENTRY', walletId: id, details: { balance: row.balance, lastBalanceAfter: row.last_balance_after } });
      }
      if (row.version !== row.entries || row.version !== row.max_sequence) {
        divergences.push({ check: 'VERSION_EQUALS_ENTRY_COUNT', walletId: id, details: { version: row.version, entries: row.entries, maxSequence: row.max_sequence } });
      }
    }

    // 2. Ledger chain: each entry starts where the previous one ended, sequences have no gaps.
    const chain = await sql.query(
      `SELECT wallet_id, id, sequence::text AS sequence, balance_before::text AS balance_before, prev_after::text AS prev_after, prev_sequence::text AS prev_sequence
       FROM (
         SELECT e.*, LAG(balance_after) OVER (PARTITION BY wallet_id ORDER BY sequence) AS prev_after,
                     LAG(sequence) OVER (PARTITION BY wallet_id ORDER BY sequence) AS prev_sequence
         FROM wallet_ledger_entries e
         ${walletId ? 'WHERE e.wallet_id = ?' : ''}
       ) x
       WHERE (prev_after IS NULL AND (balance_before <> 0 OR sequence <> 1))
          OR (prev_after IS NOT NULL AND (balance_before <> prev_after OR sequence <> prev_sequence + 1))`,
      scopeParams,
    );
    for (const row of chain) {
      divergences.push({
        check: 'LEDGER_CHAIN_CONTINUOUS',
        walletId: String(row.wallet_id),
        details: { entryId: row.id, sequence: row.sequence, balanceBefore: row.balance_before, previousBalanceAfter: row.prev_after },
      });
    }

    // 3. Transactions vs. ledger: every PROCESSED money movement has exactly one entry with the same amount,
    //    and nothing else has an entry.
    const txLedger = await sql.query(
      `SELECT t.id, t.wallet_id, t.kind, t.status, t.amount::text AS amount, t.balance_after::text AS tx_balance_after,
              COUNT(e.id)::text AS entries, MIN(e.amount)::text AS entry_amount, MIN(e.balance_after)::text AS entry_balance_after
       FROM wager_transactions t
       LEFT JOIN wallet_ledger_entries e ON e.transaction_id = t.id
       ${walletId ? 'WHERE t.wallet_id = ?' : ''}
       GROUP BY t.id
       HAVING
         (t.status = 'PROCESSED' AND t.kind <> 'LOSS' AND (COUNT(e.id) <> 1 OR MIN(e.amount) <> t.amount OR MIN(e.balance_after) <> t.balance_after))
         OR ((t.status <> 'PROCESSED' OR t.kind = 'LOSS') AND COUNT(e.id) > 0)`,
      scopeParams,
    );
    for (const row of txLedger) {
      divergences.push({
        check: 'TRANSACTION_MATCHES_LEDGER',
        walletId: (row.wallet_id as string | null) ?? null,
        transactionId: String(row.id),
        details: { kind: row.kind, status: row.status, amount: row.amount, entries: row.entries, entryAmount: row.entry_amount },
      });
    }

    return {
      checkedAt: new Date().toISOString(),
      walletsChecked: balances.length,
      consistent: divergences.length === 0,
      divergences,
    };
  }
}
