import { resolveCurrency } from './currency';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Up to 16 integer digits and at most `scale` decimal digits. No sign, no exponent. */
const DECIMAL_PATTERN = /^(0|[1-9]\d{0,15})(\.\d+)?$/;

/**
 * Immutable monetary value.
 *
 * The amount is stored as an integer number of minor units (bigint), so no
 * floating point arithmetic ever happens. Input and output are decimal strings
 * ("10.50"). Numbers are rejected on purpose: a JS number may already have
 * lost precision before it reaches us.
 */
export class Money {
  private constructor(
    readonly minorUnits: bigint,
    readonly currency: string,
    private readonly scale: number,
  ) {
    Object.freeze(this);
  }

  static of(amount: string, currency: string): Money {
    const { scale } = resolveCurrency(currency);
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Amount must be a decimal string');
    }
    if (!DECIMAL_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`Invalid amount format: "${amount}"`);
    }
    const [integerPart = '0', decimals = ''] = amount.split('.');
    if (decimals.length > scale) {
      throw new InvalidMoneyError(`Amount "${amount}" exceeds ${scale} decimal places`);
    }
    const minor = BigInt(integerPart + decimals.padEnd(scale, '0'));
    return new Money(minor, currency, scale);
  }

  static zero(currency: string): Money {
    const { scale } = resolveCurrency(currency);
    return new Money(0n, currency, scale);
  }

  static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    const { scale } = resolveCurrency(currency);
    if (minorUnits < 0n) {
      throw new InvalidMoneyError('Money cannot be negative');
    }
    return new Money(minorUnits, currency, scale);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency, this.scale);
  }

  /** Throws if the result would be negative; callers must check `isGreaterThanOrEqual` first. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.minorUnits - other.minorUnits;
    if (result < 0n) {
      throw new InvalidMoneyError('Money cannot be negative');
    }
    return new Money(result, this.currency, this.scale);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits >= other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  /** Canonical decimal representation, always with `scale` decimals: "10.50". */
  toString(): string {
    const digits = this.minorUnits.toString().padStart(this.scale + 1, '0');
    if (this.scale === 0) return digits;
    return `${digits.slice(0, -this.scale)}.${digits.slice(-this.scale)}`;
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
