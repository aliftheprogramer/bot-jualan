import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate, type Database } from '../src/db.js';
import { Store } from '../src/store.js';
import { ShopService } from '../src/service.js';
import { CommandRouter } from '../src/commands.js';
import { Worker } from '../src/worker.js';
import { SimulationPayments, SimulationSupplier } from '../src/providers/simulation.js';
import type { Messenger } from '../src/providers/types.js';

async function main() {
  const engine = new PGlite();
  const adapt = (connection: Pick<PGlite, 'query' | 'exec'>): Database => ({
    async query<Row>(sql: string, values: unknown[] = []) { return (await connection.query<Row>(sql, values)).rows; },
    async exec(sql) { await connection.exec(sql); },
    async transaction(task) { return engine.transaction(connection => task(adapt(connection))); },
  });
  const db = adapt(engine);
  try {
    await migrate(db);
    const owner = '6280000000001';
    const customer = '6280000000002';
    const store = new Store(db, randomBytes(32).toString('base64'));
    const payments = new SimulationPayments();
    const service = new ShopService(store, payments, new SimulationSupplier(), owner);
    const commands = new CommandRouter(store, service, { owner, ownerName: 'Demo owner', botName: 'YOSHSTORE DEMO', timezone: 'Asia/Jakarta', mode: 'simulation' });
    const messenger: Messenger = { async send(recipient, message) { console.info(`\n[SIMULATED WhatsApp -> ${recipient}]\n${message.text}${message.qr ? '\n[QR simulasi, tidak dapat dibayar]' : ''}`); } };
    const worker = new Worker(store, service, messenger, commands);
    const drain = async () => { for (let count = 0; count < 100 && await worker.tick(); count++) {} };
    console.info('SIMULASI LOKAL: nomor, stok, QR, supplier, dan pembayaran semuanya demo. Tidak ada layanan eksternal dipanggil.');
    await commands.handle(owner, 'addproduct VOUCHER|Voucher demo|Voucher|15000', 'owner-1');
    await commands.handle(owner, 'addstock VOUCHER|DEMO-VOUCHER-NOT-A-REAL-PRODUCT', 'owner-2');
    console.info((await commands.handle(customer, 'menu', 'menu')).text);
    console.info((await commands.handle(customer, '1', 'category')).text);
    console.info((await commands.handle(customer, 'beli VOUCHER', 'buy')).text);
    await drain();
    const order = (await store.recentOrders())[0];
    payments.settle(order.payment_id!);
    await service.reconcile(order.id);
    await service.reconcile(order.id);
    await drain();
    console.info((await commands.handle(customer, `status ${order.id}`, 'status')).text);
    await service.syncCatalog();
    const supplier = (await store.listProducts(true)).find(product => product.kind === 'DIGIFLAZZ')!;
    await store.editProduct(supplier.code, { price: 11000, active: true });
    console.info((await commands.handle(customer, `beli ${supplier.code} DEMO-TARGET`, 'supplier-buy')).text);
    await drain();
    const supplierOrder = (await store.recentOrders())[0];
    payments.settle(supplierOrder.payment_id!);
    await service.reconcile(supplierOrder.id);
    await drain();
    console.info('\n' + (await commands.handle(owner, 'rekap', 'report')).text);
    const summary = await store.summary();
    if (summary.delivered !== 2 || summary.revenue !== 26000) throw new Error('Demo acceptance failed');
    console.info('\nPASS: stok sendiri + supplier demo terkirim; duplicate reconciliation tidak menggandakan delivery.');
  } finally { await engine.close(); }
}
void main().catch(() => { console.error('Demo failed. Run npm test for diagnostics.'); process.exitCode = 1; });
