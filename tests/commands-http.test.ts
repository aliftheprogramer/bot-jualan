import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRouter } from '../src/commands.js';
import { createHttp } from '../src/http.js';
import { fixture, owner, customer, type Fixture } from './helpers.js';

let shop: Fixture;
let commands: CommandRouter;
beforeEach(async () => {
  shop = await fixture();
  commands = new CommandRouter(shop.store, shop.service, { botName: 'YOSHSTORE', ownerName: 'Danis', owner, timezone: 'Asia/Jakarta', mode: 'simulation' });
}, 20000);
afterEach(async () => { await shop.engine.close(); });

describe('WhatsApp commands', () => {
  it('rejects owner commands from a customer without modifying products', async () => {
    const reply = await commands.handle(customer, 'addproduct V1|Voucher|Voucher|15000', 'm1');
    expect(reply.text).toContain('owner');
    expect(await shop.store.listProducts(true)).toHaveLength(0);
  });
  it('lets the owner add products and stock with replay-safe responses', async () => {
    expect((await commands.handle(owner, 'addproduct V1|Voucher|Voucher|15000', 'm1')).text).toContain('berhasil');
    await commands.handle(owner, 'addstock V1|SECRET-V1', 'm2');
    await commands.handle(owner, 'addstock V1|SECRET-V1', 'm2');
    expect((await shop.store.listProducts())[0].stock).toBe(1);
    const logs = await shop.db.query('SELECT * FROM audit_events');
    expect(JSON.stringify(logs)).not.toContain('SECRET-V1');
  });
  it('returns an actionable owner error for duplicate product codes', async () => {
    await commands.handle(owner, 'addproduct V1|Voucher|Voucher|15000', 'm1');
    expect((await commands.handle(owner, 'addproduct V1|Voucher|Voucher|15000', 'm2')).text).toContain('sudah ada');
  });
  it('bounds the durable command queue before a customer floods the worker', async () => {
    for (let index = 0; index < 45; index++) await shop.store.acceptCommand(customer, 'menu', `flood-${index}`);
    expect(await shop.db.query("SELECT id FROM jobs WHERE type='COMMAND'")).toHaveLength(40);
  });
  it('shows actual sales and numbered categories then accepts a purchase', async () => {
    await shop.stock();
    expect((await commands.handle(customer, 'menu', 'm1')).text).toContain('Terjual: 0');
    expect((await commands.handle(customer, '1', 'm2')).text).toContain('VOUCHER');
    expect((await commands.handle(customer, 'beli VOUCHER', 'm3')).text).toContain('Order');
    await shop.drain();
    expect(shop.messages.some(entry => entry.message.qr?.startsWith('SIMULATION'))).toBe(true);
  });
  it('never returns an order belonging to another customer', async () => {
    await shop.stock();
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'order');
    expect((await commands.handle('6282222222222', `status ${order.id}`, 'm1')).text).toContain('tidak ditemukan');
  });
  it('rejects malformed UUIDs without a database error or leaked diagnostics', async () => {
    expect((await commands.handle(customer, 'status ------------------------------------', 'bad-uuid')).text).toContain('ID order tidak valid');
  });
});

describe('authenticated durable webhook inbox', () => {
  const token = 'xendit-test-token-very-long';
  const secret = 'digiflazz-test-secret-very-long';
  function server(mode: 'sandbox' | 'simulation' = 'sandbox') { return createHttp(shop.store, { mode, xenditToken: token, digiflazzSecret: secret }); }

  it('rejects missing or incorrect Xendit tokens before storing events', async () => {
    const app = server();
    const response = await app.inject({ method: 'POST', url: '/webhooks/xendit', payload: { event: 'payment.capture', data: { payment_request_id: 'pr-1' } } });
    expect(response.statusCode).toBe(401);
    expect(await shop.db.query('SELECT * FROM webhook_events')).toHaveLength(0);
    await app.close();
  });
  it('persists and deduplicates a verified event before acknowledging', async () => {
    const app = server();
    const request = { method: 'POST' as const, url: '/webhooks/xendit', headers: { 'x-callback-token': token }, payload: { event: 'payment.capture', data: { payment_request_id: 'pr-1', reference_id: 'reference-1' } } };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(await shop.db.query('SELECT * FROM webhook_events')).toHaveLength(1);
    expect(await shop.db.query("SELECT * FROM jobs WHERE type='PAYMENT_EVENT'")).toHaveLength(1);
    await app.close();
  });
  it('verifies Digiflazz raw bytes, not reconstructed JSON', async () => {
    const app = server();
    const raw = '{ "data": { "ref_id": "reference-1", "status": "Sukses" } }';
    const signature = `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}`;
    expect((await app.inject({ method: 'POST', url: '/webhooks/digiflazz', headers: { 'content-type': 'application/json', 'x-hub-signature': signature }, payload: raw })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/webhooks/digiflazz', headers: { 'content-type': 'application/json', 'x-hub-signature': signature }, payload: '{}' })).statusCode).toBe(401);
    await app.close();
  });
  it('does not expose simulated settlement endpoints or accept provider callbacks in simulation', async () => {
    const app = server('simulation');
    expect((await app.inject({ method: 'POST', url: '/simulation/pay', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/webhooks/xendit', headers: { 'x-callback-token': token }, payload: { event: 'payment.capture', data: { payment_request_id: 'pr-1' } } })).statusCode).toBe(409);
    await app.close();
  });
  it('rejects oversized webhook bodies with a client error', async () => {
    const app = server();
    const response = await app.inject({ method: 'POST', url: '/webhooks/xendit', headers: { 'x-callback-token': token }, payload: { padding: 'x'.repeat(70000) } });
    expect(response.statusCode).toBe(413);
    expect(await shop.db.query('SELECT * FROM webhook_events')).toHaveLength(0);
    await app.close();
  });
});

describe('worker delivery safety', () => {
  it('retains the same allocation when WhatsApp is offline', async () => {
    await shop.stock();
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'a');
    await shop.drain();
    const pending = await shop.store.getOrder(order.id);
    shop.payments.settle(pending.payment_id!);
    await shop.service.reconcile(order.id);
    shop.messenger.send = async () => { throw new Error('offline'); };
    await shop.drain();
    expect((await shop.store.getOrder(order.id)).fulfillment_status).toBe('READY');
    expect(await shop.db.query("SELECT * FROM stock_items WHERE state='SOLD'")).toHaveLength(1);
    expect(await shop.db.query("SELECT * FROM jobs WHERE state='QUEUED' AND job_key LIKE 'delivery:%'")).toHaveLength(1);
  });
  it('does not hand the same job to two concurrent claims', async () => {
    await shop.store.notify('one-job', customer, { text: 'hello' });
    const jobs = await Promise.all([shop.store.claimJob(), shop.store.claimJob()]);
    expect(jobs.filter(Boolean)).toHaveLength(1);
  });
});
