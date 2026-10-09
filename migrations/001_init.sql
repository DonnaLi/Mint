-- Mint schema: double-entry ledger.
--
-- Every movement of money is a ledger transaction made of two or more
-- entries whose amounts sum to zero. Account balances are cached on the
-- account row for fast reads, and can always be rebuilt from entries.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  currency        CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  kind            TEXT        NOT NULL CHECK (kind IN ('user', 'system')),
  -- System accounts (e.g. the external funding source) may go negative.
  allow_negative  BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Balance in minor units (cents). Maintained inside the same DB
  -- transaction that writes entries.
  balance         BIGINT      NOT NULL DEFAULT 0,
  version         BIGINT      NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT balance_non_negative CHECK (allow_negative OR balance >= 0)
);

-- One external funding account per currency.
CREATE UNIQUE INDEX accounts_one_external_per_currency
  ON accounts (currency) WHERE kind = 'system';

CREATE TABLE ledger_transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT        NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'transfer')),
  -- Client-supplied key; a retried request with the same key returns
  -- the original result instead of moving money twice.
  idempotency_key  TEXT        NOT NULL UNIQUE,
  -- Hash of the request body, so a reused key with a different payload
  -- is rejected rather than silently answered with the old result.
  request_hash     TEXT        NOT NULL,
  description      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID        NOT NULL REFERENCES ledger_transactions(id),
  account_id      UUID        NOT NULL REFERENCES accounts(id),
  -- Signed amount in minor units: positive credits the account,
  -- negative debits it.
  amount          BIGINT      NOT NULL CHECK (amount <> 0),
  balance_after   BIGINT      NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX entries_account_id_idx ON entries (account_id, id);
CREATE INDEX entries_transaction_id_idx ON entries (transaction_id);

-- Entries are append-only: corrections are new transactions, never edits.
CREATE FUNCTION entries_are_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger entries are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entries_no_update_or_delete
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION entries_are_immutable();

-- Database-level guarantee that every ledger transaction balances.
-- Deferred so it runs at COMMIT, after all of a transaction's entries
-- have been inserted.
CREATE FUNCTION check_transaction_balanced() RETURNS trigger AS $$
DECLARE
  total BIGINT;
  n     INT;
BEGIN
  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO total, n
  FROM entries WHERE transaction_id = NEW.transaction_id;

  IF n < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has % entries; need at least 2', NEW.transaction_id, n;
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (sum = %)', NEW.transaction_id, total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_must_balance
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transaction_balanced();

-- Entries must use the account's currency; enforced by the service, and
-- double-checked here.
CREATE FUNCTION check_entry_currency() RETURNS trigger AS $$
DECLARE
  txn_currencies INT;
BEGIN
  SELECT COUNT(DISTINCT a.currency) INTO txn_currencies
  FROM entries e JOIN accounts a ON a.id = e.account_id
  WHERE e.transaction_id = NEW.transaction_id;

  IF txn_currencies > 1 THEN
    RAISE EXCEPTION 'ledger transaction % mixes currencies', NEW.transaction_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_single_currency
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_currency();
