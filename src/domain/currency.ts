import { UnsupportedCurrencyError } from './errors';

/**
 * Currency metadata. The model supports any ISO-4217 currency with a minor-unit
 * scale, but only the currencies listed in SUPPORTED_CURRENCIES are accepted
 * at the boundary. Today that is BRL only.
 */
export interface CurrencyDefinition {
  readonly code: string;
  readonly scale: number;
}

const KNOWN_CURRENCIES: Record<string, CurrencyDefinition> = {
  BRL: { code: 'BRL', scale: 2 },
  USD: { code: 'USD', scale: 2 },
  EUR: { code: 'EUR', scale: 2 },
};

export const SUPPORTED_CURRENCIES: readonly string[] = ['BRL'];

export function resolveCurrency(code: string): CurrencyDefinition {
  const definition = KNOWN_CURRENCIES[code];
  if (!definition || !SUPPORTED_CURRENCIES.includes(code)) {
    throw new UnsupportedCurrencyError(`Unsupported currency: ${code}`);
  }
  return definition;
}

export function isSupportedCurrency(code: string): boolean {
  return SUPPORTED_CURRENCIES.includes(code) && code in KNOWN_CURRENCIES;
}
