/**
 * Classification of PostgreSQL / driver errors. MikroORM wraps driver errors,
 * so we look at the error and its causes for a SQLSTATE code.
 */
function* chain(error: unknown): Generator<Record<string, unknown>> {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    yield current as Record<string, unknown>;
    const record = current as Record<string, unknown>;
    current = record.cause ?? record.previous ?? record.originalError;
  }
}

export function sqlState(error: unknown): string | undefined {
  for (const item of chain(error)) {
    const code = item.code ?? item.sqlState;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

export function constraintName(error: unknown): string | undefined {
  for (const item of chain(error)) {
    if (typeof item.constraint === 'string') return item.constraint;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown, constraints?: readonly string[]): boolean {
  if (sqlState(error) !== '23505') return false;
  if (!constraints) return true;
  const name = constraintName(error);
  return name !== undefined && constraints.includes(name);
}

export type TransientKind = 'lock_timeout' | 'deadlock' | 'serialization' | 'statement_timeout' | 'connection';

const TRANSIENT_STATES: Record<string, TransientKind> = {
  '55P03': 'lock_timeout',
  '40P01': 'deadlock',
  '40001': 'serialization',
  '57014': 'statement_timeout',
  '53300': 'connection',
  '57P01': 'connection',
  '57P02': 'connection',
  '57P03': 'connection',
};

const CONNECTION_MESSAGES = [/ECONNREFUSED/, /ECONNRESET/, /ETIMEDOUT/, /Connection terminated/i, /connect.*timeout/i, /Knex: Timeout acquiring a connection/i];

export function transientKind(error: unknown): TransientKind | undefined {
  const state = sqlState(error);
  if (state) {
    if (state.startsWith('08')) return 'connection';
    return TRANSIENT_STATES[state];
  }
  for (const item of chain(error)) {
    const message = typeof item.message === 'string' ? item.message : '';
    const code = typeof item.code === 'string' ? item.code : '';
    if (CONNECTION_MESSAGES.some((pattern) => pattern.test(message) || pattern.test(code))) return 'connection';
  }
  return undefined;
}
