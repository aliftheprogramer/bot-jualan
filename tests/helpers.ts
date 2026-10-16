import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/db.js';
import { migrate, postgres } from '../src/db.js';
import { Store } from '../src/store.js';
import { ShopService } from '../src/service.js';
import { Worker } from '../src/worker.js';
import { SimulationPayments, SimulationSupplier } from '../src/providers/simulation.js';
import type { Messenger, OutgoingMessage } from '../src/providers/types.js';

export const owner = '6281234567890';
export const customer = '6281111111111';
export const key = Buffer.alloc(32, 9).toString('base64');

export async function fixture() {
  let engine: { close(): Promise<void> };
  let db: Database;
  const adapt = (connection: Pick<PGlite, 'query' | 'exec'>): Database => ({
    async query<Row>(sql: string, values: unknown[] = []) { return (await connection.query<Row>(sql, values)).rows; },
    async exec(sql: string) { await connection.exec(sql); },
    async transaction(task) { return pglite.transaction(transaction => task(adapt(transaction))); },
  });
  let pglite: PGlite;
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/yoshstore_test') throw new Error('Use only a dedicated local yoshstore_test database');
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    const root = postgres(url.toString());
    try { await root.db.exec(`CREATE SCHEMA ${schema}`); } finally { await root.close(); }
    url.searchParams.set('options', `-c search_path=${schema}`);
    const connection = postgres(url.toString());
    db = connection.db;
    engine = { close: connection.close };
  } else {
    pglite = new PGlite();
    engine = pglite;
    db = adapt(pglite);
  }
  await migrate(db);
  const store = new Store(db, key);
  const payments = new SimulationPayments();
  const supplier = new SimulationSupplier();
  const service = new ShopService(store, payments, supplier, owner);
  const messages: { customer: string; message: OutgoingMessage; id: string }[] = [];
  const messenger: Messenger = { async send(recipient, message, id) { messages.push({ customer: recipient, message, id }); } };
  const worker = new Worker(store, service, messenger);
  async function drain() {
    for (let count = 0; count < 50; count++) if (!await worker.tick()) return;
    throw new Error('Unexpected endless immediate jobs');
  }
  async function stock(code = 'VOUCHER', quantity = 1) {
    await store.addProduct({ code, name: 'Voucher demo', category: 'Voucher', price: 15000, kind: 'OWN_STOCK' });
    for (let index = 0; index < quantity; index++) await store.addStock(code, `SECRET-${code}-${index}`);
  }
  return { engine, db, store, payments, supplier, service, worker, messages, messenger, drain, stock };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
