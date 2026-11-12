import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Container } from '../../src/container';
import { createTestContainer, createWallet, http, truncateAll, wager } from '../helpers/harness';

/** The database itself must refuse corrupt financial data, whatever the application does. */
describe('schema invariants (PostgreSQL)', () => {
  let c: Container;

  beforeAll(async () => {
    c = await createTestContainer();
  });
  afterAll(async () => c.close());
  beforeEach(async () => truncateAll(c.db));

  test('migrations are reversible and re-applicable', async () => {
    const migrator = c.db.orm.getMigrator();
    expect((await migrator.getPendingMigrations()).length).toBe(0);
    await migrator.down({ to: 0 });
    const tables = await c.db.reader().query(`SELECT to_regclass('public.wallets')::text AS t`);
    expect(tables[0]?.t).toBeNull();
    await migrator.up();
    expect((await migrator.getExecutedMigrations()).length).toBe(1);
  });

  test('balance cannot be negative', async () => {
    const wallet = await createWallet(c, '10.00');
    await expect(c.db.reader().query(`UPDATE wallets SET balance = -0.01 WHERE id = ?`, [wallet.id])).rejects.toThrow(
      /wallets_balance_non_negative/,
    );
  });

  test('ledger entries cannot be updated nor deleted', async () => {
    const wallet = await createWallet(c, '10.00');
    await expect(c.db.reader().query(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?`, [wallet.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(c.db.reader().query(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [wallet.id])).rejects.toThrow(
      /append-only/,
    );
  });

  test('ledger arithmetic is checked by the database', async () => {
    const wallet = await createWallet(c, '10.00');
    const [tx] = await c.db.reader().query<{ id: string }>(`SELECT id FROM wager_transactions WHERE wallet_id = ?`, [wallet.id]);
    await expect(
      c.db.reader().query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, sequence, direction, amount, currency, balance_before, balance_after)
         VALUES (gen_random_uuid(), ?, ?, 99, 'CREDIT', 5, 'BRL', 10, 20)`,
        [wallet.id, tx!.id],
      ),
    ).rejects.toThrow(/ledger_arithmetic_chk/);
  });

  test('one ledger entry per wallet and transaction', async () => {
    const wallet = await createWallet(c, '10.00');
    const [tx] = await c.db.reader().query<{ id: string }>(`SELECT id FROM wager_transactions WHERE wallet_id = ?`, [wallet.id]);
    await expect(
      c.db.reader().query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, sequence, direction, amount, currency, balance_before, balance_after)
         VALUES (gen_random_uuid(), ?, ?, 2, 'CREDIT', 5, 'BRL', 10, 15)`,
        [wallet.id, tx!.id],
      ),
    ).rejects.toThrow(/ledger_wallet_transaction_uq/);
  });

  test('final transactions are immutable', async () => {
    const wallet = await createWallet(c, '10.00');
    const { transaction } = await c.submitWager.execute(wager({ playerId: wallet.playerId }), http);
    await expect(c.db.reader().query(`UPDATE wager_transactions SET status = 'REJECTED' WHERE id = ?`, [transaction.id])).rejects.toThrow(
      /is final/,
    );
    await expect(c.db.reader().query(`DELETE FROM wager_transactions WHERE id = ?`, [transaction.id])).rejects.toThrow(/blocked/);
  });

  test('idempotency key and provider transaction id are unique', async () => {
    const wallet = await createWallet(c, '10.00');
    const { transaction } = await c.submitWager.execute(wager({ playerId: wallet.playerId }), http);
    await expect(
      c.db.reader().query(
        `INSERT INTO wager_transactions (id, idempotency_key, payload_hash, provider, external_id, player_id, currency, kind, amount, status)
         VALUES (gen_random_uuid(), ?, repeat('0', 64), 'other', 'other', 'p', 'BRL', 'BET', 1, 'PENDING')`,
        [transaction.idempotencyKey],
      ),
    ).rejects.toThrow(/wager_tx_idempotency_key_uq/);
    await expect(
      c.db.reader().query(
        `INSERT INTO wager_transactions (id, idempotency_key, payload_hash, provider, external_id, player_id, currency, kind, amount, status)
         VALUES (gen_random_uuid(), 'fresh-key', repeat('0', 64), ?, ?, 'p', 'BRL', 'BET', 1, 'PENDING')`,
        [transaction.provider, transaction.externalId],
      ),
    ).rejects.toThrow(/wager_tx_provider_external_uq/);
  });

  test('money columns are exact decimals', async () => {
    const rows = await c.db.reader().query<{ data_type: string; column_name: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name IN ('wallets', 'wallet_ledger_entries', 'wager_transactions')
         AND column_name IN ('balance', 'amount', 'balance_before', 'balance_after')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.data_type).toBe('numeric');
  });
});
