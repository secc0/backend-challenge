import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import {
  IdempotencyConflictError,
  NotFoundError,
  TransientError,
  ValidationError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import { DomainError } from '../../domain/errors';
import { transientKind } from '../../infrastructure/database/db-errors';
import type { JsonLogger } from '../../infrastructure/observability/logger';
import { currentCorrelationId } from '../../infrastructure/observability/request-context';

/**
 * Maps errors to responses. The status code alone tells the client what to do:
 *   400 invalid payload (fix it) · 404 not found · 409 idempotency conflict (do not retry)
 *   422 business rejection (sent with the transaction body by the controller)
 *   503 transient failure (retry with the same Idempotency-Key)
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId = currentCorrelationId();
    const send = (status: number, body: Record<string, unknown>) => {
      res.status(status).json({ ...body, correlationId });
    };

    if (error instanceof ValidationError) {
      return send(400, { error: error.code, message: error.message, details: error.details });
    }
    if (error instanceof DomainError) {
      return send(400, { error: 'VALIDATION_ERROR', message: error.message, details: [{ path: '(root)', message: error.code }] });
    }
    if (error instanceof NotFoundError) {
      return send(404, { error: error.code, message: error.message });
    }
    if (error instanceof IdempotencyConflictError) {
      return send(409, { error: error.code, message: error.message, existingTransactionId: error.existingTransactionId });
    }
    if (error instanceof WalletAlreadyExistsError) {
      return send(409, { error: error.code, message: error.message, walletId: error.walletId });
    }
    if (error instanceof TransientError || transientKind(error)) {
      const reason = error instanceof TransientError ? error.reason : transientKind(error);
      this.logger.warn('transient failure', { reason }, error as Error);
      res.setHeader('Retry-After', '1');
      return send(503, { error: 'TRANSIENT_FAILURE', message: 'Temporary failure, retry with the same Idempotency-Key', reason });
    }
    if (error instanceof HttpException) {
      const status = error.getStatus();
      // Body parser errors (malformed JSON, too large) arrive here as 4xx HttpExceptions.
      if (status >= 400 && status < 500) {
        return send(status, { error: status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR', message: error.message });
      }
      return send(status, { error: 'HTTP_ERROR', message: error.message });
    }

    this.logger.error('unhandled error', error as Error);
    send(500, { error: 'INTERNAL_ERROR', message: 'Unexpected error' });
  }
}
