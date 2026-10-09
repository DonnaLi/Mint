import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { Ledger } from '../src/ledger.js';
import { fundedAccount, key, setupDb } from './helpers.js';

let db: Db;
let ledger: Ledger;

beforeAll(async () => {
  db = await setupDb();
  ledger = new Ledger(db);
});
afterAll(() => db.end());

describe('idempotency', () => {
  it('a retried request returns the original result and moves money once', async () => {
    const a = await fundedAccount(ledger, 1_000);
    const b = await fundedAccount(ledger, 0);
    const req = { fromAccountId: a.id, toAccountId: b.id, amount: 300, idempotencyKey: key() };

    const first = await ledger.transfer(req);
    const retry = await ledger.transfer(req);

    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.id).toBe(first.id);
    expect(retry.entries.map((e) => e.id)).toEqual(first.entries.map((e) => e.id));
    expect((await ledger.getAccount(a.id)).balance).toBe(700);
    expect((await ledger.getAccount(b.id)).balance).toBe(300);
  });

  it('reusing a key with a different payload is rejected', async () => {
    const a = await fundedAccount(ledger, 1_000);
    const b = await fundedAccount(ledger, 0);
    const k = key();
    await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 100, idempotencyKey: k });

    await expect(
      ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 999, idempotencyKey: k }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
    expect((await ledger.getAccount(b.id)).balance).toBe(100);
  });

  it('50 concurrent duplicates of one request post exactly once', async () => {
    const a = await fundedAccount(ledger, 10_000);
    const b = await fundedAccount(ledger, 0);
    const req = { fromAccountId: a.id, toAccountId: b.id, amount: 250, idempotencyKey: key() };

    const results = await Promise.all(Array.from({ length: 50 }, () => ledger.transfer(req)));

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await ledger.getAccount(a.id)).balance).toBe(9_750);
    expect((await ledger.getAccount(b.id)).balance).toBe(250);

    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM entries WHERE account_id = $1`, [b.id]);
    expect(rows[0].n).toBe(1);
  });
});
