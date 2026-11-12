import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics, exposed at GET /metrics. */
export class Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions by final outcome',
    labelNames: ['type', 'status', 'channel'] as const,
    registers: [this.registry],
  });

  readonly rejections = new Counter({
    name: 'wager_rejections_total',
    help: 'Business rejections by failure code',
    labelNames: ['failure_code'] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicate submissions answered from the idempotency store or the inbox',
    labelNames: ['channel', 'source'] as const,
    registers: [this.registry],
  });

  readonly idempotencyConflicts = new Counter({
    name: 'wager_idempotency_conflicts_total',
    help: 'Same idempotency key / provider id with a different payload',
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks and unique-constraint races that forced a retry or a 503',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Time to process a wager transaction (including retries)',
    labelNames: ['channel'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly sqsMessages = new Counter({
    name: 'sqs_messages_total',
    help: 'Consumed SQS messages by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  readonly sqsRetries = new Counter({
    name: 'sqs_retries_total',
    help: 'Messages left on the queue for redelivery after a transient failure',
    registers: [this.registry],
  });

  readonly sqsDlq = new Counter({
    name: 'sqs_dlq_total',
    help: 'Messages moved to the dead letter queue',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox events published',
    registers: [this.registry],
  });

  readonly outboxFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Outbox publish failures',
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: 'outbox_pending_events',
    help: 'Unpublished outbox events',
    registers: [this.registry],
  });

  readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event',
    registers: [this.registry],
  });

  readonly pendingReferenceResolutions = new Counter({
    name: 'pending_reference_resolutions_total',
    help: 'Attempts to resolve PENDING_REFERENCE transactions by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  constructor(options: { collectDefaults?: boolean } = {}) {
    if (options.collectDefaults) collectDefaultMetrics({ register: this.registry });
  }
}
