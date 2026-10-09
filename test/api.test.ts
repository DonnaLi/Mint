import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import { key, setupDb } from './helpers.js';

let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await setupDb();
  app = buildApp(db);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.end();
});

async function createAccount(name: string) {
  const res = await app.inject({ method: 'POST', url: '/accounts', payload: { name, currency: 'CAD' } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('HTTP API', () => {
  it('runs a full deposit → transfer → withdrawal flow', async () => {
    const alice = await createAccount('alice');
    const bob = await createAccount('bob');

    const dep = await app.inject({
      method: 'POST',
      url: '/deposits',
      headers: { 'idempotency-key': key() },
      payload: { accountId: alice.id, amount: 10_000 },
    });
    expect(dep.statusCode).toBe(201);

    const transferKey = key();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/transfers',
        headers: { 'idempotency-key': transferKey },
        payload: { fromAccountId: alice.id, toAccountId: bob.id, amount: 4_000, description: 'rent' },
      });
    const first = await send();
    const retry = await send();
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);

    const wd = await app.inject({
      method: 'POST',
      url: '/withdrawals',
      headers: { 'idempotency-key': key() },
      payload: { accountId: bob.id, amount: 1_500 },
    });
    expect(wd.statusCode).toBe(201);

    expect((await app.inject(`/accounts/${alice.id}`)).json().balance).toBe(6_000);
    expect((await app.inject(`/accounts/${bob.id}`)).json().balance).toBe(2_500);

    const entries = (await app.inject(`/accounts/${bob.id}/entries`)).json().entries;
    expect(entries.map((e: { amount: number }) => e.amount)).toEqual([-1_500, 4_000]);

    const txn = await app.inject(`/transactions/${first.json().id}`);
    expect(txn.json().description).toBe('rent');

    expect((await app.inject('/admin/reconcile')).json().ok).toBe(true);
  });

  it('returns structured errors', async () => {
    const a = await createAccount('carol');

    const noKey = await app.inject({ method: 'POST', url: '/deposits', payload: { accountId: a.id, amount: 1 } });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('INVALID_REQUEST');

    const nsf = await app.inject({
      method: 'POST',
      url: '/withdrawals',
      headers: { 'idempotency-key': key() },
      payload: { accountId: a.id, amount: 1 },
    });
    expect(nsf.statusCode).toBe(422);
    expect(nsf.json().error.code).toBe('INSUFFICIENT_FUNDS');

    const missing = await app.inject('/accounts/00000000-0000-0000-0000-000000000000');
    expect(missing.statusCode).toBe(404);

    const badBody = await app.inject({ method: 'POST', url: '/accounts', payload: { name: '', currency: 'dollars' } });
    expect(badBody.statusCode).toBe(400);
  });
});
