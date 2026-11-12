import type { SqlExecutor } from '../database/database';

/**
 * Persistent de-duplication of consumed messages, keyed by (consumer, messageId).
 * Recorded in the same SQL transaction as the financial change.
 */
export class InboxRepository {
  /** Returns false when the message was already recorded (i.e. this is a redelivery). */
  async tryRecord(sql: SqlExecutor, consumer: string, messageId: string): Promise<boolean> {
    const rows = await sql.query(
      `INSERT INTO inbox_messages (consumer, message_id) VALUES (?, ?)
       ON CONFLICT (consumer, message_id) DO NOTHING
       RETURNING message_id`,
      [consumer, messageId],
    );
    return rows.length === 1;
  }

  async attachTransaction(sql: SqlExecutor, consumer: string, messageId: string, transactionId: string): Promise<void> {
    await sql.query(
      `UPDATE inbox_messages SET transaction_id = ? WHERE consumer = ? AND message_id = ?`,
      [transactionId, consumer, messageId],
    );
  }

  async findTransactionId(sql: SqlExecutor, consumer: string, messageId: string): Promise<string | null> {
    const rows = await sql.query(
      `SELECT transaction_id FROM inbox_messages WHERE consumer = ? AND message_id = ?`,
      [consumer, messageId],
    );
    return (rows[0]?.transaction_id as string | null | undefined) ?? null;
  }
}
