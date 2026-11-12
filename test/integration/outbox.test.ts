import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { Container } from '../../src/container';
import type { EventEnvelope } from '../../src/domain/events';
import { OutboxPublisher } from '../../src/infrastructure/sqs/outbox-publisher';
import { createTestContainer, createWallet, http, truncateAll, wager } from '../helpers/harness';

describe('transactional outbox (PostgreSQL + LocalStack)', () => {
  let a: Container;
  let b: Container;

  beforeAll(async () => {
    a = await createTestContainer({ outbox: { batchSize: 7 } });
    // Second "instance": its own connection pool, publishing to the same queue.
    b = await createTestContainer({ outbox: { batchSize: 7 }, sqs: { eventsQueueName: a.config.sqs.eventsQueueName } as never });
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });
  beforeEach(async () => {
    await truncateAll(a.db);
    await receiveAll();
  });

  async function receiveAll(): Promise<EventEnvelope[]> {
    const envelopes: EventEnvelope[] = [];
    for (let empty = 0; empty < 2; ) {
      const res = await a.sqs.send(
        new ReceiveMessageCommand({ QueueUrl: a.queues.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 30 }),
      );
      if (!res.Messages?.length) {
        empty++;
        continue;
      }
      for (const message of res.Messages) {
        envelopes.push(JSON.parse(message.Body!) as EventEnvelope);
        await a.sqs.send(new DeleteMessageCommand({ QueueUrl: a.queues.events, ReceiptHandle: message.ReceiptHandle }));
      }
    }
    return envelopes;
  }

  async function unpublished(): Promise<number> {
    const rows = await a.db.reader().query<{ n: string }>('SELECT count(*)::text AS n FROM outbox_events WHERE published_at IS NULL');
    return Number(rows[0]?.n);
  }

  test('nothing is published before commit: events only exist as outbox rows', async () => {
    const wallet = await createWallet(a, '100.00');
    await a.submitWager.execute(wager({ playerId: wallet.playerId, amount: '10.00' }), http);
    expect(await unpublished()).toBe(4);
    expect(await receiveAll()).toHaveLength(0);
  });

  test('publishes committed events with a typed envelope and string money', async () => {
    const wallet = await createWallet(a, '100.00');
    await a.submitWager.execute(wager({ playerId: wallet.playerId, amount: '10.00' }), http);
    while ((await a.outboxPublisher.publishOnce()) > 0);
    const envelopes = await receiveAll();
    expect(envelopes.map((e) => e.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    const change = envelopes.find((e) => e.eventType === 'WalletBalanceChanged' && (e.payload as { direction: string }).direction === 'DEBIT');
    expect(change?.payload).toMatchObject({ amount: '10.00', balanceBefore: '100.00', balanceAfter: '90.00', currency: 'BRL' });
    expect(await unpublished()).toBe(0);
  });

  test('concurrent publishers on two instances publish every event exactly once', async () => {
    for (let i = 0; i < 10; i++) {
      const wallet = await createWallet(a, '100.00');
      await a.submitWager.execute(wager({ playerId: wallet.playerId, amount: '1.00' }), http);
    }
    const total = 10 * 4;
    expect(await unpublished()).toBe(total);

    const publishers = [a.outboxPublisher, b.outboxPublisher, a.outboxPublisher, b.outboxPublisher];
    await Promise.all(
      publishers.map(async (publisher: OutboxPublisher) => {
        while ((await publisher.publishOnce()) > 0);
      }),
    );

    const envelopes = await receiveAll();
    const ids = envelopes.map((e) => e.eventId);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(await unpublished()).toBe(0);
  });

  test('a failed publish keeps the event for a later retry', async () => {
    const wallet = await createWallet(a, '100.00');
    const broken = new OutboxPublisher(
      a.db,
      a.repositories.outbox,
      a.sqs,
      `${a.queues.events}-does-not-exist`,
      a.config.outbox,
      a.metrics,
      a.logger,
    );
    expect(await broken.publishOnce()).toBe(0);
    const rows = await a.db.reader().query<{ attempts: number; last_error: string | null }>(
      'SELECT attempts, last_error FROM outbox_events WHERE aggregate_id = ?',
      [wallet.id],
    );
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.last_error).not.toBeNull();
    expect(await unpublished()).toBe(2);
  });

  test('lag metrics reflect the backlog', async () => {
    await createWallet(a, '100.00');
    await a.outboxPublisher.refreshLagMetrics();
    const metrics = await a.metrics.registry.getSingleMetricAsString('outbox_pending_events');
    expect(metrics).toContain('outbox_pending_events 2');
  });
});
