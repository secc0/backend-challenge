import type { LoggerService } from '@nestjs/common';
import { currentContext } from './request-context';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Fields that must never reach the logs. Logs carry identifiers (transaction,
 * wallet, correlation) but not amounts, balances or raw payloads.
 */
const REDACTED_KEYS = new Set(['amount', 'balance', 'balanceAfter', 'balanceBefore', 'payload', 'body', 'authorization']);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: (value as { code?: unknown }).code };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return output;
}

/** Structured JSON logger, one line per event, enriched with the correlation context. */
export class JsonLogger implements LoggerService {
  private readonly threshold: number;

  constructor(
    private readonly baseFields: Record<string, unknown> = {},
    level: string = process.env.LOG_LEVEL ?? 'info',
  ) {
    this.threshold = LEVELS[(level as Level)] ?? LEVELS.info;
  }

  child(fields: Record<string, unknown>): JsonLogger {
    const child = new JsonLogger({ ...this.baseFields, ...fields });
    (child as unknown as { threshold: number }).threshold = this.threshold;
    return child;
  }

  debug(message: unknown, ...rest: unknown[]): void { this.write('debug', message, rest); }
  log(message: unknown, ...rest: unknown[]): void { this.write('info', message, rest); }
  info(message: unknown, ...rest: unknown[]): void { this.write('info', message, rest); }
  warn(message: unknown, ...rest: unknown[]): void { this.write('warn', message, rest); }
  error(message: unknown, ...rest: unknown[]): void { this.write('error', message, rest); }
  verbose(message: unknown, ...rest: unknown[]): void { this.write('debug', message, rest); }

  private write(level: Level, message: unknown, rest: unknown[]): void {
    if (LEVELS[level] < this.threshold) return;
    const fields: Record<string, unknown> = {};
    for (const item of rest) {
      if (item instanceof Error) fields.error = redact(item);
      else if (typeof item === 'string') fields.context = item; // Nest passes the context name as a string
      else if (item && typeof item === 'object') Object.assign(fields, redact(item));
    }
    const line = {
      time: new Date().toISOString(),
      level,
      msg: typeof message === 'string' ? message : JSON.stringify(redact(message)),
      ...this.baseFields,
      ...currentContext(),
      ...fields,
    };
    const output = JSON.stringify(line);
    if (LEVELS[level] >= LEVELS.warn) process.stderr.write(`${output}\n`);
    else process.stdout.write(`${output}\n`);
  }
}

export const rootLogger = new JsonLogger({ service: 'wagering-processor', instance: process.env.INSTANCE_ID ?? String(process.pid) });
