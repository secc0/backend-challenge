import { randomUUID } from 'node:crypto';
import type { SubmitWagerCommand } from '../../src/application/commands';
import { loadConfig, type AppConfig } from '../../src/config';
import { buildContainer, type Container, type ContainerOptions } from '../../src/container';
import { Database } from '../../src/infrastructure/database/database';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

/** Config for tests: real Postgres + LocalStack, unique queue names per suite, no background loops. */
export function testConfig(overrides: DeepPartial<AppConfig> = {}, queueSuffix = randomUUID().slice(0, 8)): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    ...overrides,
    workers: new Set(),
    database: { ...base.database, poolMax: 30, ...overrides.database },
    sqs: {
      ...base.sqs,
      wagerQueueName: `test-wager-${queueSuffix}.fifo`,
      wagerDlqName: `test-wager-dlq-${queueSuffix}.fifo`,
      eventsQueueName: `test-events-${queueSuffix}`,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 2,
      ...overrides.sqs,
    },
    outbox: { ...base.outbox, ...overrides.outbox },
    pendingReference: { ...base.pendingReference, ...overrides.pendingReference },
  } as AppConfig;
}

let migrated: Promise<void> | null = null;

/** Applies the migrations once per test process (down + up, which also proves they are reversible). */
export function migrateOnce(): Promise<void> {
  migrated ??= (async () => {
    const db = await Database.connect(loadConfig().database);
    try {
      const migrator = db.orm.getMigrator();
      await migrator.down({ to: 0 });
      await migrator.up();
    } finally {
      await db.close();
    }
  })();
  return migrated;
}

export async function truncateAll(db: Database): Promise<void> {
  await db.reader().query(
    'TRUNCATE outbox_events, inbox_messages, wallet_ledger_entries, wager_transactions, wallets RESTART IDENTITY CASCADE',
  );
}

export async function createTestContainer(
  overrides: DeepPartial<AppConfig> = {},
  options: ContainerOptions = {},
): Promise<Container> {
  await migrateOnce();
  return buildContainer(testConfig(overrides), { ensureQueues: true, ...options });
}

export async function createWallet(c: Container, openingBalance = '100.00', playerId = `player-${randomUUID().slice(0, 8)}`) {
  return c.createWallet.execute({ playerId, currency: 'BRL', openingBalance }, null);
}

let sequence = 0;

export function wager(overrides: Partial<SubmitWagerCommand> & Pick<SubmitWagerCommand, 'playerId'>): SubmitWagerCommand {
  const externalId = overrides.externalId ?? `tx-${Date.now()}-${++sequence}-${randomUUID().slice(0, 6)}`;
  return {
    provider: 'provider-a',
    currency: 'BRL',
    roundId: 'round-1',
    type: 'BET',
    amount: '10.00',
    ...overrides,
    externalId,
    idempotencyKey: overrides.idempotencyKey ?? externalId,
  };
}

export const http = { channel: 'http' as const, correlationId: null };

export async function walletBalance(c: Container, walletId: string): Promise<string> {
  return (await c.queries.wallet(walletId)).balance.toString();
}

export async function ledgerCount(c: Container, walletId: string): Promise<number> {
  const rows = await c.db.reader().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ?',
    [walletId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function outboxEventTypes(c: Container, aggregateId?: string): Promise<string[]> {
  const rows = await c.db.reader().query<{ event_type: string }>(
    `SELECT event_type FROM outbox_events ${aggregateId ? 'WHERE aggregate_id = ?' : ''} ORDER BY position`,
    aggregateId ? [aggregateId] : [],
  );
  return rows.map((row) => row.event_type);
}

/** The invariant every test ends with: materialized balances equal the ledger. */
export async function expectConsistent(c: Container): Promise<void> {
  const report = await c.reconciliation.run();
  if (!report.consistent) {
    throw new Error(`Reconciliation found divergences: ${JSON.stringify(report.divergences, null, 2)}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
