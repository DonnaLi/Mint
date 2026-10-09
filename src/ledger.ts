import { createHash } from 'node:crypto';
import { type Db, type Tx, withTransaction } from './db.js';
import { LedgerError } from './errors.js';

export interface Account {
  id: string;
  name: string;
  currency: string;
  kind: 'user' | 'system';
  balance: number;
  createdAt: Date;
}

export interface Entry {
  id: number;
  transactionId: string;
  accountId: string;
  amount: number;
  balanceAfter: number;
  createdAt: Date;
}

export type TransactionKind = 'deposit' | 'withdrawal' | 'transfer';

export interface LedgerTransaction {
  id: string;
  kind: TransactionKind;
  idempotencyKey: string;
  description: string | null;
  createdAt: Date;
  entries: Entry[];
  /** True when this result came from an earlier request with the same idempotency key. */
  replayed: boolean;
}

/** One side of a ledger transaction: a signed amount against an account. */
interface Leg {
  accountId: string;
  amount: number;
}

interface PostRequest {
  kind: TransactionKind;
  idempotencyKey: string;
  description?: string;
  legs: Leg[];
}

function assertPositiveAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new LedgerError('INVALID_REQUEST', 'amount must be a positive integer in minor units (e.g. cents)');
  }
}

function hashRequest(req: PostRequest): string {
  const canonical = JSON.stringify({
    kind: req.kind,
    description: req.description ?? null,
    legs: req.legs.map((l) => [l.accountId, l.amount]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function toAccount(row: Record<string, any>): Account {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    kind: row.kind,
    balance: row.balance,
    createdAt: row.created_at,
  };
}

function toEntry(row: Record<string, any>): Entry {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    accountId: row.account_id,
    amount: row.amount,
    balanceAfter: row.balance_after,
    createdAt: row.created_at,
  };
}

export class Ledger {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- accounts

  async createAccount(input: { name: string; currency: string }): Promise<Account> {
    const currency = input.currency.toUpperCase();
    const { rows } = await this.db.query(
      `INSERT INTO accounts (name, currency, kind) VALUES ($1, $2, 'user') RETURNING *`,
      [input.name, currency],
    );
    return toAccount(rows[0]!);
  }

  async getAccount(id: string): Promise<Account> {
    const { rows } = await this.db.query(`SELECT * FROM accounts WHERE id = $1`, [id]);
    if (rows.length === 0) throw new LedgerError('ACCOUNT_NOT_FOUND', `account ${id} not found`);
    return toAccount(rows[0]!);
  }

  /** Newest-first page of an account's entries. Pass the last seen id as `before` to page. */
  async listEntries(accountId: string, opts: { limit?: number; before?: number } = {}): Promise<Entry[]> {
    await this.getAccount(accountId);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const { rows } = await this.db.query(
      `SELECT * FROM entries
       WHERE account_id = $1 AND ($2::bigint IS NULL OR id < $2)
       ORDER BY id DESC LIMIT $3`,
      [accountId, opts.before ?? null, limit],
    );
    return rows.map(toEntry);
  }

  /**
   * The system account that represents money entering or leaving Mint in a
   * given currency. It goes negative as users deposit, so the ledger as a
   * whole always sums to zero.
   */
  private async externalAccountId(currency: string): Promise<string> {
    const found = await this.db.query(`SELECT id FROM accounts WHERE kind = 'system' AND currency = $1`, [currency]);
    if (found.rows[0]) return found.rows[0].id;

    await this.db.query(
      `INSERT INTO accounts (name, currency, kind, allow_negative)
       VALUES ($1, $2, 'system', TRUE)
       ON CONFLICT (currency) WHERE kind = 'system' DO NOTHING`,
      [`external:${currency}`, currency],
    );
    const { rows } = await this.db.query(`SELECT id FROM accounts WHERE kind = 'system' AND currency = $1`, [currency]);
    return rows[0]!.id;
  }

  // ------------------------------------------------------------ money flows

  async deposit(input: { accountId: string; amount: number; idempotencyKey: string; description?: string }) {
    assertPositiveAmount(input.amount);
    const account = await this.getAccount(input.accountId);
    const external = await this.externalAccountId(account.currency);
    return this.post({
      kind: 'deposit',
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      legs: [
        { accountId: external, amount: -input.amount },
        { accountId: input.accountId, amount: input.amount },
      ],
    });
  }

  async withdraw(input: { accountId: string; amount: number; idempotencyKey: string; description?: string }) {
    assertPositiveAmount(input.amount);
    const account = await this.getAccount(input.accountId);
    const external = await this.externalAccountId(account.currency);
    return this.post({
      kind: 'withdrawal',
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      legs: [
        { accountId: input.accountId, amount: -input.amount },
        { accountId: external, amount: input.amount },
      ],
    });
  }

  async transfer(input: {
    fromAccountId: string;
    toAccountId: string;
    amount: number;
    idempotencyKey: string;
    description?: string;
  }) {
    assertPositiveAmount(input.amount);
    if (input.fromAccountId === input.toAccountId) {
      throw new LedgerError('SAME_ACCOUNT', 'cannot transfer to the same account');
    }
    return this.post({
      kind: 'transfer',
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      legs: [
        { accountId: input.fromAccountId, amount: -input.amount },
        { accountId: input.toAccountId, amount: input.amount },
      ],
    });
  }

  async getTransaction(id: string): Promise<LedgerTransaction | null> {
    const { rows } = await this.db.query(`SELECT * FROM ledger_transactions WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    return this.loadTransaction(this.db, rows[0], false);
  }

  /**
   * Writes one balanced ledger transaction atomically.
   *
   * Consistency comes from three things working together:
   *  1. Idempotency: the key is inserted first. A concurrent request with the
   *     same key blocks on the unique index until this one commits or rolls
   *     back, then replays the stored result instead of posting again.
   *  2. Row locks: every touched account is locked with SELECT ... FOR UPDATE
   *     in a fixed (id) order, so concurrent transfers serialize per account
   *     and can't deadlock against each other.
   *  3. The database: CHECK constraints stop negative balances and deferred
   *     triggers reject any transaction whose entries don't sum to zero.
   */
  private async post(req: PostRequest): Promise<LedgerTransaction> {
    const requestHash = hashRequest(req);

    return withTransaction(this.db, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO ledger_transactions (kind, idempotency_key, request_hash, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [req.kind, req.idempotencyKey, requestHash, req.description ?? null],
      );

      if (inserted.rows.length === 0) {
        const existing = await tx.query(`SELECT * FROM ledger_transactions WHERE idempotency_key = $1`, [
          req.idempotencyKey,
        ]);
        const row = existing.rows[0]!;
        if (row.request_hash !== requestHash) {
          throw new LedgerError(
            'IDEMPOTENCY_KEY_REUSED',
            'this idempotency key was already used for a different request',
          );
        }
        return this.loadTransaction(tx, row, true);
      }

      const txnRow = inserted.rows[0]!;
      const accountIds = [...new Set(req.legs.map((l) => l.accountId))].sort();
      const locked = await tx.query(`SELECT * FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [
        accountIds,
      ]);
      const accounts = new Map<string, Record<string, any>>(locked.rows.map((r) => [r.id, r]));

      for (const id of accountIds) {
        if (!accounts.has(id)) throw new LedgerError('ACCOUNT_NOT_FOUND', `account ${id} not found`);
      }
      const currencies = new Set([...accounts.values()].map((a) => a.currency));
      if (currencies.size > 1) {
        throw new LedgerError('CURRENCY_MISMATCH', 'all accounts in a transaction must share a currency');
      }

      const entries: Entry[] = [];
      for (const leg of req.legs) {
        const account = accounts.get(leg.accountId)!;
        const newBalance = account.balance + leg.amount;
        if (newBalance < 0 && !account.allow_negative) {
          throw new LedgerError('INSUFFICIENT_FUNDS', `account ${leg.accountId} has insufficient funds`);
        }
        account.balance = newBalance;

        await tx.query(`UPDATE accounts SET balance = $2, version = version + 1 WHERE id = $1`, [
          leg.accountId,
          newBalance,
        ]);
        const { rows } = await tx.query(
          `INSERT INTO entries (transaction_id, account_id, amount, balance_after)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [txnRow.id, leg.accountId, leg.amount, newBalance],
        );
        entries.push(toEntry(rows[0]!));
      }

      return {
        id: txnRow.id,
        kind: txnRow.kind,
        idempotencyKey: txnRow.idempotency_key,
        description: txnRow.description,
        createdAt: txnRow.created_at,
        entries,
        replayed: false,
      };
    });
  }

  private async loadTransaction(
    q: Db | Tx,
    row: Record<string, any>,
    replayed: boolean,
  ): Promise<LedgerTransaction> {
    const { rows } = await q.query(`SELECT * FROM entries WHERE transaction_id = $1 ORDER BY id`, [row.id]);
    return {
      id: row.id,
      kind: row.kind,
      idempotencyKey: row.idempotency_key,
      description: row.description,
      createdAt: row.created_at,
      entries: rows.map(toEntry),
      replayed,
    };
  }

  // ---------------------------------------------------------- verification

  /**
   * Audits the whole ledger:
   *  - every account's cached balance equals the sum of its entries
   *  - every ledger transaction sums to zero
   *  - the ledger as a whole sums to zero per currency
   * Runs in a REPEATABLE READ snapshot so concurrent writes can't skew it.
   */
  async reconcile(): Promise<ReconcileReport> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

      const drift = await client.query(
        `SELECT a.id, a.balance AS cached, COALESCE(SUM(e.amount), 0)::bigint AS computed
         FROM accounts a LEFT JOIN entries e ON e.account_id = a.id
         GROUP BY a.id
         HAVING a.balance <> COALESCE(SUM(e.amount), 0)`,
      );
      const unbalanced = await client.query(
        `SELECT transaction_id, SUM(amount)::bigint AS total
         FROM entries GROUP BY transaction_id HAVING SUM(amount) <> 0`,
      );
      const totals = await client.query(
        `SELECT a.currency, COALESCE(SUM(e.amount), 0)::bigint AS total, COUNT(e.id)::bigint AS entries
         FROM accounts a LEFT JOIN entries e ON e.account_id = a.id
         GROUP BY a.currency ORDER BY a.currency`,
      );

      await client.query('COMMIT');

      const report: ReconcileReport = {
        ok: drift.rows.length === 0 && unbalanced.rows.length === 0 && totals.rows.every((r) => r.total === 0),
        balanceDrift: drift.rows.map((r) => ({ accountId: r.id, cached: r.cached, computed: r.computed })),
        unbalancedTransactions: unbalanced.rows.map((r) => ({ transactionId: r.transaction_id, sum: r.total })),
        currencies: totals.rows.map((r) => ({ currency: r.currency, sum: r.total, entries: r.entries })),
      };
      return report;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export interface ReconcileReport {
  ok: boolean;
  balanceDrift: { accountId: string; cached: number; computed: number }[];
  unbalancedTransactions: { transactionId: string; sum: number }[];
  currencies: { currency: string; sum: number; entries: number }[];
}
