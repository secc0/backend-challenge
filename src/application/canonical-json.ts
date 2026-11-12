import { createHash } from 'node:crypto';

/**
 * Canonical JSON (RFC 8785 style, for the value types we accept): object keys
 * sorted by code point, no insignificant whitespace, `undefined` members
 * dropped. Two payloads that differ only in key order or formatting produce
 * the same string, and therefore the same hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers are not valid JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported JSON value: ${typeof value}`);
}

/** SHA-256 (hex) of the canonical JSON representation. */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
