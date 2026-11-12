import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import type { Container } from '../../container';
import { runWithContext } from '../../infrastructure/observability/request-context';
import { AppModule } from './app.module';
import { ErrorFilter } from './error.filter';

const CORRELATION_ID = /^[A-Za-z0-9._:\-]{1,128}$/;

export async function createHttpApp(container: Container): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(container), {
    logger: container.logger,
    bufferLogs: false,
  });

  // Correlation id: taken from the caller when well formed, generated otherwise,
  // echoed back and attached to every log line and outbox event of the request.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-correlation-id');
    const correlationId = incoming && CORRELATION_ID.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader('X-Correlation-Id', correlationId);

    const stopTimer = container.metrics.httpDuration.startTimer({ method: req.method });
    res.on('finish', () => {
      const route = (req.route?.path as string | undefined) ?? 'unmatched';
      stopTimer({ route, status: String(res.statusCode) });
    });

    runWithContext({ correlationId }, () => next());
  });

  app.useGlobalFilters(new ErrorFilter(container.logger));
  return app;
}
