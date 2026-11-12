import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { CreateWallet } from './application/create-wallet';
import { WalletQueries } from './application/queries';
import { Reconciliation } from './application/reconciliation';
import { ResolvePendingReferences } from './application/resolve-pending-references';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { WagerEngine } from './application/wager-engine';
import type { AppConfig } from './config';
import { Database } from './infrastructure/database/database';
import { rootLogger, type JsonLogger } from './infrastructure/observability/logger';
import { Metrics } from './infrastructure/observability/metrics';
import { InboxRepository } from './infrastructure/persistence/inbox.repository';
import { OutboxRepository } from './infrastructure/persistence/outbox.repository';
import { WagerTransactionRepository } from './infrastructure/persistence/wager-transaction.repository';
import { WalletRepository } from './infrastructure/persistence/wallet.repository';
import { OutboxPublisher } from './infrastructure/sqs/outbox-publisher';
import { createSqsClient, ensureQueues, resolveQueueUrls, type QueueUrls } from './infrastructure/sqs/sqs';
import { WagerConsumer, type ConsumerHooks } from './infrastructure/sqs/wager-consumer';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';

/**
 * Composition root. Plain object wiring keeps the application and domain
 * layers free of framework decorators and lets tests build the exact same
 * graph without booting Nest.
 */
export interface Container {
  config: AppConfig;
  db: Database;
  sqs: SQSClient;
  queues: QueueUrls;
  metrics: Metrics;
  logger: JsonLogger;
  repositories: {
    wallets: WalletRepository;
    transactions: WagerTransactionRepository;
    outbox: OutboxRepository;
    inbox: InboxRepository;
  };
  submitWager: SubmitWagerTransaction;
  createWallet: CreateWallet;
  queries: WalletQueries;
  reconciliation: Reconciliation;
  resolvePendingReferences: ResolvePendingReferences;
  consumer: WagerConsumer;
  outboxPublisher: OutboxPublisher;
  pendingReferenceWorker: PendingReferenceWorker;
  /** Resolves when the wager queue is reachable (readiness probe). */
  sqsReady(): Promise<void>;
  close(): Promise<void>;
}

export interface ContainerOptions {
  /** Create the queues if they do not exist (tests, local runs). */
  ensureQueues?: boolean;
  consumerHooks?: ConsumerHooks;
  clock?: () => Date;
  metrics?: Metrics;
}

export async function buildContainer(config: AppConfig, options: ContainerOptions = {}): Promise<Container> {
  const logger = rootLogger.child({ instance: config.instanceId });
  const metrics = options.metrics ?? new Metrics();
  const clock = options.clock ?? (() => new Date());

  const db = await Database.connect(config.database);
  const sqs = createSqsClient(config.sqs);
  const queues = options.ensureQueues ? await ensureQueues(sqs, config.sqs) : await resolveQueueUrls(sqs, config.sqs);

  const wallets = new WalletRepository();
  const transactions = new WagerTransactionRepository();
  const outbox = new OutboxRepository();
  const inbox = new InboxRepository();

  const engine = new WagerEngine(wallets, transactions, outbox, config.pendingReference);
  const submitWager = new SubmitWagerTransaction(db, wallets, transactions, inbox, engine, metrics, logger, clock);
  const createWallet = new CreateWallet(db, wallets, transactions, outbox, clock);
  const queries = new WalletQueries(db, wallets, transactions);
  const reconciliation = new Reconciliation(db);
  const resolvePendingReferences = new ResolvePendingReferences(
    db,
    wallets,
    transactions,
    engine,
    metrics,
    logger,
    config.pendingReference.batchSize,
    clock,
  );

  const consumer = new WagerConsumer(sqs, queues.wager, queues.dlq, submitWager, config.sqs, metrics, logger, options.consumerHooks);
  const outboxPublisher = new OutboxPublisher(db, outbox, sqs, queues.events, config.outbox, metrics, logger);
  const pendingReferenceWorker = new PendingReferenceWorker(resolvePendingReferences, config.pendingReference.pollIntervalMs, logger);

  return {
    config,
    db,
    sqs,
    queues,
    metrics,
    logger,
    repositories: { wallets, transactions, outbox, inbox },
    submitWager,
    createWallet,
    queries,
    reconciliation,
    resolvePendingReferences,
    consumer,
    outboxPublisher,
    pendingReferenceWorker,
    async sqsReady() {
      await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queues.wager, AttributeNames: ['QueueArn'] }));
    },
    async close() {
      await Promise.all([consumer.stop(), outboxPublisher.stop(), pendingReferenceWorker.stop()]);
      sqs.destroy();
      await db.close();
    },
  };
}
