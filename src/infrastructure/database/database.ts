import { MikroORM } from '@mikro-orm/postgresql';
import type { EntityManager } from '@mikro-orm/postgresql';
import { IsolationLevel } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '../../config';
import { Migration20261111000001InitialSchema } from './migrations/Migration20261111000001_initial_schema';

export type Row = Record<string, unknown>;

/** A query runner bound to a single SQL transaction (or to autocommit, for reads). */
export interface SqlExecutor {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Thin wrapper around MikroORM.
 *
 * MikroORM provides the connection pool, transaction demarcation and the
 * migrator. Repositories write explicit SQL through `em.execute` because the
 * critical paths need precise control over row locks (`FOR UPDATE`,
 * `SKIP LOCKED`), `ON CONFLICT` and compare-and-set updates. Domain entities
 * stay plain classes (private constructor + create/rehydrate).
 */
export class Database {
  private constructor(
    readonly orm: MikroORM,
    private readonly settings: AppConfig['database'],
  ) {}

  static async connect(settings: AppConfig['database']): Promise<Database> {
    const orm = await MikroORM.init({
      clientUrl: settings.url,
      entities: [],
      discovery: { warnWhenNoEntities: false },
      extensions: [Migrator],
      pool: { min: 0, max: settings.poolMax },
      allowGlobalContext: false,
      debug: false,
      migrations: {
        tableName: 'mikro_orm_migrations',
        silent: process.env.LOG_LEVEL === 'error',
        transactional: true,
        allOrNothing: true,
        migrationsList: [
          { name: 'Migration20261111000001_initial_schema', class: Migration20261111000001InitialSchema },
        ],
      },
    });
    return new Database(orm, settings);
  }

  /**
   * Runs `work` inside a READ COMMITTED transaction. Commits when it resolves,
   * rolls back when it throws. A local lock timeout bounds how long we wait on
   * a wallet row lock under contention.
   */
  async transaction<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork();
    return em.transactional(
      async (tem) => {
        const executor = executorFor(tem as EntityManager);
        await executor.query(`SET LOCAL lock_timeout = '${Math.trunc(this.settings.lockTimeoutMs)}ms'`);
        await executor.query(`SET LOCAL statement_timeout = '${Math.trunc(this.settings.statementTimeoutMs)}ms'`);
        return work(executor);
      },
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );
  }

  /** Autocommit executor for reads that do not need a transaction. */
  reader(): SqlExecutor {
    return executorFor(this.orm.em.fork() as EntityManager);
  }

  async ping(): Promise<void> {
    await this.reader().query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.orm.close(true);
  }
}

function executorFor(em: EntityManager): SqlExecutor {
  return {
    async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await em.execute(sql, params as any[], 'all');
      return (result ?? []) as T[];
    },
  };
}
