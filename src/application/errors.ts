/** Errors the application layer exposes to its adapters (HTTP, SQS). */

export class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';

  constructor(
    message: string,
    readonly details: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Same idempotency key (or same provider transaction id) with a different payload. */
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(
    message: string,
    readonly existingTransactionId: string,
  ) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

/** Infrastructure failure that is safe to retry (lock timeout, deadlock, DB/queue unavailable). */
export class TransientError extends Error {
  readonly code = 'TRANSIENT_FAILURE';

  constructor(
    message: string,
    readonly reason: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientError';
  }
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(readonly walletId: string) {
    super('A wallet already exists for this player and currency');
    this.name = 'WalletAlreadyExistsError';
  }
}
