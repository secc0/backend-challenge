import type { DomainEvent, EventEnvelope } from '../../domain/events';
import type { SqlExecutor } from '../database/database';
import { toInt } from './row-mapping';

export interface OutboxRecord {
  id: string;
  eventType: string;
  aggregateId: string;
  envelope: EventEnvelope;
  attempts: number;
}

export class OutboxRepository {
  /** Must be called inside the same SQL transaction as the state change the events describe. */
  async append(sql: SqlExecutor, events: readonly DomainEvent[], correlationId: string | null): Promise<void> {
    for (const event of events) {
      const envelope = event.toEnvelope(correlationId);
      await sql.query(
        `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, occurred_at)
         VALUES (?, ?, ?, ?, CAST(? AS jsonb), ?)`,
        [event.eventId, event.aggregateType, event.aggregateId, event.eventType, JSON.stringify(envelope), event.occurredAt],
      );
    }
  }

  /**
   * Locks a batch of due, unpublished events. Rows locked by another publisher
   * are skipped, so concurrent publishers never send the same row at the same time.
   */
  async claimBatch(sql: SqlExecutor, limit: number): Promise<OutboxRecord[]> {
    const rows = await sql.query(
      `SELECT id, event_type, aggregate_id, payload::text AS payload, attempts
       FROM outbox_events
       WHERE published_at IS NULL AND next_attempt_at <= now()
       ORDER BY position
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows.map((row) => ({
      id: String(row.id),
      eventType: String(row.event_type),
      aggregateId: String(row.aggregate_id),
      envelope: JSON.parse(String(row.payload)) as EventEnvelope,
      attempts: toInt(row.attempts),
    }));
  }

  async markPublished(sql: SqlExecutor, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await sql.query(
      `UPDATE outbox_events SET published_at = now(), attempts = attempts + 1, last_error = NULL
       WHERE id IN (${ids.map(() => '?').join(', ')})`,
      [...ids],
    );
  }

  async markFailed(sql: SqlExecutor, id: string, error: string, backoffMs: number): Promise<void> {
    await sql.query(
      `UPDATE outbox_events
       SET attempts = attempts + 1, last_error = ?, next_attempt_at = now() + (? * interval '1 millisecond')
       WHERE id = ?`,
      [error.slice(0, 2000), backoffMs, id],
    );
  }

  /** Number of unpublished events and age (seconds) of the oldest one. */
  async lag(sql: SqlExecutor): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const rows = await sql.query(
      `SELECT count(*)::text AS pending,
              COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)), 0)::text AS age
       FROM outbox_events WHERE published_at IS NULL`,
    );
    const row = rows[0] ?? { pending: '0', age: '0' };
    return { pending: toInt(row.pending), oldestAgeSeconds: Number(row.age) };
  }
}
