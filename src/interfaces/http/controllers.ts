import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createWalletSchema, parseOrThrow, parseSubmitWager } from '../../application/commands';
import { NotFoundError, ValidationError } from '../../application/errors';
import type { Container } from '../../container';
import { currentCorrelationId } from '../../infrastructure/observability/request-context';
import { Public } from './auth.guard';
import { presentLedgerEntry, presentTransaction, presentWallet, statusCodeFor } from './presenters';

export const CONTAINER = Symbol('CONTAINER');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(id: string, what: string): void {
  if (!UUID.test(id)) throw new NotFoundError(`${what} ${id} not found`);
}

@Controller('wallets')
export class WalletsController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const command = parseOrThrow(createWalletSchema, body);
    const wallet = await this.c.createWallet.execute(command, currentCorrelationId());
    return presentWallet(wallet);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    assertUuid(id, 'Wallet');
    return presentWallet(await this.c.queries.wallet(id));
  }

  @Get(':id/ledger')
  async ledger(@Param('id') id: string, @Query('limit') limitRaw?: string, @Query('cursor') cursor?: string) {
    assertUuid(id, 'Wallet');
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ValidationError('Invalid query', [{ path: 'limit', message: 'must be an integer between 1 and 500' }]);
    }
    const page = await this.c.queries.ledger(id, { limit, cursor });
    return { items: page.items.map(presentLedgerEntry), nextCursor: page.nextCursor };
  }

  @Get(':id/reconciliation')
  async reconcile(@Param('id') id: string) {
    assertUuid(id, 'Wallet');
    await this.c.queries.wallet(id);
    return this.c.reconciliation.run(id);
  }
}

@Controller()
export class TransactionsController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post('transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const command = parseSubmitWager(body, idempotencyKey);
    const result = await this.c.submitWager.execute(command, { channel: 'http', correlationId: currentCorrelationId() });
    res.status(statusCodeFor(result.transaction));
    res.setHeader('Idempotent-Replayed', String(result.replayed));
    res.setHeader('Location', `/transactions/${result.transaction.id}`);
    return presentTransaction(result.transaction);
  }

  @Get('transactions/:id')
  async get(@Param('id') id: string) {
    assertUuid(id, 'Transaction');
    return presentTransaction(await this.c.queries.transaction(id));
  }

  @Get('providers/:provider/transactions/:externalId')
  async getByProviderId(@Param('provider') provider: string, @Param('externalId') externalId: string) {
    return presentTransaction(await this.c.queries.transactionByProviderId(provider, externalId));
  }

  @Get('reconciliation')
  async reconcileAll(@Query('walletId') walletId?: string) {
    if (walletId !== undefined) assertUuid(walletId, 'Wallet');
    return this.c.reconciliation.run(walletId);
  }
}

@Controller()
export class OperationsController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  /** Liveness: the process is up and the event loop responds. No dependencies checked. */
  @Public()
  @Get('health/live')
  live() {
    return { status: 'ok', instance: this.c.config.instanceId };
  }

  /** Readiness: dependencies needed to serve traffic are reachable. */
  @Public()
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, string> = {};
    await Promise.all([
      this.c.db.ping().then(
        () => (checks.database = 'up'),
        () => (checks.database = 'down'),
      ),
      this.c.sqsReady().then(
        () => (checks.sqs = 'up'),
        () => (checks.sqs = 'down'),
      ),
    ]);
    const ok = Object.values(checks).every((value) => value === 'up');
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'unavailable', checks };
  }

  @Public()
  @Get('metrics')
  async metrics(@Res() res: Response) {
    res.setHeader('Content-Type', this.c.metrics.registry.contentType);
    res.send(await this.c.metrics.registry.metrics());
  }
}
