import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  correlationId: string;
  [key: string]: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with a correlation context that every log line inside it will carry. */
export function runWithContext<T>(context: Partial<RequestContext>, fn: () => T): T {
  const merged: RequestContext = { ...context, correlationId: context.correlationId ?? randomUUID() };
  return storage.run(merged, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | null {
  return storage.getStore()?.correlationId ?? null;
}
