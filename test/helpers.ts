import { randomUUID } from 'node:crypto';
import { createPool, type Db } from '../src/db.js';
import { Ledger } from '../src/ledger.js';
import { migrate } from '../src/migrate.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/** Fresh, empty schema for each test file. */
export async function setupDb(): Promise<Db> {
  if (!url) throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL) to run the tests');
  const db = createPool(url);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  return db;
}

export const key = () => randomUUID();

export async function fundedAccount(ledger: Ledger, balance: number, currency = 'CAD') {
  const account = await ledger.createAccount({ name: `acct-${key().slice(0, 8)}`, currency });
  if (balance > 0) await ledger.deposit({ accountId: account.id, amount: balance, idempotencyKey: key() });
  return account;
}
