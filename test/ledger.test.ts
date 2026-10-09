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

describe('basic money movement', () => {
  it('deposits credit the account and debit the external account', async () => {
    const a = await ledger.createAccount({ name: 'alice', currency: 'cad' });
    expect(a.currency).toBe('CAD');

    const txn = await ledger.deposit({ accountId: a.id, amount: 5_000, idempotencyKey: key() });
    expect(txn.kind).toBe('deposit');
    expect(txn.entries).toHaveLength(2);
    expect(txn.entries.reduce((s, e) => s + e.amount, 0)).toBe(0);
    expect((await ledger.getAccount(a.id)).balance).toBe(5_000);
  });

  it('transfers move money between accounts and record balance_after', async () => {
    const a = await fundedAccount(ledger, 10_000);
    const b = await fundedAccount(ledger, 0);

    const txn = await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 2_500, idempotencyKey: key() });

    expect((await ledger.getAccount(a.id)).balance).toBe(7_500);
    expect((await ledger.getAccount(b.id)).balance).toBe(2_500);
    expect(txn.entries.find((e) => e.accountId === a.id)?.balanceAfter).toBe(7_500);
    expect(txn.entries.find((e) => e.accountId === b.id)?.balanceAfter).toBe(2_500);
  });

  it('withdrawals reduce the balance', async () => {
    const a = await fundedAccount(ledger, 1_000);
    await ledger.withdraw({ accountId: a.id, amount: 400, idempotencyKey: key() });
    expect((await ledger.getAccount(a.id)).balance).toBe(600);
  });

  it('lists entries newest first with cursor paging', async () => {
    const a = await fundedAccount(ledger, 1_000);
    for (let i = 0; i < 3; i++) await ledger.withdraw({ accountId: a.id, amount: 100, idempotencyKey: key() });

    const page1 = await ledger.listEntries(a.id, { limit: 2 });
    expect(page1.map((e) => e.balanceAfter)).toEqual([700, 800]);
    const page2 = await ledger.listEntries(a.id, { limit: 2, before: page1[1]!.id });
    expect(page2.map((e) => e.balanceAfter)).toEqual([900, 1_000]);
  });
});

describe('rejections leave no trace', () => {
  it('rejects overdrafts', async () => {
    const a = await fundedAccount(ledger, 100);
    const b = await fundedAccount(ledger, 0);
    await expect(
      ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 101, idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    expect((await ledger.getAccount(a.id)).balance).toBe(100);
    expect((await ledger.getAccount(b.id)).balance).toBe(0);
  });

  it('rejects mixed currencies', async () => {
    const cad = await fundedAccount(ledger, 100, 'CAD');
    const usd = await fundedAccount(ledger, 0, 'USD');
    await expect(
      ledger.transfer({ fromAccountId: cad.id, toAccountId: usd.id, amount: 10, idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
  });

  it('rejects transfers to self, unknown accounts and bad amounts', async () => {
    const a = await fundedAccount(ledger, 100);
    await expect(
      ledger.transfer({ fromAccountId: a.id, toAccountId: a.id, amount: 1, idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: 'SAME_ACCOUNT' });
    await expect(
      ledger.transfer({
        fromAccountId: a.id,
        toAccountId: '00000000-0000-0000-0000-000000000000',
        amount: 1,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    for (const amount of [0, -5, 1.5]) {
      await expect(ledger.deposit({ accountId: a.id, amount, idempotencyKey: key() })).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
    }
  });

  it('a failed request does not burn its idempotency key', async () => {
    const a = await fundedAccount(ledger, 50);
    const b = await fundedAccount(ledger, 0);
    const k = key();
    await expect(
      ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 80, idempotencyKey: k }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    await ledger.deposit({ accountId: a.id, amount: 50, idempotencyKey: key() });
    const txn = await ledger.transfer({ fromAccountId: a.id, toAccountId: b.id, amount: 80, idempotencyKey: k });
    expect(txn.replayed).toBe(false);
    expect((await ledger.getAccount(b.id)).balance).toBe(80);
  });

  it('the ledger reconciles after all of the above', async () => {
    const report = await ledger.reconcile();
    expect(report.ok).toBe(true);
  });
});
