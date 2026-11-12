import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { randomUUID } from 'node:crypto';
import type { Container } from '../../src/container';
import { createTestContainer, expectConsistent, sleep, truncateAll } from '../helpers/harness';

/**
 * Real multi-instance tests: separate OS processes running the actual
 * application (src/main.ts), each with its own connection pool, hit over HTTP.
 */
describe('multiple application processes', () => {
  let c: Container;
  const processes = new Map<number, Subprocess>();

  function spawnInstance(port: number): Subprocess {
    const proc = Bun.spawn([process.execPath, 'src/main.ts'], {
      env: {
        ...process.env,
        PORT: String(port),
        INSTANCE_ID: `test-${port}`,
        APP_WORKERS: 'none',
        WAGER_QUEUE_NAME: c.config.sqs.wagerQueueName,
        WAGER_DLQ_NAME: c.config.sqs.wagerDlqName,
        EVENTS_QUEUE_NAME: c.config.sqs.eventsQueueName,
        LOG_LEVEL: 'error',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    processes.set(port, proc);
    return proc;
  }

  async function waitReady(port: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://localhost:${port}/health/ready`)).ok) return;
      } catch {
        // not listening yet
      }
      await sleep(200);
    }
    throw new Error(`instance on ${port} did not become ready`);
  }

  const PORT_A = 3301;
  const PORT_B = 3302;

  beforeAll(async () => {
    c = await createTestContainer();
    spawnInstance(PORT_A);
    spawnInstance(PORT_B);
    await Promise.all([waitReady(PORT_A), waitReady(PORT_B)]);
  }, 60_000);

  afterAll(async () => {
    for (const proc of processes.values()) proc.kill();
    await Promise.all([...processes.values()].map((proc) => proc.exited));
    await c.close();
  });

  beforeEach(async () => truncateAll(c.db));

  async function createWallet(port: number, openingBalance: string) {
    const res = await fetch(`http://localhost:${port}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: `player-${randomUUID().slice(0, 8)}`, currency: 'BRL', openingBalance }),
    });
    return (await res.json()) as { id: string; playerId: string };
  }

  function bet(port: number, playerId: string, externalId: string, amount: string, key = externalId) {
    return fetch(`http://localhost:${port}/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ provider: 'prov', externalId, playerId, currency: 'BRL', roundId: 'r1', type: 'BET', amount }),
    });
  }

  async function balance(walletId: string): Promise<string> {
    return (await c.queries.wallet(walletId)).balance.toString();
  }

  test('100.00 and two BETs of 80.00 on two different processes → 201 + 422, balance 20.00', async () => {
    const wallet = await createWallet(PORT_A, '100.00');
    const [x, y] = await Promise.all([
      bet(PORT_A, wallet.playerId, `a-${randomUUID()}`, '80.00'),
      bet(PORT_B, wallet.playerId, `b-${randomUUID()}`, '80.00'),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 422]);
    expect(await balance(wallet.id)).toBe('20.00');
    await expectConsistent(c);
  });

  test('50 identical requests split across processes → one debit', async () => {
    const wallet = await createWallet(PORT_A, '100.00');
    const externalId = `same-${randomUUID()}`;
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => bet(i % 2 ? PORT_A : PORT_B, wallet.playerId, externalId, '10.00')),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(responses.filter((r) => r.headers.get('idempotent-replayed') === 'false')).toHaveLength(1);
    expect(await balance(wallet.id)).toBe('90.00');
    await expectConsistent(c);
  });

  test('crash: an instance is killed mid-load, clients retry on the other one, nothing is lost or doubled', async () => {
    const wallet = await createWallet(PORT_B, '1000.00');
    const ids = Array.from({ length: 200 }, (_, i) => `crash-${i}-${randomUUID().slice(0, 6)}`);

    // Fire everything at A and kill it (SIGKILL: no graceful shutdown) while requests are in flight.
    const inFlight = ids.map((id) =>
      bet(PORT_A, wallet.playerId, id, '1.00').then(
        (res) => res.status,
        () => 0,
      ),
    );
    await sleep(150);
    processes.get(PORT_A)!.kill('SIGKILL');
    const firstTry = await Promise.all(inFlight);
    // The kill must really interrupt work in flight, otherwise this test proves nothing.
    expect(firstTry.some((status) => status !== 201)).toBe(true);

    // Every request without a definitive answer is retried with the same key on B.
    const retried = await Promise.all(
      ids.map(async (id, i) => (firstTry[i] === 201 ? 201 : (await bet(PORT_B, wallet.playerId, id, '1.00')).status)),
    );
    expect(retried.every((status) => status === 201)).toBe(true);

    const rows = await c.db.reader().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`,
      [wallet.id],
    );
    expect(Number(rows[0]?.n)).toBe(200);
    expect(await balance(wallet.id)).toBe('800.00');
    await expectConsistent(c);

    // Bring A back for any later test.
    spawnInstance(PORT_A);
    await waitReady(PORT_A);
  }, 60_000);
});
