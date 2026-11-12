import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config';
import type { Database } from '../database/database';
import type { JsonLogger } from '../observability/logger';
import type { Metrics } from '../observability/metrics';
import type { OutboxRecord, OutboxRepository } from '../persistence/outbox.repository';

/**
 * Publishes committed outbox events to SQS.
 *
 * Each batch is claimed with `FOR UPDATE SKIP LOCKED`, sent, and marked as
 * published in the same SQL transaction. Any number of publishers can run
 * concurrently (on any number of instances) without sending the same row
 * twice at the same time. Delivery is at-least-once: if the process dies
 * after SQS accepted the batch but before the commit, those events are sent
 * again; consumers de-duplicate on `eventId`.
 */
export class OutboxPublisher {
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly db: Database,
    private readonly outbox: OutboxRepository,
    private readonly client: SQSClient,
    private readonly eventsQueueUrl: string,
    private readonly settings: AppConfig['outbox'],
    private readonly metrics: Metrics,
    private readonly logger: JsonLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info('outbox publisher started');
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.logger.info('outbox publisher stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let published = 0;
      try {
        published = await this.publishOnce();
        await this.refreshLagMetrics();
      } catch (error) {
        this.logger.error('outbox publish cycle failed', error as Error);
      }
      // Drain quickly while there is backlog, otherwise wait for the next poll.
      if (published < this.settings.batchSize) await sleep(this.settings.pollIntervalMs);
    }
  }

  /** Publishes one batch; returns the number of events published. Public for tests. */
  async publishOnce(): Promise<number> {
    return this.db.transaction(async (sql) => {
      const batch = await this.outbox.claimBatch(sql, this.settings.batchSize);
      if (batch.length === 0) return 0;

      const published: string[] = [];
      for (let i = 0; i < batch.length; i += 10) {
        const chunk = batch.slice(i, i + 10);
        const failed = await this.send(chunk);
        for (const record of chunk) {
          const failure = failed.get(record.id);
          if (failure) {
            const backoff = Math.min(1000 * 2 ** record.attempts, this.settings.maxBackoffMs);
            await this.outbox.markFailed(sql, record.id, failure, backoff);
            this.metrics.outboxFailures.inc();
          } else {
            published.push(record.id);
          }
        }
      }
      await this.outbox.markPublished(sql, published);
      this.metrics.outboxPublished.inc(published.length);
      return published.length;
    });
  }

  async refreshLagMetrics(): Promise<void> {
    const lag = await this.outbox.lag(this.db.reader());
    this.metrics.outboxPending.set(lag.pending);
    this.metrics.outboxLag.set(lag.oldestAgeSeconds);
  }

  /** Returns the ids that failed, with the error message. */
  private async send(records: OutboxRecord[]): Promise<Map<string, string>> {
    const failures = new Map<string, string>();
    try {
      const response = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: this.eventsQueueUrl,
          Entries: records.map((record) => ({
            Id: record.id,
            MessageBody: JSON.stringify(record.envelope),
            MessageAttributes: {
              EventType: { DataType: 'String', StringValue: record.eventType },
              EventId: { DataType: 'String', StringValue: record.id },
              AggregateId: { DataType: 'String', StringValue: record.aggregateId },
            },
          })),
        }),
      );
      for (const failed of response.Failed ?? []) {
        if (failed.Id) failures.set(failed.Id, failed.Message ?? failed.Code ?? 'send failed');
      }
    } catch (error) {
      for (const record of records) failures.set(record.id, (error as Error).message);
    }
    return failures;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
