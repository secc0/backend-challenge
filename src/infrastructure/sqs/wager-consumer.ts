import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { parseSubmitWager } from '../../application/commands';
import { IdempotencyConflictError, TransientError, ValidationError } from '../../application/errors';
import type { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import type { AppConfig } from '../../config';
import { DomainError } from '../../domain/errors';
import type { JsonLogger } from '../observability/logger';
import type { Metrics } from '../observability/metrics';
import { runWithContext } from '../observability/request-context';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

export type MessageResult = 'processed' | 'duplicate' | 'retry' | 'dead-lettered';

export interface ConsumerHooks {
  /** Test hook: runs after the SQL commit and before the message is deleted (simulates a crash there). */
  afterCommit?: (message: Message) => Promise<void> | void;
}

/**
 * SQS consumer of provider transactions.
 *
 *  - reuses the same use case as the HTTP API;
 *  - de-duplicates through the persistent inbox (consumer, messageId) written
 *    in the same SQL transaction as the financial change;
 *  - deletes (acks) the message only after the commit;
 *  - business rejections are a normal outcome: committed and acked;
 *  - permanent errors (invalid payload, idempotency conflict) go straight to the DLQ;
 *  - transient errors are left on the queue with a growing visibility timeout,
 *    up to `maxReceiveCount` receives, then moved to the DLQ.
 *
 * Expected message body: the same JSON as POST /transactions, plus
 * `idempotencyKey` (or the `IdempotencyKey` message attribute). When absent,
 * the key defaults to `${provider}:${externalId}`.
 */
export class WagerConsumer {
  private running = false;
  private loop: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
    private readonly useCase: SubmitWagerTransaction,
    private readonly settings: AppConfig['sqs'],
    private readonly metrics: Metrics,
    private readonly logger: JsonLogger,
    private readonly hooks: ConsumerHooks = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info('wager consumer started', { queue: this.queueUrl });
  }

  /** Graceful shutdown: stop receiving, let in-flight messages finish, then return. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    await this.loop;
    this.logger.info('wager consumer stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break;
        this.logger.error('wager consumer poll failed', error as Error);
        await sleep(1000);
      }
    }
  }

  /** Receives one batch and handles it. Public for tests. */
  async pollOnce(waitTimeSeconds = this.settings.waitTimeSeconds): Promise<MessageResult[]> {
    this.abort = new AbortController();
    let messages: Message[];
    try {
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: this.settings.batchSize,
          WaitTimeSeconds: waitTimeSeconds,
          VisibilityTimeout: this.settings.visibilityTimeoutSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          MessageAttributeNames: ['All'],
        }),
        { abortSignal: this.abort.signal },
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.abort.signal.aborted) return [];
      throw error;
    }

    // Messages of a batch are processed sequentially: FIFO hands us one message
    // group's messages in order and we keep that order.
    const results: MessageResult[] = [];
    for (const message of messages) results.push(await this.handle(message));
    return results;
  }

  async handle(message: Message): Promise<MessageResult> {
    const messageId = message.MessageId ?? randomUUID();
    const correlationId = message.MessageAttributes?.CorrelationId?.StringValue ?? messageId;
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    return runWithContext({ correlationId, messageId }, async () => {
      try {
        const command = this.parse(message);
        const result = await this.useCase.execute(command, {
          channel: 'sqs',
          correlationId,
          inbox: { consumer: WAGER_CONSUMER_NAME, messageId },
        });
        await this.hooks.afterCommit?.(message);
        await this.delete(message);
        const outcome: MessageResult = result.replayed ? 'duplicate' : 'processed';
        this.metrics.sqsMessages.inc({ result: outcome });
        return outcome;
      } catch (error) {
        return this.handleFailure(message, error, receiveCount);
      }
    });
  }

  private parse(message: Message): ReturnType<typeof parseSubmitWager> {
    let body: unknown;
    try {
      body = JSON.parse(message.Body ?? '');
    } catch {
      throw new ValidationError('Message body is not valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Message body must be a JSON object');
    }
    const { idempotencyKey, ...payload } = body as Record<string, unknown>;
    const key =
      idempotencyKey ??
      message.MessageAttributes?.IdempotencyKey?.StringValue ??
      (typeof payload.provider === 'string' && typeof payload.externalId === 'string'
        ? `${payload.provider}:${payload.externalId}`
        : undefined);
    return parseSubmitWager(payload, key);
  }

  private async handleFailure(message: Message, error: unknown, receiveCount: number): Promise<MessageResult> {
    const permanent =
      error instanceof ValidationError || error instanceof IdempotencyConflictError || error instanceof DomainError;

    if (permanent) {
      const reason = (error as { code?: string }).code ?? 'PERMANENT_ERROR';
      this.logger.warn('permanent failure, moving message to DLQ', { reason, error: (error as Error).message });
      await this.deadLetter(message, reason, error as Error);
      return 'dead-lettered';
    }

    // Transient (or unknown) failure: nothing was committed, the message will be redelivered.
    if (receiveCount >= this.settings.maxReceiveCount) {
      this.logger.error('retry budget exhausted, moving message to DLQ', { receiveCount }, error as Error);
      await this.deadLetter(message, 'RETRIES_EXHAUSTED', error as Error);
      return 'dead-lettered';
    }
    this.metrics.sqsRetries.inc();
    this.metrics.sqsMessages.inc({ result: 'retry' });
    const reason = error instanceof TransientError ? error.reason : 'unexpected';
    this.logger.warn('transient failure, message will be redelivered', { receiveCount, reason }, error as Error);
    const backoffSeconds = Math.min(2 ** receiveCount, 60);
    try {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: backoffSeconds,
        }),
      );
    } catch (visibilityError) {
      this.logger.warn('could not change message visibility', visibilityError as Error);
    }
    return 'retry';
  }

  private async deadLetter(message: Message, reason: string, error: Error): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId ?? randomUUID(),
        MessageAttributes: {
          FailureReason: { DataType: 'String', StringValue: reason },
          FailureMessage: { DataType: 'String', StringValue: error.message.slice(0, 1000) || 'n/a' },
          OriginalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
        },
      }),
    );
    await this.delete(message);
    this.metrics.sqsDlq.inc({ reason });
    this.metrics.sqsMessages.inc({ result: 'dead_lettered' });
  }

  private async delete(message: Message): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
