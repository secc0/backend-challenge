/**
 * Load test: `bun run test:load`
 *
 * Starts two application processes (unless LOAD_TEST_URLS is given), creates
 * wallets, then runs a closed-loop workload for a fixed duration with a fixed
 * number of concurrent virtual clients, spread across both instances.
 *
 * Workload per request: 55% BET, 20% WIN, 10% LOSS, 10% replay of an earlier
 * request (same Idempotency-Key), 5% BET on a single "hot" wallet that every
 * client shares (worst-case contention on one row lock).
 *
 * At the end it checks the invariants through the reconciliation endpoint and
 * writes a JSON report to load-test-results/.
 *
 * Environment: LOAD_TEST_DURATION_S (default 30), LOAD_TEST_CONCURRENCY (64),
 * LOAD_TEST_WALLETS (200), LOAD_TEST_URLS (comma separated, skips spawning).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cpus, platform, totalmem } from 'node:os';

const durationS = Number(process.env.LOAD_TEST_DURATION_S ?? 30);
const concurrency = Number(process.env.LOAD_TEST_CONCURRENCY ?? 64);
const walletCount = Number(process.env.LOAD_TEST_WALLETS ?? 200);
const runId = randomUUID().slice(0, 8);

const spawned: Array<ReturnType<typeof Bun.spawn>> = [];

async function startInstances(): Promise<string[]> {
  if (process.env.LOAD_TEST_URLS) return process.env.LOAD_TEST_URLS.split(',').map((url) => url.trim());
  const ports = [3401, 3402];
  for (const port of ports) {
    spawned.push(
      Bun.spawn([process.execPath, 'src/main.ts'], {
        env: { ...process.env, PORT: String(port), INSTANCE_ID: `load-${port}`, APP_WORKERS: 'outbox', LOG_LEVEL: 'error' },
        stdout: 'ignore',
        stderr: 'inherit',
      }),
    );
  }
  const urls = ports.map((port) => `http://localhost:${port}`);
  for (const url of urls) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`${url}/health/ready`)).ok) break;
      } catch {
        // starting
      }
      if (Date.now() > deadline) throw new Error(`${url} did not become ready`);
      await Bun.sleep(200);
    }
  }
  return urls;
}

interface Sample {
  kind: string;
  status: number;
  ms: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function main(): Promise<void> {
  const urls = await startInstances();
  const pick = (i: number) => urls[i % urls.length]!;
  console.log(`load test ${runId}: ${urls.length} instance(s), ${concurrency} clients, ${durationS}s, ${walletCount} wallets`);

  const players: string[] = [];
  const walletIds: string[] = [];
  for (let i = 0; i < walletCount + 1; i++) {
    const playerId = `load-${runId}-${i}`;
    const res = await fetch(`${pick(i)}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, currency: 'BRL', openingBalance: '1000.00' }),
    });
    if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${await res.text()}`);
    players.push(playerId);
    walletIds.push(((await res.json()) as { id: string }).id);
  }
  const hotPlayer = players[walletCount]!;

  const samples: Sample[] = [];
  const sent: Array<{ key: string; body: string }> = [];
  let counter = 0;
  const deadline = Date.now() + durationS * 1000;

  async function client(clientId: number): Promise<void> {
    while (Date.now() < deadline) {
      const n = counter++;
      const roll = Math.random();
      let kind: string;
      let key: string;
      let body: string;
      if (roll < 0.1 && sent.length > 0) {
        kind = 'REPLAY';
        ({ key, body } = sent[Math.floor(Math.random() * sent.length)]!);
      } else {
        const hot = roll >= 0.95;
        kind = hot ? 'HOT_BET' : roll < 0.65 ? 'BET' : roll < 0.85 ? 'WIN' : 'LOSS';
        const type = kind === 'HOT_BET' ? 'BET' : kind;
        const amount = type === 'LOSS' ? '0.00' : `${1 + (n % 9)}.${String(n % 100).padStart(2, '0')}`;
        const playerId = hot ? hotPlayer : players[Math.floor(Math.random() * walletCount)]!;
        key = `${runId}-${n}`;
        body = JSON.stringify({ provider: 'load', externalId: key, playerId, currency: 'BRL', roundId: `round-${n}`, type, amount });
        sent.push({ key, body });
      }
      const started = performance.now();
      let status = 0;
      try {
        const res = await fetch(`${pick(clientId)}/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
          body,
        });
        status = res.status;
        await res.arrayBuffer();
      } catch {
        status = 0;
      }
      samples.push({ kind, status, ms: performance.now() - started });
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => client(i)));
  const elapsedS = (Date.now() - started) / 1000;

  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus: Record<string, number> = {};
  const byKind: Record<string, { count: number; p50: number; p95: number; p99: number }> = {};
  for (const s of samples) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  for (const kind of [...new Set(samples.map((s) => s.kind))]) {
    const values = samples.filter((s) => s.kind === kind).map((s) => s.ms).sort((a, b) => a - b);
    byKind[kind] = { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99) };
  }

  const reconciliation = (await (await fetch(`${urls[0]}/reconciliation`)).json()) as {
    consistent: boolean;
    walletsChecked: number;
    divergences: unknown[];
  };

  const report = {
    runId,
    environment: { platform: platform(), cpus: cpus().length, cpuModel: cpus()[0]?.model, memoryGb: Math.round(totalmem() / 2 ** 30) },
    parameters: { instances: urls.length, concurrency, durationS, wallets: walletCount },
    totals: { requests: samples.length, elapsedS, throughputRps: Math.round(samples.length / elapsedS) },
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] ?? 0,
    },
    byStatus,
    byKind,
    invariants: {
      reconciliationConsistent: reconciliation.consistent,
      walletsChecked: reconciliation.walletsChecked,
      divergences: reconciliation.divergences.length,
    },
  };

  mkdirSync('load-test-results', { recursive: true });
  const file = `load-test-results/report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`report written to ${file}`);
  if (!reconciliation.consistent) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const proc of spawned) proc.kill();
  });
