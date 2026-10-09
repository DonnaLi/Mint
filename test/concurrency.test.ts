import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { LedgerError } from '../src/errors.js';
import { Ledger } from '../src/ledger.js';
import { fundedAccount, key, setupDb } from './helpers.js';

let db: Db;
let ledger: Ledger;

beforeAll(async () => {
  db = await setupDb();
  ledger = new Ledger(db);
});
afterAll(() => db.end());

/** Deterministic PRNG so a failing run can be reproduced. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

describe('concurrency', () => {
  it('concurrent withdrawals can never overdraw an account', async () => {
    const a = await fundedAccount(ledger, 1_000);

    // 100 parallel withdrawals of 30 against a balance of 1,000:
    // exactly 33 can succeed (990), the rest must fail cleanly.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, () => ledger.withdraw({ accountId: a.id, amount: 30, idempotencyKey: key() })),
    );

    const ok = outcomes.filter((o) => o.status === 'fulfilled');
    const failed = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(ok).toHaveLength(33);
    expect(failed.every((f) => f.reason instanceof LedgerError && f.reason.code === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect((await ledger.getAccount(a.id)).balance).toBe(10);
  });

  it('a storm of random transfers conserves money and keeps every invariant', async () => {
    const random = rng(42);
    const accounts = await Promise.all(Array.from({ length: 8 }, () => fundedAccount(ledger, 10_000)));
    const ids = accounts.map((a) => a.id);
    const totalBefore = 8 * 10_000;

    // Opposite-direction transfers between the same pairs are the classic
    // deadlock recipe; ordered locking means they must all just work.
    const jobs = Array.from({ length: 400 }, () => {
      const from = ids[Math.floor(random() * ids.length)]!;
      let to = ids[Math.floor(random() * ids.length)]!;
      if (to === from) to = ids[(ids.indexOf(from) + 1) % ids.length]!;
      const amount = 1 + Math.floor(random() * 3_000);
      return ledger
        .transfer({ fromAccountId: from, toAccountId: to, amount, idempotencyKey: key() })
        .then(() => 'ok' as const)
        .catch((err) => {
          if (err instanceof LedgerError && err.code === 'INSUFFICIENT_FUNDS') return 'nsf' as const;
          throw err;
        });
    });
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r === 'ok').length).toBeGreaterThan(0);

    const after = await Promise.all(ids.map((id) => ledger.getAccount(id)));
    expect(after.reduce((s, a) => s + a.balance, 0)).toBe(totalBefore);
    expect(after.every((a) => a.balance >= 0)).toBe(true);

    const report = await ledger.reconcile();
    expect(report.balanceDrift).toEqual([]);
    expect(report.unbalancedTransactions).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("each account's entry history replays to its current balance", async () => {
    const { rows } = await db.query(`
      SELECT account_id, amount, balance_after FROM entries ORDER BY account_id, id
    `);
    const running = new Map<string, number>();
    for (const r of rows) {
      const next = (running.get(r.account_id) ?? 0) + r.amount;
      expect(r.balance_after).toBe(next);
      running.set(r.account_id, next);
    }
  });
});
