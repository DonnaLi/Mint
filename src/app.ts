import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { LedgerError } from './errors.js';
import { Ledger } from './ledger.js';

const uuid = z.string().uuid();
const amount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const description = z.string().max(280).optional();

const schemas = {
  createAccount: z.object({
    name: z.string().min(1).max(100),
    currency: z.string().regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter ISO code'),
  }),
  deposit: z.object({ accountId: uuid, amount, description }),
  withdrawal: z.object({ accountId: uuid, amount, description }),
  transfer: z.object({ fromAccountId: uuid, toAccountId: uuid, amount, description }),
  idParam: z.object({ id: uuid }),
  entriesQuery: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    before: z.coerce.number().int().positive().optional(),
  }),
};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new LedgerError('INVALID_REQUEST', msg);
  }
  return result.data;
}

function idempotencyKey(req: FastifyRequest): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 255) {
    throw new LedgerError('INVALID_REQUEST', 'Idempotency-Key header is required (8–255 characters)');
  }
  return key;
}

export function buildApp(db: Db, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const ledger = new Ledger(db);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof LedgerError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { status: 'ok' };
  });

  app.post('/accounts', async (req, reply) => {
    const body = parse(schemas.createAccount, req.body);
    return reply.status(201).send(await ledger.createAccount(body));
  });

  app.get('/accounts/:id', async (req) => {
    const { id } = parse(schemas.idParam, req.params);
    return ledger.getAccount(id);
  });

  app.get('/accounts/:id/entries', async (req) => {
    const { id } = parse(schemas.idParam, req.params);
    const query = parse(schemas.entriesQuery, req.query);
    return { entries: await ledger.listEntries(id, query) };
  });

  app.post('/deposits', async (req, reply) => {
    const body = parse(schemas.deposit, req.body);
    const txn = await ledger.deposit({ ...body, idempotencyKey: idempotencyKey(req) });
    return reply.status(txn.replayed ? 200 : 201).send(txn);
  });

  app.post('/withdrawals', async (req, reply) => {
    const body = parse(schemas.withdrawal, req.body);
    const txn = await ledger.withdraw({ ...body, idempotencyKey: idempotencyKey(req) });
    return reply.status(txn.replayed ? 200 : 201).send(txn);
  });

  app.post('/transfers', async (req, reply) => {
    const body = parse(schemas.transfer, req.body);
    const txn = await ledger.transfer({ ...body, idempotencyKey: idempotencyKey(req) });
    return reply.status(txn.replayed ? 200 : 201).send(txn);
  });

  app.get('/transactions/:id', async (req, reply) => {
    const { id } = parse(schemas.idParam, req.params);
    const txn = await ledger.getTransaction(id);
    if (!txn) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'transaction not found' } });
    return txn;
  });

  app.get('/admin/reconcile', async () => ledger.reconcile());

  return app;
}
