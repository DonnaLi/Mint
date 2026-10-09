import pg from 'pg';

// Postgres returns BIGINT as a string by default; balances are stored in
// minor units and stay well within Number.MAX_SAFE_INTEGER (~9e15 cents),
// so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_SIZE ?? 20) });
}

// SQLSTATE codes worth retrying: the whole transaction can simply run again.
const RETRYABLE = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

export function isRetryable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && RETRYABLE.has((err as { code?: string }).code ?? '');
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

export interface TxOptions {
  maxAttempts?: number;
}

/**
 * Runs `fn` inside a database transaction, committing on success and
 * rolling back on any error. Transient conflicts (deadlocks, serialization
 * failures) are retried with jittered backoff, so callers can treat each
 * call as all-or-nothing.
 */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;

  for (let attempt = 1; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isRetryable(err) && attempt < maxAttempts) {
        const backoff = Math.min(200, 10 * 2 ** attempt) * (0.5 + Math.random());
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
