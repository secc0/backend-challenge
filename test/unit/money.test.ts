import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { CurrencyMismatchError, InvalidMoneyError, UnsupportedCurrencyError } from '../../src/domain/errors';

describe('Money', () => {
  test('parses decimal strings into exact minor units', () => {
    expect(Money.of('10.50', 'BRL').minorUnits).toBe(1050n);
    expect(Money.of('10.5', 'BRL').minorUnits).toBe(1050n);
    expect(Money.of('10', 'BRL').minorUnits).toBe(1000n);
    expect(Money.of('0.01', 'BRL').minorUnits).toBe(1n);
    expect(Money.of('9999999999999999.99', 'BRL').minorUnits).toBe(999999999999999999n);
  });

  test('always renders with the currency scale', () => {
    expect(Money.of('10.5', 'BRL').toString()).toBe('10.50');
    expect(Money.of('0', 'BRL').toString()).toBe('0.00');
    expect(Money.of('0.07', 'BRL').toString()).toBe('0.07');
    expect(JSON.stringify(Money.of('1', 'BRL'))).toBe('{"amount":"1.00","currency":"BRL"}');
  });

  test('does not suffer from floating point error', () => {
    const sum = Money.of('0.10', 'BRL').add(Money.of('0.20', 'BRL'));
    expect(sum.toString()).toBe('0.30');
    expect(sum.equals(Money.of('0.30', 'BRL'))).toBe(true);
  });

  test.each([['-1.00'], ['1.001'], ['1e3'], [' 1.00'], ['1,00'], ['01.00'], ['1.'], ['.5'], [''], ['abc'], ['NaN'], ['Infinity']])(
    'rejects invalid input %p',
    (input) => {
      expect(() => Money.of(input, 'BRL')).toThrow(InvalidMoneyError);
    },
  );

  test('rejects numbers (they may already have lost precision)', () => {
    expect(() => Money.of(10.5 as unknown as string, 'BRL')).toThrow(InvalidMoneyError);
  });

  test('rejects unsupported currencies', () => {
    expect(() => Money.of('1.00', 'USD')).toThrow(UnsupportedCurrencyError);
    expect(() => Money.of('1.00', 'XYZ')).toThrow(UnsupportedCurrencyError);
  });

  test('subtract never produces a negative amount', () => {
    expect(() => Money.of('1.00', 'BRL').subtract(Money.of('1.01', 'BRL'))).toThrow(InvalidMoneyError);
    expect(Money.of('1.00', 'BRL').subtract(Money.of('1.00', 'BRL')).isZero()).toBe(true);
  });

  test('is immutable', () => {
    const money = Money.of('1.00', 'BRL');
    money.add(Money.of('2.00', 'BRL'));
    expect(money.toString()).toBe('1.00');
    expect(Object.isFrozen(money)).toBe(true);
  });

  test('refuses arithmetic across currencies', () => {
    const brl = Money.of('1.00', 'BRL');
    const fake = Object.assign(Object.create(Object.getPrototypeOf(brl)), { minorUnits: 100n, currency: 'USD', scale: 2 });
    expect(() => brl.add(fake)).toThrow(CurrencyMismatchError);
  });
});
