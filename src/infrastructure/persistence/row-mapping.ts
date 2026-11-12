import { Money } from '../../domain/money';

/**
 * The pg driver returns NUMERIC / BIGINT as strings (we never let them become
 * JS numbers) and, through MikroORM, timestamps as strings too.
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') throw new Error(`Unexpected timestamp value: ${String(value)}`);
  // "2026-11-11 23:53:36.411301+00" -> "2026-11-11T23:53:36.411+00:00"
  const iso = value
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Unparseable timestamp: ${value}`);
  return date;
}

export function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

export function toMoney(value: unknown, currency: string): Money {
  return Money.of(String(value), currency.trim());
}

export function toMoneyOrNull(value: unknown, currency: string): Money | null {
  return value === null || value === undefined ? null : toMoney(value, currency);
}

export function toInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Unsafe integer: ${String(value)}`);
  return parsed;
}
