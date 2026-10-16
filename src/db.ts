import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';

export interface Database {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]>;
  exec(sql: string): Promise<void>;
  transaction<Value>(task: (db: Database) => Promise<Value>): Promise<Value>;
}

export function postgres(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  const connection = (client: Pick<pg.PoolClient, 'query'>): Database => ({
    async query<Row>(sql: string, values: unknown[] = []) {
      return (await client.query(sql, values)).rows as Row[];
    },
    async exec(sql: string) { await client.query(sql); },
    async transaction(task) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await task(connection(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
  });
  return { db: connection(pool), close: () => pool.end() };
}

export async function migrate(db: Database) {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  await db.transaction(async transaction => {
    await transaction.query('SELECT pg_advisory_xact_lock(9634521)');
    const previous = await transaction.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version = $1', ['001']);
    if (previous.length) {
      if (previous[0].checksum !== checksum) throw new Error('Migration checksum changed; create a new version instead');
      return;
    }
    await transaction.exec(sql);
    await transaction.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', ['001', checksum]);
  });
}
