import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Container } from '../../src/container';
import {
  createTestContainer,
  createWallet,
  expectConsistent,
  ledgerCount,
  sleep,
  truncateAll,
  wager,
  walletBalance,
} from '../helpers/harness';

describe('SQS consumer (LocalStack)', () => {
  let c: Container;
  let crashAfterCommit = false;
  // One FIFO message group per test, so a leftover in-flight message can never block another test.
  let group = 'g';

  beforeAll(async () => {
    c = await createTestContainer(
      { sqs: { maxReceiveCount: 2 }, database: { lockTimeoutMs: 300 } },
      {
        consumerHooks: {
          afterCommit: () => {
            if (crashAfterCommit) {
              crashAfterCommit = false;
              throw new Error('simulated crash between commit and ack');
            }
          },
        },
      },
    );
  });
  afterAll(async () => c.close());
  beforeEach(async () => {
    crashAfterCommit = false;
    group = `g-${crypto.randomUUID()}`;
    await truncateAll(c.db);
    await drain(c.queues.wager);
    await drain(c.queues.dlq);
  });

  async function send(body: unknown, groupId = group, dedupId = crypto.randomUUID()) {
    await c.sqs.send(
      new SendMessageCommand({
        QueueUrl: c.queues.wager,
        MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
        MessageGroupId: groupId,
        MessageDeduplicationId: dedupId,
      }),
    );
  }

  async function drain(queueUrl: string) {
    for (;;) {
      const res = await c.sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: 0 }));
      if (!res.Messages?.length) return;
      for (const m of res.Messages) {
        const { DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
        await c.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
      }
    }
  }

  async function dlqMessages() {
    const res = await c.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: c.queues.dlq, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }),
    );
    // Delete what we read: in-flight FIFO messages would block their group for later tests.
    const { DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
    for (const m of res.Messages ?? []) {
      await c.sqs.send(new DeleteMessageCommand({ QueueUrl: c.queues.dlq, ReceiptHandle: m.ReceiptHandle }));
    }
    return res.Messages ?? [];
  }

  /** Polls until `count` results were collected or the deadline passes. */
  async function consume(count: number, timeoutMs = 10_000) {
    const results: string[] = [];
    const deadline = Date.now() + timeoutMs;
    while (results.length < count && Date.now() < deadline) {
      results.push(...(await c.consumer.pollOnce(1)));
    }
    return results;
  }

  function body(command: ReturnType<typeof wager>) {
    const { idempotencyKey, ...rest } = command;
    return { ...rest, idempotencyKey };
  }

  test('processes a message through the same use case and acks it', async () => {
    const wallet = await createWallet(c, '100.00');
    await send(body(wager({ playerId: wallet.playerId, amount: '30.00' })));
    expect(await consume(1)).toEqual(['processed']);
    expect(await walletBalance(c, wallet.id)).toBe('70.00');
    expect(await c.consumer.pollOnce(1)).toEqual([]); // acked: nothing left
  });

  test('business rejections are committed and acked, not retried', async () => {
    const wallet = await createWallet(c, '10.00');
    await send(body(wager({ playerId: wallet.playerId, amount: '30.00' })));
    expect(await consume(1)).toEqual(['processed']);
    const rows = await c.db.reader().query<{ failure_code: string }>('SELECT failure_code FROM wager_transactions WHERE kind = ?', ['BET']);
    expect(rows[0]?.failure_code).toBe('INSUFFICIENT_FUNDS');
    expect(await dlqMessages()).toHaveLength(0);
  });

  test('crash after commit: the redelivered message is recognized by the inbox and not applied twice', async () => {
    const wallet = await createWallet(c, '100.00');
    await send(body(wager({ playerId: wallet.playerId, amount: '30.00' })));
    crashAfterCommit = true;

    // First delivery commits, then "crashes" before deleting the message.
    expect(await consume(1)).toEqual(['retry']);
    expect(await walletBalance(c, wallet.id)).toBe('70.00');

    // Visibility timeout expires, SQS redelivers the same message.
    expect(await consume(1)).toEqual(['duplicate']);
    expect(await walletBalance(c, wallet.id)).toBe('70.00');
    expect(await ledgerCount(c, wallet.id)).toBe(2);
    const inbox = await c.db.reader().query('SELECT * FROM inbox_messages');
    expect(inbox).toHaveLength(1);
    await expectConsistent(c);
  });

  test('the same transaction sent twice as different messages is applied once', async () => {
    const wallet = await createWallet(c, '100.00');
    const command = body(wager({ playerId: wallet.playerId, amount: '30.00' }));
    await send(command);
    await send(command);
    expect((await consume(2)).sort()).toEqual(['duplicate', 'processed']);
    expect(await walletBalance(c, wallet.id)).toBe('70.00');
  });

  test('without idempotencyKey the key defaults to provider:externalId', async () => {
    const wallet = await createWallet(c, '100.00');
    const { idempotencyKey: _ignored, ...command } = wager({ playerId: wallet.playerId, amount: '1.00' });
    await send(command);
    expect(await consume(1)).toEqual(['processed']);
    const rows = await c.db.reader().query<{ idempotency_key: string }>('SELECT idempotency_key FROM wager_transactions WHERE external_id = ?', [
      command.externalId,
    ]);
    expect(rows[0]?.idempotency_key).toBe(`${command.provider}:${command.externalId}`);
  });

  test('poison messages go straight to the DLQ', async () => {
    await send('this is not json');
    await send({ provider: 'p', amount: 10 });
    expect(await consume(2)).toEqual(['dead-lettered', 'dead-lettered']);
    const dlq = await dlqMessages();
    expect(dlq.map((m) => m.MessageAttributes?.FailureReason?.StringValue).sort()).toEqual(['VALIDATION_ERROR', 'VALIDATION_ERROR']);
  });

  test('idempotency conflicts are permanent and go to the DLQ', async () => {
    const wallet = await createWallet(c, '100.00');
    const command = body(wager({ playerId: wallet.playerId, amount: '30.00' }));
    await send(command);
    await send({ ...command, amount: '31.00' });
    expect(await consume(2)).toEqual(['processed', 'dead-lettered']);
    expect(await walletBalance(c, wallet.id)).toBe('70.00');
  });

  test('transient failures are retried; after maxReceiveCount the message goes to the DLQ', async () => {
    const wallet = await createWallet(c, '100.00');
    await send(body(wager({ playerId: wallet.playerId, amount: '30.00' })));

    // Hold the wallet row lock from another connection: the consumer hits lock_timeout (a real transient error).
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locker = c.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
      await held;
    });
    try {
      expect(await consume(1)).toEqual(['retry']);
      expect(await consume(1, 15_000)).toEqual(['dead-lettered']);
    } finally {
      release();
      await locker;
    }
    const dlq = await dlqMessages();
    expect(dlq[0]?.MessageAttributes?.FailureReason?.StringValue).toBe('RETRIES_EXHAUSTED');
    expect(await walletBalance(c, wallet.id)).toBe('100.00');
  });

  test('a transient failure followed by recovery is processed exactly once', async () => {
    const wallet = await createWallet(c, '100.00');
    await send(body(wager({ playerId: wallet.playerId, amount: '30.00' })));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locker = c.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
      await held;
    });
    expect(await consume(1)).toEqual(['retry']);
    release();
    await locker;
    expect(await consume(1, 15_000)).toEqual(['processed']);
    expect(await walletBalance(c, wallet.id)).toBe('70.00');
  });

  test('graceful shutdown: stop() waits for the in-flight batch and stops polling', async () => {
    const wallet = await createWallet(c, '100.00');
    c.consumer.start();
    await send(body(wager({ playerId: wallet.playerId, amount: '30.00' })));
    const deadline = Date.now() + 10_000;
    while ((await walletBalance(c, wallet.id)) !== '70.00' && Date.now() < deadline) await sleep(100);
    await c.consumer.stop();
    expect(await walletBalance(c, wallet.id)).toBe('70.00');

    // After stop, new messages stay on the queue.
    await send(body(wager({ playerId: wallet.playerId, amount: '1.00' })));
    await sleep(1500);
    expect(await walletBalance(c, wallet.id)).toBe('70.00');
  });
});
