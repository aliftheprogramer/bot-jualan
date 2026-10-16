import { createHmac, randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import { decrypt, encrypt } from './crypto.js';
import type { OutgoingMessage, Payment, SupplierProduct, SupplierResult } from './providers/types.js';

export class UserError extends Error {}
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export type ProductInput = { code: string; name: string; category: string; price: number; kind: 'OWN_STOCK' | 'DIGIFLAZZ'; sku?: string; maxPrice?: number; targetType?: 'NONE' | 'PHONE' | 'ID' };
export type Product = { code: string; name: string; category: string; price: number; kind: ProductInput['kind']; active: boolean; sku: string | null; max_price: number | null; supplier_available: boolean; target_type: 'NONE' | 'PHONE' | 'ID'; stock: number };
export type Order = { id: string; customer: string; product_code: string; product_name: string; kind: ProductInput['kind']; amount: number; target: string; sku: string | null; max_price: number | null; payment_id: string | null; payment_status: string; fulfillment_status: string; cancel_requested: boolean; checkout_started: boolean; result: string | null; created_at: Date };
export type Job = { id: string; type: string; order_id: string | null; payload: string; attempts: number; lease_token: string };
export type JobPayload = { customer?: string; message?: OutgoingMessage; delivery?: boolean; paymentId?: string; reference?: string; text?: string; messageKey?: string };

export class Store {
  constructor(readonly db: Database, private key: string) {}

  private transaction<Value>(task: (store: Store) => Promise<Value>) {
    return this.db.transaction(db => task(new Store(db, this.key)));
  }

  async addProduct(product: ProductInput) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(product.code) || !product.name.trim() || product.name.length > 150 || !product.category.trim() || product.category.length > 80 || !Number.isSafeInteger(product.price) || product.price <= 0 || product.price > 100000000) throw new UserError('Produk/harga tidak valid');
    if (product.kind === 'DIGIFLAZZ' && (!product.sku || product.sku.length > 100 || !Number.isSafeInteger(product.maxPrice) || product.maxPrice! <= 0 || product.maxPrice! > product.price || !['PHONE', 'ID'].includes(product.targetType ?? ''))) throw new UserError('Produk supplier membutuhkan SKU, max harga biaya <= harga jual, dan jenis tujuan');
    const inserted = await this.db.query('INSERT INTO products (code,name,category,price,kind,sku,max_price,target_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING code', [product.code.toUpperCase(), product.name.trim(), product.category.trim(), product.price, product.kind, product.sku ?? null, product.maxPrice ?? null, product.targetType ?? 'NONE']);
    if (!inserted.length) throw new UserError('Kode produk atau SKU sudah ada; gunakan editproduct');
  }

  async editProduct(code: string, change: { price?: number; active?: boolean; maxPrice?: number; name?: string; category?: string }) {
    const products = await this.db.query<Product>('SELECT * FROM products WHERE code=$1', [code.toUpperCase()]);
    if (!products.length) throw new UserError('Produk tidak ditemukan');
    const product = products[0];
    const price = change.price ?? product.price;
    const maxPrice = change.maxPrice ?? product.max_price;
    const name = change.name?.trim() ?? product.name;
    const category = change.category?.trim() ?? product.category;
    if (!Number.isSafeInteger(price) || price <= 0 || price > 100000000 || !name || name.length > 150 || !category || category.length > 80 || (maxPrice !== null && (!Number.isSafeInteger(maxPrice) || maxPrice <= 0 || maxPrice > price))) throw new UserError('Harga/nama/batas biaya tidak valid');
    await this.db.query('UPDATE products SET price=$2, active=$3, max_price=$4, name=$5, category=$6 WHERE code=$1', [product.code, price, change.active ?? product.active, maxPrice, name, category]);
  }

  async addStock(code: string, payload: string) {
    if (!payload.trim() || payload.length > 10000) throw new UserError('Isi stok kosong/terlalu panjang');
    const products = await this.db.query<Product>('SELECT * FROM products WHERE code=$1', [code.toUpperCase()]);
    if (!products.length || products[0].kind !== 'OWN_STOCK') throw new UserError('Stok hanya untuk produk OWN_STOCK');
    const hash = createHmac('sha256', Buffer.from(this.key, 'base64')).update(payload.trim()).digest('hex');
    const rows = await this.db.query('INSERT INTO stock_items (id,product_code,payload,payload_hash) VALUES ($1,$2,$3,$4) ON CONFLICT(product_code,payload_hash) DO NOTHING RETURNING id', [randomUUID(), products[0].code, encrypt(payload.trim(), this.key), hash]);
    if (!rows.length) throw new UserError('Stok duplikat');
  }

  async listProducts(includeInactive = false): Promise<Product[]> {
    return this.db.query<Product>(`SELECT p.*, (SELECT count(*)::integer FROM stock_items s WHERE s.product_code=p.code AND s.state='AVAILABLE') AS stock FROM products p WHERE ($1 OR (p.active AND p.price>0)) ORDER BY p.category,p.code`, [includeInactive]);
  }

  async createOrder(customer: string, code: string, target: string, requestKey: string): Promise<Order> {
    if (!/^\d{8,15}$/.test(customer) || !requestKey || requestKey.length > 250) throw new UserError('Identitas pesan tidak valid');
    return this.transaction(async transaction => {
      await transaction.db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [customer]);
      const previous = await transaction.db.query<Order>('SELECT * FROM orders WHERE request_key=$1', [`${customer}:${requestKey}`]);
      if (previous.length) return previous[0];
      const [pendingCount] = await transaction.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM orders WHERE customer=$1 AND payment_status IN ('CREATING','PENDING','REVIEW')", [customer]);
      if (pendingCount.count >= 3) throw new UserError('Maksimal 3 order belum selesai. Selesaikan atau batalkan order sebelumnya.');
      const products = await transaction.db.query<Product>('SELECT * FROM products WHERE code=$1 AND active AND price>0 FOR SHARE', [code.toUpperCase()]);
      const product = products[0];
      if (!product) throw new UserError('Produk tidak tersedia');
      if (product.kind === 'DIGIFLAZZ' && !product.supplier_available) throw new UserError('Supplier sedang tidak tersedia');
      if (product.target_type === 'PHONE' && !/^\d{8,16}$/.test(target)) throw new UserError('Tujuan harus nomor telepon 8–16 digit');
      if (product.target_type === 'ID' && !/^[A-Za-z0-9._-]{1,64}$/.test(target)) throw new UserError('ID tujuan tidak valid');
      if (product.target_type === 'NONE' && target) throw new UserError('Produk ini tidak membutuhkan tujuan');
      const id = randomUUID();
      const inserted = await transaction.db.query<Order>(`INSERT INTO orders(id,customer,request_key,product_code,product_name,kind,amount,target,sku,max_price) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(request_key) DO NOTHING RETURNING *`, [id, customer, `${customer}:${requestKey}`, product.code, product.name, product.kind, product.price, target, product.sku, product.max_price]);
      if (!inserted.length) return (await transaction.db.query<Order>('SELECT * FROM orders WHERE request_key=$1', [`${customer}:${requestKey}`]))[0];
      if (product.kind === 'OWN_STOCK') {
        const stock = await transaction.db.query<{ id: string }>("SELECT id FROM stock_items WHERE product_code=$1 AND state='AVAILABLE' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1", [product.code]);
        if (!stock.length) throw new UserError('Stok habis');
        await transaction.db.query("UPDATE stock_items SET state='RESERVED',order_id=$2 WHERE id=$1", [stock[0].id, id]);
      }
      await transaction.enqueue(`checkout:${id}`, 'CHECKOUT', id);
      await transaction.enqueue(`reconcile:${id}`, 'RECONCILE', id, {}, 30000);
      return inserted[0];
    });
  }

  async getOrder(id: string, customer?: string): Promise<Order> {
    if (!isUuid(id)) throw new UserError('ID order tidak valid');
    const orders = await this.db.query<Order>('SELECT * FROM orders WHERE id=$1 AND ($2::text IS NULL OR customer=$2)', [id, customer ?? null]);
    if (!orders.length) throw new UserError('Order tidak ditemukan');
    return orders[0];
  }

  async findOrder(paymentId?: string, reference?: string): Promise<Order | null> {
    if (reference && isUuid(reference)) {
      const rows = await this.db.query<Order>('SELECT * FROM orders WHERE id=$1', [reference]);
      if (rows.length) return rows[0];
    }
    if (!paymentId) return null;
    return (await this.db.query<Order>('SELECT * FROM orders WHERE payment_id=$1', [paymentId]))[0] ?? null;
  }

  async startCheckout(id: string): Promise<boolean> {
    return (await this.db.query('UPDATE orders SET checkout_started=true,updated_at=now() WHERE id=$1 AND NOT checkout_started RETURNING id', [id])).length > 0;
  }

  async observePayment(id: string, payment: Payment, owner: string) {
    await this.transaction(async transaction => {
      const order = (await transaction.db.query<Order>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]))[0];
      if (!order) throw new Error('Order unavailable');
      if (order.payment_status === 'SUCCEEDED') return;
      if (payment.reference !== order.id || payment.amount !== order.amount || payment.currency !== 'IDR' || (order.payment_id && order.payment_id !== payment.id)) {
        await transaction.db.query("UPDATE orders SET payment_status='REVIEW',updated_at=now() WHERE id=$1", [id]);
        await transaction.notifyReview(order, owner, 'Data pembayaran tidak cocok');
        return;
      }
      if (['FAILED', 'EXPIRED', 'CANCELED'].includes(order.payment_status) && payment.status !== 'SUCCEEDED') return;
      await transaction.db.query('UPDATE orders SET payment_id=$2,payment_status=$3,updated_at=now() WHERE id=$1', [id, payment.id, payment.status]);
      if (payment.status === 'PENDING' && payment.qr) {
        await transaction.notify(`qr:${id}`, order.customer, {
          text: `Order ${id}\n${order.product_name}\nTotal: Rp${order.amount.toLocaleString('id-ID')}\n${payment.qr.startsWith('SIMULATION') ? '[SIMULASI — JANGAN DIBAYAR]\n' : ''}${payment.expiresAt ? `Batas provider: ${payment.expiresAt}\n` : ''}Bayar hanya sekali. Status diproses otomatis.\nCek: status ${id}`,
          qr: payment.qr,
        }, id);
      }
      if (payment.status === 'SUCCEEDED') {
        await transaction.db.query("UPDATE orders SET fulfillment_status='QUEUED' WHERE id=$1 AND fulfillment_status='NOT_STARTED'", [id]);
        await transaction.enqueue(`fulfill:${id}`, 'FULFILL', id);
      }
      if (['FAILED', 'EXPIRED', 'CANCELED'].includes(payment.status)) {
        await transaction.db.query("UPDATE stock_items SET state='AVAILABLE',order_id=NULL WHERE order_id=$1 AND state='RESERVED'", [id]);
        await transaction.notify(`terminal:${id}`, order.customer, { text: `Order ${id}: pembayaran ${payment.status}. Tidak ada produk yang dikirim.` }, id);
      }
    });
  }

  async markReview(id: string, owner: string, reason: string) {
    await this.transaction(async transaction => {
      const order = (await transaction.db.query<Order>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]))[0];
      if (!order || order.fulfillment_status === 'DELIVERED') return;
      await transaction.db.query("UPDATE orders SET payment_status=CASE WHEN payment_status='SUCCEEDED' THEN payment_status ELSE 'REVIEW' END, updated_at=now() WHERE id=$1", [id]);
      await transaction.notifyReview(order, owner, reason);
    });
  }

  private async notifyReview(order: Order, owner: string, reason: string) {
    await this.notify(`review-owner:${order.id}`, owner, { text: `Perlu review order ${order.id}: ${reason}. Jangan buat transaksi supplier baru sebelum rekonsiliasi.` }, order.id);
    await this.notify(`review-customer:${order.id}`, order.customer, { text: `Order ${order.id} perlu pemeriksaan admin. Jangan membayar ulang; hubungi owner.` }, order.id);
  }

  async requestCancel(id: string, customer: string) {
    const order = await this.getOrder(id, customer);
    if (order.payment_status === 'SUCCEEDED') throw new UserError('Order sudah dibayar; hubungi owner untuk bantuan');
    await this.db.query('UPDATE orders SET cancel_requested=true,updated_at=now() WHERE id=$1', [id]);
  }

  async deliverOwnStock(id: string, owner: string) {
    await this.transaction(async transaction => {
      const order = (await transaction.db.query<Order>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]))[0];
      if (!order || order.payment_status !== 'SUCCEEDED' || ['READY', 'DELIVERED', 'REVIEW'].includes(order.fulfillment_status)) return;
      let stock = (await transaction.db.query<{ id: string; payload: string }>('SELECT id,payload FROM stock_items WHERE order_id=$1 FOR UPDATE', [id]))[0];
      if (!stock) stock = (await transaction.db.query<{ id: string; payload: string }>("SELECT id,payload FROM stock_items WHERE product_code=$1 AND state='AVAILABLE' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1", [order.product_code]))[0];
      if (!stock) {
        await transaction.db.query("UPDATE orders SET fulfillment_status='REVIEW' WHERE id=$1", [id]);
        await transaction.notifyReview(order, owner, 'Pembayaran sukses, stok tidak tersedia');
        return;
      }
      await transaction.db.query("UPDATE stock_items SET state='SOLD',order_id=$2 WHERE id=$1", [stock.id, id]);
      await transaction.ready(order, stock.payload);
    });
  }

  async finishSupplier(id: string, result: SupplierResult, owner: string) {
    await this.transaction(async transaction => {
      const order = (await transaction.db.query<Order>('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]))[0];
      if (!order || order.payment_status !== 'SUCCEEDED' || ['READY', 'DELIVERED', 'FAILED', 'REVIEW'].includes(order.fulfillment_status)) return;
      if (result.reference !== id) throw new Error('Supplier reference mismatch');
      if (result.status === 'SUCCEEDED') {
        if (!result.result) throw new Error('Supplier result unavailable');
        await transaction.ready(order, encrypt(result.result, this.key));
      } else {
        await transaction.db.query('UPDATE orders SET fulfillment_status=$2,updated_at=now() WHERE id=$1', [id, result.status === 'PENDING' ? 'PENDING_SUPPLIER' : 'FAILED']);
        if (result.status === 'FAILED') await transaction.notifyReview(order, owner, 'Supplier gagal setelah pembayaran; perlu refund/penanganan manual');
      }
    });
  }

  private async ready(order: Order, encryptedResult: string) {
    await this.db.query("UPDATE orders SET result=$2,fulfillment_status='READY',updated_at=now() WHERE id=$1", [order.id, encryptedResult]);
    await this.notify(`delivery:${order.id}`, order.customer, { text: `Pembelian berhasil!\nOrder: ${order.id}\nProduk: ${order.product_name}\n\n${decrypt(encryptedResult, this.key)}\n\nSimpan informasi ini secara pribadi.` }, order.id, true);
  }

  async importCatalog(products: SupplierProduct[]) {
    await this.transaction(async transaction => {
      for (const product of products) {
        const hash = createHmac('sha256', 'catalog-code').update(product.sku).digest('hex').slice(0, 20).toUpperCase();
        await transaction.db.query(`INSERT INTO products(code,name,category,price,kind,active,sku,max_price,supplier_cost,supplier_available,target_type) VALUES($1,$2,$3,0,'DIGIFLAZZ',false,$4,$5,$5,$6,'ID') ON CONFLICT(sku) DO UPDATE SET supplier_cost=excluded.supplier_cost,supplier_available=excluded.supplier_available`, [`DF-${hash}`, product.name.slice(0, 150), product.category.slice(0, 80), product.sku, product.cost, product.available]);
      }
    });
  }

  async summary() {
    const [summary] = await this.db.query<{ paid: number; delivered: number; revenue: number }>("SELECT count(*) FILTER(WHERE payment_status='SUCCEEDED')::integer AS paid,count(*) FILTER(WHERE fulfillment_status='DELIVERED')::integer AS delivered,coalesce(sum(amount) FILTER(WHERE payment_status='SUCCEEDED'),0)::bigint::text AS revenue FROM orders");
    return { ...summary, revenue: Number(summary.revenue) };
  }

  async recentOrders() { return this.db.query<Order>('SELECT * FROM orders ORDER BY created_at DESC LIMIT 20'); }

  async audit(actor: string, action: string, resource: string) {
    await this.db.query('INSERT INTO audit_events(id,actor,action,resource) VALUES($1,$2,$3,$4)', [randomUUID(), actor, action, resource.slice(0, 100)]);
  }

  async cachedReply(customer: string, messageId: string): Promise<OutgoingMessage | null> {
    const [row] = await this.db.query<{ response: string | null }>('SELECT response FROM incoming_messages WHERE message_key=$1 AND customer=$2', [`${customer}:${messageId}`, customer]);
    return row?.response ? JSON.parse(decrypt(row.response, this.key)) : null;
  }

  async recordReply(customer: string, messageId: string, reply: OutgoingMessage) {
    await this.db.query('INSERT INTO incoming_messages(message_key,customer,response) VALUES($1,$2,$3) ON CONFLICT(message_key) DO NOTHING', [`${customer}:${messageId}`, customer, encrypt(JSON.stringify(reply), this.key)]);
  }

  async commandRateAllowed(customer: string) {
    const [row] = await this.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM incoming_messages WHERE customer=$1 AND created_at>now()-interval '1 minute'", [customer]);
    return row.count < 40;
  }

  async saveMenu(customer: string, categories: string[]) {
    await this.db.query("INSERT INTO menu_sessions(customer,categories,expires_at) VALUES($1,$2,now()+interval '30 minutes') ON CONFLICT(customer) DO UPDATE SET categories=excluded.categories,expires_at=excluded.expires_at", [customer, JSON.stringify(categories)]);
  }

  async menuCategory(customer: string, index: number) {
    const [row] = await this.db.query<{ categories: string[] }>('SELECT categories FROM menu_sessions WHERE customer=$1 AND expires_at>now()', [customer]);
    return row?.categories[index - 1];
  }

  async acceptCommand(customer: string, text: string, messageKey: string) {
    if (!/^\d{8,15}$/.test(customer) || text.length > 12000 || !messageKey || messageKey.length > 150) return;
    await this.transaction(async transaction => {
      await transaction.db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [customer]);
      const [recent] = await transaction.db.query<{ count: number }>("SELECT count(*)::integer AS count FROM jobs WHERE type='COMMAND' AND job_key LIKE $1 AND created_at>now()-interval '1 minute'", [`command:${customer}:%`]);
      if (recent.count >= 40) return;
      await transaction.enqueue(`command:${customer}:${messageKey}`, 'COMMAND', null, { customer, text, messageKey });
    });
  }

  async notify(jobKey: string, customer: string, message: OutgoingMessage, orderId: string | null = null, delivery = false) {
    return this.enqueue(jobKey, 'NOTIFY', orderId, { customer, message, delivery });
  }

  async enqueue(jobKey: string, type: string, orderId: string | null, payload: JobPayload = {}, delayMs = 0): Promise<string> {
    const id = randomUUID();
    const rows = await this.db.query<{ id: string }>(`INSERT INTO jobs(id,job_key,type,order_id,payload,run_at) VALUES($1,$2,$3,$4,$5,now()+$6 * interval '1 millisecond') ON CONFLICT(job_key) DO UPDATE SET job_key=excluded.job_key RETURNING id`, [id, jobKey, type, orderId, encrypt(JSON.stringify(payload), this.key), delayMs]);
    return rows[0].id;
  }

  async acceptEvent(provider: 'xendit' | 'digiflazz', hash: string, payload: JobPayload): Promise<void> {
    await this.transaction(async transaction => {
      const job = await transaction.enqueue(`event:${provider}:${hash}`, provider === 'xendit' ? 'PAYMENT_EVENT' : 'SUPPLIER_EVENT', null, payload);
      await transaction.db.query('INSERT INTO webhook_events(event_key,provider,payload_hash,job_id) VALUES($1,$2,$3,$4) ON CONFLICT(event_key) DO NOTHING', [`${provider}:${hash}`, provider, hash, job]);
    });
  }

  async claimJob(): Promise<Job | null> {
    const token = randomUUID();
    return (await this.db.query<Job>(`WITH candidate AS (SELECT id FROM jobs WHERE (state='QUEUED' AND run_at<=now()) OR (state='RUNNING' AND lease_until<now()) ORDER BY run_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs SET state='RUNNING',lease_until=now()+interval '120 seconds',lease_token=$1,attempts=attempts+1 FROM candidate WHERE jobs.id=candidate.id RETURNING jobs.*`, [token]))[0] ?? null;
  }

  payload(job: Job): JobPayload { return JSON.parse(decrypt(job.payload, this.key)); }

  async finishJob(job: Job, delayMs?: number) {
    await this.transaction(async transaction => {
      const updated = await transaction.db.query('UPDATE jobs SET state=$3,run_at=now()+$4 * interval \'1 millisecond\',lease_until=NULL,lease_token=NULL,attempts=CASE WHEN $5 THEN 0 ELSE attempts END WHERE id=$1 AND lease_token=$2 RETURNING id', [job.id, job.lease_token, delayMs === undefined ? 'DONE' : 'QUEUED', delayMs ?? 0, delayMs !== undefined]);
      if (updated.length && delayMs === undefined && job.type === 'NOTIFY' && transaction.payload(job).delivery && job.order_id) await transaction.db.query("UPDATE orders SET fulfillment_status='DELIVERED',updated_at=now() WHERE id=$1 AND fulfillment_status='READY'", [job.order_id]);
    });
  }

  async failJob(job: Job) {
    await this.db.query("UPDATE jobs SET state=$3,last_error='Task failed; check provider/connectivity or owner review',run_at=now()+$4 * interval '1 millisecond',lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2", [job.id, job.lease_token, job.attempts >= 10 ? 'DEAD' : 'QUEUED', Math.min(300000, 1000 * 2 ** job.attempts)]);
  }

  async retryDelivery(id: string) {
    const order = await this.getOrder(id);
    if (!order.result || !['READY', 'DELIVERED'].includes(order.fulfillment_status)) throw new UserError('Belum ada produk yang dapat dikirim ulang');
    await this.db.query("UPDATE jobs SET state='QUEUED',attempts=0,run_at=now(),last_error=NULL WHERE job_key=$1 AND state IN ('DONE','DEAD')", [`delivery:${id}`]);
  }
}
