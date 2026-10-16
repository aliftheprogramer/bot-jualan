import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixture, customer, owner, type Fixture } from './helpers.js';
import { ShopService } from '../src/service.js';
import { Worker } from '../src/worker.js';

let shop: Fixture;
beforeEach(async () => { shop = await fixture(); }, 20000);
afterEach(async () => { await shop.engine.close(); });

describe('durable order lifecycle', () => {
  it('delivers the reserved stock exactly once despite duplicate payment checks', async () => {
    await shop.stock();
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'message-1');
    await shop.drain();
    const pending = await shop.store.getOrder(order.id, customer);
    expect(pending.payment_status).toBe('PENDING');
    shop.payments.settle(pending.payment_id!);
    await shop.service.reconcile(order.id);
    await shop.service.reconcile(order.id);
    await shop.drain();
    expect((await shop.store.getOrder(order.id, customer)).fulfillment_status).toBe('DELIVERED');
    const deliveries = shop.messages.filter(entry => entry.message.text.includes('SECRET-VOUCHER-0'));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].customer).toBe(customer);
    expect((await shop.store.listProducts())[0].stock).toBe(0);
    expect(await shop.store.summary()).toMatchObject({ paid: 1, delivered: 1, revenue: 15000 });
  });
  it('does not allocate the last stock to two concurrent buyers', async () => {
    await shop.stock();
    const results = await Promise.allSettled([
      shop.service.buy(customer, 'VOUCHER', '', 'a'),
      shop.service.buy('6282222222222', 'VOUCHER', '', 'b'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  it('replayed inbound buy messages reuse the original order and reservation', async () => {
    await shop.stock('VOUCHER', 2);
    const first = await shop.service.buy(customer, 'VOUCHER', '', 'same-message');
    const second = await shop.service.buy(customer, 'VOUCHER', '', 'same-message');
    expect(second.id).toBe(first.id);
    expect((await shop.store.listProducts())[0].stock).toBe(1);
  });
  it('does not let another customer read or cancel an order', async () => {
    await shop.stock();
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'a');
    await expect(shop.store.getOrder(order.id, '6282222222222')).rejects.toThrow();
    await expect(shop.service.cancel(order.id, '6282222222222')).rejects.toThrow();
  });
  it('requires a verified amount and currency before fulfillment', async () => {
    await shop.stock();
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'a');
    await shop.drain();
    const pending = await shop.store.getOrder(order.id);
    shop.payments.payments.set(pending.payment_id!, { ...(await shop.payments.get(pending.payment_id!)), amount: 1, status: 'SUCCEEDED' });
    await shop.service.reconcile(order.id);
    await shop.drain();
    expect((await shop.store.getOrder(order.id)).payment_status).toBe('REVIEW');
    expect(shop.messages.some(entry => entry.message.text.includes('SECRET-'))).toBe(false);
    expect(shop.messages.some(entry => entry.customer === owner && entry.message.text.includes(order.id))).toBe(true);
  });
  it('does not downgrade a successful order when a stale terminal response arrives', async () => {
    await shop.stock();
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'a');
    await shop.drain();
    const pending = await shop.store.getOrder(order.id);
    shop.payments.settle(pending.payment_id!);
    await shop.service.reconcile(order.id);
    shop.payments.payments.set(pending.payment_id!, { ...(await shop.payments.get(pending.payment_id!)), status: 'EXPIRED' });
    await shop.service.reconcile(order.id);
    await shop.drain();
    expect((await shop.store.getOrder(order.id)).payment_status).toBe('SUCCEEDED');
    expect((await shop.store.getOrder(order.id)).fulfillment_status).toBe('DELIVERED');
  });
  it('releases stock only after a provider-confirmed cancellation', async () => {
    await shop.stock();
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'a');
    await shop.drain();
    await shop.service.cancel(order.id, customer);
    expect((await shop.store.getOrder(order.id)).payment_status).toBe('CANCELED');
    expect((await shop.store.listProducts())[0].stock).toBe(1);
  });
  it('requests cancellation for old reservations and waits for provider confirmation', async () => {
    await shop.stock();
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'a');
    await shop.drain();
    await shop.db.query("UPDATE orders SET created_at=now()-interval '16 minutes' WHERE id=$1", [order.id]);
    await shop.service.reconcile(order.id);
    expect((await shop.store.getOrder(order.id)).payment_status).toBe('CANCELED');
    expect((await shop.store.listProducts())[0].stock).toBe(1);
  });
  it('holds stock if the provider cannot confirm cancellation', async () => {
    await shop.stock();
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'a');
    await shop.drain();
    shop.payments.cancel = async () => { throw new Error('Provider offline'); };
    await expect(shop.service.cancel(order.id, customer)).rejects.toThrow('belum terkonfirmasi');
    expect((await shop.store.getOrder(order.id)).payment_status).toBe('PENDING');
    expect((await shop.store.listProducts())[0].stock).toBe(0);
  });
  it('puts a late paid order into review if released stock belongs to someone else', async () => {
    await shop.stock();
    const first = await shop.service.buy(customer, 'VOUCHER', '', 'a');
    await shop.drain();
    const pending = await shop.store.getOrder(first.id);
    await shop.service.cancel(first.id, customer);
    await shop.service.buy('6282222222222', 'VOUCHER', '', 'b');
    shop.payments.payments.set(pending.payment_id!, { ...(await shop.payments.get(pending.payment_id!)), status: 'SUCCEEDED' });
    await shop.service.reconcile(first.id);
    await shop.drain();
    expect((await shop.store.getOrder(first.id)).payment_status).toBe('SUCCEEDED');
    expect((await shop.store.getOrder(first.id)).fulfillment_status).toBe('REVIEW');
    expect(shop.messages.some(entry => entry.message.text.includes('SECRET-'))).toBe(false);
  });
  it('reconciles an ambiguous checkout timeout instead of creating another payment', async () => {
    await shop.stock();
    let calls = 0;
    const realCreate = shop.payments.create.bind(shop.payments);
    shop.payments.create = async input => { calls++; await realCreate(input); throw new Error('Network timeout after provider accepted request'); };
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'a');
    await shop.drain();
    await shop.service.reconcile(order.id);
    expect(calls).toBe(1);
    expect((await shop.store.getOrder(order.id)).payment_status).toBe('PENDING');
    expect((await shop.store.listProducts())[0].stock).toBe(0);
  });
  it('recovers a lost payment request ID from an authenticated callback using status API verification', async () => {
    await shop.stock();
    const provider = {
      create: async (input: { id: string; amount: number }) => { await shop.payments.create(input); throw new Error('Timeout after accepted'); },
      get: shop.payments.get.bind(shop.payments),
      cancel: shop.payments.cancel.bind(shop.payments),
    };
    const service = new ShopService(shop.store, provider, shop.supplier, owner);
    const order = await service.buy(customer, 'VOUCHER', '', 'a');
    await service.checkout(order.id);
    expect((await shop.store.getOrder(order.id)).payment_id).toBeNull();
    const paymentId = `sim-${order.id}`;
    shop.payments.settle(paymentId);
    await service.paymentEvent(paymentId, order.id);
    await shop.drain();
    expect((await shop.store.getOrder(order.id)).payment_status).toBe('SUCCEEDED');
    expect((await shop.store.getOrder(order.id)).fulfillment_status).toBe('DELIVERED');
  });
  it('persists queued stock delivery across application service restarts', async () => {
    await shop.stock();
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'a');
    await shop.drain();
    const pending = await shop.store.getOrder(order.id);
    shop.payments.settle(pending.payment_id!);
    await shop.service.reconcile(order.id);
    const restarted = new ShopService(shop.store, shop.payments, shop.supplier, owner);
    const worker = new Worker(shop.store, restarted, shop.messenger);
    for (let count = 0; count < 20 && await worker.tick(); count++) {}
    expect((await shop.store.getOrder(order.id)).fulfillment_status).toBe('DELIVERED');
  });
  it('encrypts stock and durable message payloads in the database', async () => {
    await shop.stock();
    const order = await shop.service.buy(customer, 'VOUCHER', '', 'a');
    await shop.drain();
    const pending = await shop.store.getOrder(order.id);
    shop.payments.settle(pending.payment_id!);
    await shop.service.reconcile(order.id);
    await shop.drain();
    const rows = await shop.db.query('SELECT payload FROM stock_items UNION ALL SELECT payload FROM jobs');
    expect(JSON.stringify(rows)).not.toContain('SECRET-VOUCHER-0');
  });
});

describe('supplier fulfillment', () => {
  it('validates target and reuses the same ref_id when supplier is pending', async () => {
    await shop.store.addProduct({ code: 'PULSA', name: 'Pulsa demo', category: 'Pulsa', price: 11000, kind: 'DIGIFLAZZ', sku: 'SKU1', maxPrice: 9500, targetType: 'PHONE' });
    await expect(shop.service.buy(customer, 'PULSA', '', 'bad')).rejects.toThrow();
    const order = await shop.service.buy(customer, 'PULSA', '081234567890', 'a');
    await shop.drain();
    const pending = await shop.store.getOrder(order.id);
    shop.payments.settle(pending.payment_id!);
    await shop.service.reconcile(order.id);
    const references: string[] = [];
    shop.supplier.fulfill = async input => {
      references.push(input.reference);
      return { reference: input.reference, status: references.length === 1 ? 'PENDING' : 'SUCCEEDED', result: references.length === 1 ? '' : 'SUPPLIER-SERIAL' };
    };
    await shop.service.fulfill(order.id);
    expect((await shop.store.getOrder(order.id)).fulfillment_status).toBe('PENDING_SUPPLIER');
    await shop.service.fulfill(order.id);
    await shop.drain();
    expect(references).toEqual([order.id, order.id]);
    expect((await shop.store.getOrder(order.id)).fulfillment_status).toBe('DELIVERED');
  });
  it('imports supplier SKUs as inactive products without overwriting owner pricing', async () => {
    await shop.service.syncCatalog();
    const products = await shop.store.listProducts(true);
    expect(products[0]).toMatchObject({ kind: 'DIGIFLAZZ', active: false, price: 0, max_price: 9000 });
    await shop.store.editProduct(products[0].code, { price: 12000, active: true });
    await shop.service.syncCatalog();
    expect((await shop.store.listProducts())[0]).toMatchObject({ price: 12000, active: true });
  });
});
