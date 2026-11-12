import { describe, expect, test } from 'bun:test';
import { canonicalJson, payloadHash } from '../../src/application/canonical-json';
import { parseSubmitWager } from '../../src/application/commands';
import { ValidationError } from '../../src/application/errors';
import { hashOf } from '../../src/application/submit-wager-transaction';

const valid = {
  provider: 'prov',
  externalId: 'tx-1',
  playerId: 'p1',
  currency: 'BRL',
  roundId: 'r1',
  type: 'BET',
  amount: '10.00',
};

describe('canonical JSON', () => {
  test('is independent of key order and whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  test('drops undefined members', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe('idempotency fingerprint', () => {
  const command = { ...valid, type: 'BET' as const, idempotencyKey: 'k1' };

  test('ignores the idempotency key itself and key order', () => {
    expect(hashOf(command)).toBe(hashOf({ ...command, idempotencyKey: 'k2' }));
  });

  test('normalizes equivalent amounts', () => {
    expect(hashOf({ ...command, amount: '10' })).toBe(hashOf({ ...command, amount: '10.00' }));
  });

  test('changes with any business field', () => {
    expect(hashOf({ ...command, amount: '10.01' })).not.toBe(hashOf(command));
    expect(hashOf({ ...command, roundId: 'r2' })).not.toBe(hashOf(command));
    expect(hashOf({ ...command, playerId: 'p2' })).not.toBe(hashOf(command));
  });
});

describe('payload validation', () => {
  const issues = (body: unknown, key: unknown = 'key-1') => {
    try {
      parseSubmitWager(body, key);
      return [];
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      return (error as ValidationError).details.map((d) => d.path);
    }
  };

  test('accepts a valid BET', () => {
    expect(parseSubmitWager(valid, 'key-1')).toMatchObject({ ...valid, idempotencyKey: 'key-1' });
  });

  test('requires the Idempotency-Key header', () => {
    expect(() => parseSubmitWager(valid, undefined)).toThrow(ValidationError);
    expect(issues(valid, '')).toEqual(['Idempotency-Key']);
    expect(issues(valid, 'with space')).toEqual(['Idempotency-Key']);
  });

  test('amount must be a string with at most 2 decimals', () => {
    expect(issues({ ...valid, amount: 10.5 })).toEqual(['amount']);
    expect(issues({ ...valid, amount: '10.555' })).toEqual(['amount']);
    expect(issues({ ...valid, amount: '-1.00' })).toEqual(['amount']);
    expect(issues({ ...valid, amount: '0.00' })).toEqual(['amount']);
  });

  test('currency must be supported', () => {
    expect(issues({ ...valid, currency: 'USD' })).toEqual(['currency']);
  });

  test('unknown fields are rejected', () => {
    expect(issues({ ...valid, bonus: true })).toEqual(['(root)']);
  });

  test('reference rules', () => {
    expect(issues({ ...valid, type: 'REFUND' })).toEqual(['referenceExternalId']);
    expect(issues({ ...valid, referenceExternalId: 'x' })).toEqual(['referenceExternalId']);
    expect(issues({ ...valid, type: 'LOSS', amount: '1.00' })).toEqual(['amount']);
    expect(issues({ ...valid, type: 'LOSS', amount: '0.00' })).toEqual([]);
  });

  test('OPENING cannot be submitted by providers', () => {
    expect(issues({ ...valid, type: 'OPENING' })).toEqual(['type']);
  });
});
