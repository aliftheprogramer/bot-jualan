import { Store, UserError } from './store.js';
import type { Payments, Supplier } from './providers/types.js';

export class ShopService {
  constructor(readonly store: Store, private payments: Payments, private supplier: Supplier, readonly owner: string) {}

  buy(customer: string, code: string, target: string, messageId: string) {
    return this.store.createOrder(customer, code, target, messageId);
  }

  async checkout(id: string) {
    const order = await this.store.getOrder(id);
    if (order.payment_id || order.payment_status === 'SUCCEEDED') return;
    if (!await this.store.startCheckout(id)) {
      await this.reconcile(id);
      return;
    }
    try {
      const payment = await this.payments.create({ id: order.id, amount: order.amount });
      await this.store.observePayment(id, payment, this.owner);
      if (order.cancel_requested) await this.reconcile(id);
    } catch {
      await this.store.markReview(id, this.owner, 'Pembuatan QR belum dapat dipastikan; menunggu rekonsiliasi');
    }
  }

  async reconcile(id: string): Promise<number | undefined> {
    let order = await this.store.getOrder(id);
    if (order.payment_status === 'SUCCEEDED') return;
    const payment = order.payment_id ? await this.payments.get(order.payment_id) : this.payments.find ? await this.payments.find(id) : null;
    if (!payment) {
      if (order.checkout_started) await this.store.markReview(id, this.owner, 'Referensi pembayaran belum ditemukan; perlu pemeriksaan');
      return 30000;
    }
    await this.store.observePayment(id, payment, this.owner);
    order = await this.store.getOrder(id);
    if ((order.cancel_requested || Date.now() - new Date(order.created_at).getTime() > 15 * 60000) && payment.status === 'PENDING' && payment.reference === order.id && payment.amount === order.amount && payment.currency === 'IDR') {
      await this.payments.cancel(payment.id);
      const verified = await this.payments.get(payment.id);
      await this.store.observePayment(id, verified, this.owner);
    }
    order = await this.store.getOrder(id);
    return ['CREATING', 'PENDING', 'REVIEW'].includes(order.payment_status) ? 30000 : undefined;
  }

  async cancel(id: string, customer: string) {
    await this.store.requestCancel(id, customer);
    try { await this.reconcile(id); } catch { throw new UserError('Pembatalan belum terkonfirmasi. Stok tetap direservasi; sistem akan mengecek ulang.'); }
  }

  async fulfill(id: string): Promise<number | undefined> {
    const order = await this.store.getOrder(id);
    if (order.payment_status !== 'SUCCEEDED' || ['READY', 'DELIVERED', 'FAILED', 'REVIEW'].includes(order.fulfillment_status)) return;
    if (order.kind === 'OWN_STOCK') {
      await this.store.deliverOwnStock(id, this.owner);
      return;
    }
    if (!order.sku || !order.max_price || !order.target) throw new Error('Supplier snapshot invalid');
    await this.store.db.query("UPDATE orders SET fulfillment_status='PROCESSING',updated_at=now() WHERE id=$1 AND fulfillment_status IN ('QUEUED','PENDING_SUPPLIER','PROCESSING')", [id]);
    const result = await this.supplier.fulfill({ reference: id, sku: order.sku, target: order.target, maxPrice: order.max_price });
    await this.store.finishSupplier(id, result, this.owner);
    return result.status === 'PENDING' ? 30000 : undefined;
  }

  async syncCatalog() {
    const products = await this.supplier.catalog();
    await this.store.importCatalog(products);
    return products.length;
  }

  async paymentEvent(paymentId?: string, reference?: string) {
    const payment = paymentId ? await this.payments.get(paymentId) : null;
    const order = await this.store.findOrder(paymentId, payment?.reference ?? reference);
    if (!order) throw new Error('Payment event awaiting local order mapping');
    if (payment) await this.store.observePayment(order.id, payment, this.owner);
    await this.reconcile(order.id);
  }

  async recoverPayment(orderId: string, paymentId: string) {
    await this.store.getOrder(orderId);
    if (!paymentId || paymentId.length > 200) throw new UserError('Payment request ID tidak valid');
    await this.store.observePayment(orderId, await this.payments.get(paymentId), this.owner);
    await this.reconcile(orderId);
  }

  async supplierEvent(reference?: string) {
    const order = await this.store.findOrder(undefined, reference);
    if (!order || order.kind !== 'DIGIFLAZZ') throw new Error('Supplier event reference unknown');
    if (order.payment_status !== 'SUCCEEDED') throw new Error('Supplier event awaiting payment verification');
    await this.fulfill(order.id);
  }
}
