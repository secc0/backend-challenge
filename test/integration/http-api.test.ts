import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { Container } from '../../src/container';
import { createHttpApp } from '../../src/interfaces/http/http-app';
import { createTestContainer, truncateAll } from '../helpers/harness';

describe('HTTP API', () => {
  let c: Container;
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    c = await createTestContainer();
    app = await createHttpApp(c);
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(async () => {
    await app.close();
    await c.close();
  });
  beforeEach(async () => truncateAll(c.db));

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  async function wallet(openingBalance = '100.00') {
    const playerId = `player-${crypto.randomUUID().slice(0, 8)}`;
    const res = await post('/wallets', { playerId, currency: 'BRL', openingBalance });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; playerId: string; balance: string };
  }

  const bet = (playerId: string, externalId: string, amount = '10.00') => ({
    provider: 'prov',
    externalId,
    playerId,
    currency: 'BRL',
    roundId: 'r1',
    type: 'BET',
    amount,
  });

  test('status codes distinguish every outcome', async () => {
    const w = await wallet('100.00');

    const created = await post('/transactions', bet(w.playerId, 'b1'), { 'Idempotency-Key': 'b1' });
    expect(created.status).toBe(201);
    expect(created.headers.get('idempotent-replayed')).toBe('false');

    const replay = await post('/transactions', bet(w.playerId, 'b1'), { 'Idempotency-Key': 'b1' });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');

    const conflict = await post('/transactions', bet(w.playerId, 'b1', '11.00'), { 'Idempotency-Key': 'b1' });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe('IDEMPOTENCY_CONFLICT');

    const rejected = await post('/transactions', bet(w.playerId, 'b2', '1000.00'), { 'Idempotency-Key': 'b2' });
    expect(rejected.status).toBe(422);
    expect(((await rejected.json()) as { failureCode: string }).failureCode).toBe('INSUFFICIENT_FUNDS');

    const pending = await post(
      '/transactions',
      { ...bet(w.playerId, 'r1'), type: 'REFUND', referenceExternalId: 'unknown' },
      { 'Idempotency-Key': 'r1' },
    );
    expect(pending.status).toBe(202);
    expect(((await pending.json()) as { status: string }).status).toBe('PENDING_REFERENCE');

    const invalid = await post('/transactions', { ...bet(w.playerId, 'b3'), amount: 10 }, { 'Idempotency-Key': 'b3' });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toBe('VALIDATION_ERROR');

    const noKey = await post('/transactions', bet(w.playerId, 'b4'));
    expect(noKey.status).toBe(400);

    const malformed = await post('/transactions', '{"broken', { 'Idempotency-Key': 'b5' });
    expect(malformed.status).toBe(400);
  });

  test('transient failures answer 503 with Retry-After', async () => {
    const w = await wallet('100.00');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locker = c.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [w.id]);
      await held;
    });
    const original = c.config.database.lockTimeoutMs;
    try {
      (c.config.database as { lockTimeoutMs: number }).lockTimeoutMs = 200;
      const res = await post('/transactions', bet(w.playerId, 't1'), { 'Idempotency-Key': 't1' });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(((await res.json()) as { reason: string }).reason).toBe('lock_timeout');
    } finally {
      (c.config.database as { lockTimeoutMs: number }).lockTimeoutMs = original;
      release();
      await locker;
    }
    // The client retries with the same key once the contention is gone.
    const retry = await post('/transactions', bet(w.playerId, 't1'), { 'Idempotency-Key': 't1' });
    expect(retry.status).toBe(201);
  });

  test('wallet, ledger pagination, transaction lookups and reconciliation', async () => {
    const w = await wallet('100.00');
    for (let i = 0; i < 5; i++) {
      await post('/transactions', bet(w.playerId, `p${i}`, '1.00'), { 'Idempotency-Key': `p${i}` });
    }
    const walletRes = (await (await fetch(`${base}/wallets/${w.id}`)).json()) as { balance: string; version: number };
    expect(walletRes).toMatchObject({ balance: '95.00', version: 6 });

    const page1 = (await (await fetch(`${base}/wallets/${w.id}/ledger?limit=4`)).json()) as {
      items: Array<{ sequence: number }>;
      nextCursor: string;
    };
    expect(page1.items.map((i) => i.sequence)).toEqual([6, 5, 4, 3]);
    const page2 = (await (await fetch(`${base}/wallets/${w.id}/ledger?limit=4&cursor=${page1.nextCursor}`)).json()) as {
      items: Array<{ sequence: number }>;
      nextCursor: string | null;
    };
    expect(page2.items.map((i) => i.sequence)).toEqual([2, 1]);
    expect(page2.nextCursor).toBeNull();

    const byProvider = (await (await fetch(`${base}/providers/prov/transactions/p0`)).json()) as { id: string; status: string };
    expect(byProvider.status).toBe('PROCESSED');
    const byId = (await (await fetch(`${base}/transactions/${byProvider.id}`)).json()) as { externalId: string };
    expect(byId.externalId).toBe('p0');

    const reconciliation = (await (await fetch(`${base}/wallets/${w.id}/reconciliation`)).json()) as { consistent: boolean };
    expect(reconciliation.consistent).toBe(true);

    expect((await fetch(`${base}/wallets/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
    expect((await fetch(`${base}/wallets/not-a-uuid`)).status).toBe(404);
  });

  test('reconciliation reports divergences instead of fixing them', async () => {
    const w = await wallet('100.00');
    // Simulate corruption outside the application (constraints still allow a positive balance).
    await c.db.reader().query('UPDATE wallets SET balance = 999 WHERE id = ?', [w.id]);
    const report = (await (await fetch(`${base}/reconciliation?walletId=${w.id}`)).json()) as {
      consistent: boolean;
      divergences: Array<{ check: string }>;
    };
    expect(report.consistent).toBe(false);
    expect(report.divergences.map((d) => d.check)).toContain('BALANCE_EQUALS_LEDGER_SUM');
    const after = (await (await fetch(`${base}/wallets/${w.id}`)).json()) as { balance: string };
    expect(after.balance).toBe('999.00');
  });

  test('duplicate wallet creation is a conflict', async () => {
    const w = await wallet('0.00');
    const res = await post('/wallets', { playerId: w.playerId, currency: 'BRL' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { walletId: string }).walletId).toBe(w.id);
  });

  test('health endpoints and metrics', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ checks: { database: 'up', sqs: 'up' } });
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain('wager_transactions_total');
    expect(metrics).toContain('http_request_duration_seconds');
  });

  test('correlation id is echoed back', async () => {
    const res = await fetch(`${base}/health/live`, { headers: { 'X-Correlation-Id': 'abc-123' } });
    expect(res.headers.get('x-correlation-id')).toBe('abc-123');
  });
});
