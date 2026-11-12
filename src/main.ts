import 'reflect-metadata';
import { loadConfig } from './config';
import { buildContainer } from './container';
import { rootLogger } from './infrastructure/observability/logger';
import { createHttpApp } from './interfaces/http/http-app';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const container = await buildContainer(config, { ensureQueues: process.env.SQS_ENSURE_QUEUES === 'true' });
  const app = await createHttpApp(container);
  await app.listen(config.port);
  container.logger.info('http server listening', { port: config.port, workers: [...config.workers] });

  if (config.workers.has('consumer')) container.consumer.start();
  if (config.workers.has('outbox')) container.outboxPublisher.start();
  if (config.workers.has('pending-reference')) container.pendingReferenceWorker.start();

  // Graceful shutdown: stop accepting requests, let in-flight work finish
  // (messages not yet acked will simply be redelivered), close the pool.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.logger.info('shutting down', { signal });
    const forceExit = setTimeout(() => {
      container.logger.error('graceful shutdown timed out, exiting');
      process.exit(1);
    }, 25_000);
    try {
      await container.consumer.stop();
      await app.close();
      await container.close();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      container.logger.error('error during shutdown', error as Error);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  rootLogger.error('failed to start', error as Error);
  process.exit(1);
});
