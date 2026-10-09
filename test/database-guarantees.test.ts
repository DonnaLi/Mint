import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { Ledger } from '../src/ledger.js';
import { fundedAccount, key, setupDb } from './helpers.js';

// These tests bypass the service and write SQL directly, to show the
// database itself refuses to hold an inconsistent ledger even if
// application code has a bug.

let db: Db;
let ledger: Ledger;

beforeAll(async () => {
  db = await setupDb();
  ledger = new Ledger(db);
});
afterAll(() => db.end());

async function inTx(fn: (q: (sql: string, params?: unknown[]) => Promise<any>) => Promise<void>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await fn((sql, params) => client.query(sql, params));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

describe('database-level guarantees', () => {
  it('rejects a ledger transaction whose entries do not sum to zero', async () => {
    const a = await fundedAccount(ledger, 0);
    await expect(
      inTx(async (q) => {
        const { rows } = await q(
          `INSERT INTO ledger_transactions (kind, idempotency_key, request_hash) VALUES ('deposit', $1, 'x') RETURNING id`,
          [key()],
        );
        await q(`INSERT INTO entries (transaction_id, account_id, amount, balance_after) VALUES ($1, $2, 500, 500)`, [
          rows[0].id,
          a.id,
        ]);
        await q(`INSERT INTO entries (transaction_id, account_id, amount, balance_after) VALUES ($1, $2, -499, 1)`, [
          rows[0].id,
          a.id,
        ]);
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it('rejects a single-entry transaction', async () => {
    const a = await fundedAccount(ledger, 0);
    await expect(
      inTx(async (q) => {
        const { rows } = await q(
          `INSERT INTO ledger_transactions (kind, idempotency_key, request_hash) VALUES ('deposit', $1, 'x') RETURNING id`,
          [key()],
        );
        await q(`INSERT INTO entries (transaction_id, account_id, amount, balance_after) VALUES ($1, $2, 500, 500)`, [
          rows[0].id,
          a.id,
        ]);
      }),
    ).rejects.toThrow(/at least 2/);
  });

  it('refuses to edit or delete ledger entries', async () => {
    await fundedAccount(ledger, 100);
    await expect(db.query(`UPDATE entries SET amount = amount * 2`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM entries`)).rejects.toThrow(/append-only/);
  });

  it('refuses a negative balance on a user account', async () => {
    const a = await fundedAccount(ledger, 100);
    await expect(db.query(`UPDATE accounts SET balance = -1 WHERE id = $1`, [a.id])).rejects.toThrow(
      /balance_non_negative/,
    );
  });
});
