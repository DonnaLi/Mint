# Mint

A digital wallet backend built on a **double-entry ledger**, designed to stay correct under concurrency, client retries, and partial failures.

**Stack:** TypeScript · Node.js · Fastify · PostgreSQL · Vitest

## Why it's interesting

Moving money looks simple until two requests hit the same account at once, a client retries after a timeout, or a process dies halfway through a write. Mint is built around guarantees that hold in all three cases:

| Guarantee | How it's enforced |
| --- | --- |
| Money is never created or destroyed | Every transaction is a set of entries that sum to zero, checked by a deferred constraint trigger at `COMMIT` |
| No overdrafts, even under races | Accounts are locked with `SELECT … FOR UPDATE` before balances change, plus a `CHECK (balance >= 0)` constraint |
| No deadlocks between opposite transfers | Accounts are always locked in a fixed (id) order; transient conflicts are retried with jittered backoff |
| Retries never double-charge | Every write requires an `Idempotency-Key`; the key is claimed first in the same DB transaction, and duplicates replay the stored result |
| A reused key can't mask a different request | The request body is hashed and stored; a mismatch returns `409` |
| History can't be rewritten | Entries are append-only (update/delete blocked by trigger) |
| Cached balances can be trusted | `GET /admin/reconcile` rebuilds every balance from entries in a consistent snapshot and reports any drift |

Amounts are integers in minor units (cents), so there is no floating-point rounding.

## Data model

```
accounts               ledger_transactions          entries
─────────              ───────────────────          ───────
id                     id                           id
name                   kind                         transaction_id → ledger_transactions
currency               idempotency_key (unique)     account_id     → accounts
kind (user|system)     request_hash                 amount (signed)
allow_negative         description                  balance_after
balance (cached)       created_at                   created_at
```

Deposits and withdrawals move money against a per-currency **external** system account, which goes negative as money enters. This keeps the ledger as a whole summing to zero at all times.

## Getting started

```bash
cp .env.example .env
docker compose up -d          # Postgres on localhost:5432
npm install
npm run dev                   # runs migrations, then serves on :3000
```

## API

All write endpoints require an `Idempotency-Key` header (8–255 chars, e.g. a UUID). A first request returns `201`; a replay of the same request returns `200` with the original result.

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/accounts` | `{ name, currency }` |
| `GET` | `/accounts/:id` | |
| `GET` | `/accounts/:id/entries?limit=&before=` | |
| `POST` | `/deposits` | `{ accountId, amount, description? }` |
| `POST` | `/withdrawals` | `{ accountId, amount, description? }` |
| `POST` | `/transfers` | `{ fromAccountId, toAccountId, amount, description? }` |
| `GET` | `/transactions/:id` | |
| `GET` | `/admin/reconcile` | |
| `GET` | `/health` | |

Errors look like `{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "…" } }`.

### Example

```bash
A=$(curl -s -XPOST localhost:3000/accounts -H 'content-type: application/json' \
  -d '{"name":"alice","currency":"CAD"}' | jq -r .id)
B=$(curl -s -XPOST localhost:3000/accounts -H 'content-type: application/json' \
  -d '{"name":"bob","currency":"CAD"}' | jq -r .id)

curl -XPOST localhost:3000/deposits -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d "{\"accountId\":\"$A\",\"amount\":10000}"

curl -XPOST localhost:3000/transfers -H 'content-type: application/json' \
  -H 'Idempotency-Key: rent-2026-10' \
  -d "{\"fromAccountId\":\"$A\",\"toAccountId\":\"$B\",\"amount\":4000,\"description\":\"rent\"}"
```

## Tests

The tests run against a real Postgres database, because the guarantees live there.

```bash
docker compose up -d
TEST_DATABASE_URL=postgres://mint:mint@localhost:5432/mint_test npm test
```

| Suite | What it proves |
| --- | --- |
| `ledger.test.ts` | Deposits, withdrawals and transfers; rejected requests leave no trace |
| `idempotency.test.ts` | Retries replay the original result; 50 concurrent duplicates post exactly once |
| `concurrency.test.ts` | 100 racing withdrawals can't overdraw; 400 random concurrent transfers conserve money and reconcile cleanly |
| `database-guarantees.test.ts` | Raw SQL can't create unbalanced transactions, edit history, or go negative |
| `api.test.ts` | End-to-end HTTP flow and error shapes |

## Project layout

```
migrations/001_init.sql   schema, constraints and integrity triggers
src/db.ts                 pool + transaction helper with retry on deadlock/serialization failure
src/ledger.ts             core ledger: posting, idempotency, locking, reconciliation
src/app.ts                Fastify routes and validation
src/migrate.ts            minimal migration runner
src/index.ts              server entrypoint
test/                     integration tests
```
