import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config';

export function createSqsClient(settings: AppConfig['sqs']): SQSClient {
  return new SQSClient({
    region: settings.region,
    endpoint: settings.endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

export interface QueueUrls {
  wager: string;
  dlq: string;
  events: string;
}

export async function resolveQueueUrls(client: SQSClient, settings: AppConfig['sqs']): Promise<QueueUrls> {
  const url = async (name: string) => {
    const result = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!result.QueueUrl) throw new Error(`Queue ${name} not found`);
    return result.QueueUrl;
  };
  return {
    wager: await url(settings.wagerQueueName),
    dlq: await url(settings.wagerDlqName),
    events: await url(settings.eventsQueueName),
  };
}

/**
 * Idempotently creates the queues: the FIFO wager queue with a redrive policy
 * to its FIFO DLQ, and the standard queue that receives published events.
 */
export async function ensureQueues(client: SQSClient, settings: AppConfig['sqs']): Promise<QueueUrls> {
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: settings.wagerDlqName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: '1209600' },
    }),
  );
  const dlqAttributes = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  const wager = await client.send(
    new CreateQueueCommand({
      QueueName: settings.wagerQueueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(settings.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqAttributes.Attributes?.QueueArn,
          maxReceiveCount: String(settings.maxReceiveCount),
        }),
      },
    }),
  );
  const events = await client.send(new CreateQueueCommand({ QueueName: settings.eventsQueueName }));
  return { wager: wager.QueueUrl!, dlq: dlq.QueueUrl!, events: events.QueueUrl! };
}
