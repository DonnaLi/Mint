export type ErrorCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'CURRENCY_MISMATCH'
  | 'SAME_ACCOUNT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_REQUEST';

const STATUS: Record<ErrorCode, number> = {
  ACCOUNT_NOT_FOUND: 404,
  INSUFFICIENT_FUNDS: 422,
  CURRENCY_MISMATCH: 422,
  SAME_ACCOUNT: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  INVALID_REQUEST: 400,
};

/** A domain error the API reports to the client as-is. */
export class LedgerError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.status = STATUS[code];
  }
}
