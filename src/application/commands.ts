import { z } from 'zod';
import { isSupportedCurrency, SUPPORTED_CURRENCIES } from '../domain/currency';
import { PROVIDER_WAGER_KINDS, type ProviderWagerKind } from '../domain/wager-transaction';
import { ValidationError } from './errors';

const identifier = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9._:\-]+$/, 'only letters, digits and . _ : - are allowed');

/** Decimal string with at most two decimals. Numbers are refused to avoid float rounding upstream. */
const decimalString = z
  .string({ invalid_type_error: 'amount must be a decimal string, e.g. "10.50"' })
  .regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/, 'amount must be a non-negative decimal with up to 2 decimals');

const currency = z
  .string()
  .refine(isSupportedCurrency, { message: `currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}` });

export const submitWagerSchema = z
  .object({
    provider: identifier(64),
    externalId: identifier(128),
    playerId: identifier(128),
    currency,
    roundId: identifier(128),
    type: z.enum(PROVIDER_WAGER_KINDS),
    amount: decimalString,
    referenceExternalId: identifier(128).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isReversal = value.type === 'REFUND' || value.type === 'ROLLBACK';
    if (isReversal && !value.referenceExternalId) {
      ctx.addIssue({ code: 'custom', path: ['referenceExternalId'], message: `required for ${value.type}` });
    }
    if (!isReversal && value.referenceExternalId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['referenceExternalId'], message: `not allowed for ${value.type}` });
    }
    const isZero = /^0(\.0{1,2})?$/.test(value.amount);
    if (value.type === 'LOSS' && !isZero) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'LOSS amount must be 0.00' });
    }
    if (value.type !== 'LOSS' && isZero) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: `${value.type} amount must be greater than zero` });
    }
  });

export type SubmitWagerPayload = z.infer<typeof submitWagerSchema>;

export interface SubmitWagerCommand extends SubmitWagerPayload {
  type: ProviderWagerKind;
  idempotencyKey: string;
}

export const idempotencyKeySchema = z.string().min(1).max(255).regex(/^[\x21-\x7E]+$/, 'printable ASCII only');

export const createWalletSchema = z
  .object({
    playerId: identifier(128),
    currency,
    openingBalance: decimalString.optional(),
  })
  .strict();

export type CreateWalletCommand = z.infer<typeof createWalletSchema>;

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      'Invalid payload',
      result.error.issues.map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message })),
    );
  }
  return result.data;
}

export function parseSubmitWager(body: unknown, idempotencyKey: unknown): SubmitWagerCommand {
  const keyResult = idempotencyKeySchema.safeParse(idempotencyKey);
  if (!keyResult.success) {
    throw new ValidationError('Invalid payload', [
      { path: 'Idempotency-Key', message: idempotencyKey ? 'invalid idempotency key' : 'header is required' },
    ]);
  }
  const payload = parseOrThrow(submitWagerSchema, body);
  return { ...payload, idempotencyKey: keyResult.data };
}
