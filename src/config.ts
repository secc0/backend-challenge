function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`Invalid integer for ${name}: ${raw}`);
  return value;
}

export type AppRole = 'api' | 'consumer' | 'outbox' | 'pending-reference';
const ALL_ROLES: AppRole[] = ['api', 'consumer', 'outbox', 'pending-reference'];

export interface AppConfig {
  instanceId: string;
  port: number;
  roles: Set<AppRole>;
  logLevel: string;
  database: {
    url: string;
    poolMax: number;
    /** Max time a transaction waits for a wallet row lock before failing as transient. */
    lockTimeoutMs: number;
    statementTimeoutMs: number;
  };
  sqs: {
    region: string;
    endpoint: string | undefined;
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    /** Receives before a message is moved to the DLQ (also the RedrivePolicy maxReceiveCount). */
    maxReceiveCount: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    batchSize: number;
  };
  outbox: {
    pollIntervalMs: number;
    batchSize: number;
    maxBackoffMs: number;
  };
  pendingReference: {
    pollIntervalMs: number;
    batchSize: number;
    /** How long a REFUND/ROLLBACK waits for its original before failing. */
    ttlMs: number;
    maxAttempts: number;
    initialBackoffMs: number;
    maxBackoffMs: number;
  };
}

export function loadConfig(): AppConfig {
  const roles = str('APP_ROLES', ALL_ROLES.join(','))
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  for (const role of roles) {
    if (!ALL_ROLES.includes(role as AppRole)) throw new Error(`Unknown role in APP_ROLES: ${role}`);
  }

  return {
    instanceId: str('INSTANCE_ID', `${process.pid}`),
    port: int('PORT', 3000),
    roles: new Set(roles as AppRole[]),
    logLevel: str('LOG_LEVEL', 'info'),
    database: {
      url: str('DATABASE_URL', 'postgres://wagering:wagering@localhost:55432/wagering'),
      poolMax: int('DATABASE_POOL_MAX', 20),
      lockTimeoutMs: int('DATABASE_LOCK_TIMEOUT_MS', 5000),
      statementTimeoutMs: int('DATABASE_STATEMENT_TIMEOUT_MS', 15000),
    },
    sqs: {
      region: str('AWS_REGION', 'us-east-1'),
      endpoint: process.env.SQS_ENDPOINT || undefined,
      wagerQueueName: str('WAGER_QUEUE_NAME', 'wager-transactions.fifo'),
      wagerDlqName: str('WAGER_DLQ_NAME', 'wager-transactions-dlq.fifo'),
      eventsQueueName: str('EVENTS_QUEUE_NAME', 'wager-events'),
      maxReceiveCount: int('SQS_MAX_RECEIVE_COUNT', 5),
      waitTimeSeconds: int('SQS_WAIT_TIME_SECONDS', 10),
      visibilityTimeoutSeconds: int('SQS_VISIBILITY_TIMEOUT_SECONDS', 30),
      batchSize: int('SQS_BATCH_SIZE', 10),
    },
    outbox: {
      pollIntervalMs: int('OUTBOX_POLL_INTERVAL_MS', 500),
      batchSize: int('OUTBOX_BATCH_SIZE', 50),
      maxBackoffMs: int('OUTBOX_MAX_BACKOFF_MS', 60000),
    },
    pendingReference: {
      pollIntervalMs: int('PENDING_REFERENCE_POLL_INTERVAL_MS', 1000),
      batchSize: int('PENDING_REFERENCE_BATCH_SIZE', 50),
      ttlMs: int('PENDING_REFERENCE_TTL_MS', 10 * 60 * 1000),
      maxAttempts: int('PENDING_REFERENCE_MAX_ATTEMPTS', 20),
      initialBackoffMs: int('PENDING_REFERENCE_INITIAL_BACKOFF_MS', 1000),
      maxBackoffMs: int('PENDING_REFERENCE_MAX_BACKOFF_MS', 60000),
    },
  };
}
