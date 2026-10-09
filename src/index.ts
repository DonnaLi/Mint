import { buildApp } from './app.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

const db = createPool();
await migrate(db, console.log);

const app = buildApp(db, { logger: true });
const port = Number(process.env.PORT ?? 3000);

await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
