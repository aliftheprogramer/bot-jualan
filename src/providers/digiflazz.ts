import { createHash, createHmac } from 'node:crypto';
import { safeEqual } from '../crypto.js';
import { ProviderError, type Supplier, type SupplierInput, type SupplierProduct, type SupplierResult } from './types.js';

export function verifyDigiflazz(raw: Buffer, signature: string | undefined, secret: string): boolean {
  return safeEqual(signature, `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}`);
}

export class Digiflazz implements Supplier {
  constructor(private username: string, private key: string, private mode: 'sandbox' | 'live', private request: typeof fetch = fetch) {}

  private async call(path: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.request(`https://api.digiflazz.com/v1/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new ProviderError('Digiflazz', `HTTP_${response.status}`);
    const result = await response.json() as { data?: unknown };
    if (!result || !result.data) throw new ProviderError('Digiflazz', 'INVALID_RESPONSE');
    return result.data;
  }

  async fulfill(input: SupplierInput): Promise<SupplierResult> {
    const data = await this.call('transaction', {
      username: this.username, buyer_sku_code: input.sku, customer_no: input.target,
      ref_id: input.reference, max_price: input.maxPrice, testing: this.mode === 'sandbox',
      sign: createHash('md5').update(`${this.username}${this.key}${input.reference}`).digest('hex'),
    }) as Record<string, unknown>;
    const statuses: Record<string, SupplierResult['status']> = { Sukses: 'SUCCEEDED', Pending: 'PENDING', Gagal: 'FAILED' };
    const status = typeof data.status === 'string' ? statuses[data.status] : undefined;
    if (!status || data.ref_id !== input.reference || (status === 'SUCCEEDED' && (typeof data.sn !== 'string' || !data.sn))) throw new ProviderError('Digiflazz', 'INVALID_RESPONSE');
    return { reference: input.reference, status, result: typeof data.sn === 'string' ? data.sn : '' };
  }

  async catalog(): Promise<SupplierProduct[]> {
    const raw = await this.call('price-list', { cmd: 'prepaid', username: this.username, sign: createHash('md5').update(`${this.username}${this.key}pricelist`).digest('hex') });
    if (!Array.isArray(raw)) throw new ProviderError('Digiflazz', 'INVALID_CATALOG');
    return raw.map((item: Record<string, unknown>) => {
      if (typeof item.buyer_sku_code !== 'string' || typeof item.product_name !== 'string' || !Number.isSafeInteger(item.price) || Number(item.price) <= 0) throw new ProviderError('Digiflazz', 'INVALID_CATALOG');
      return { sku: item.buyer_sku_code, name: item.product_name, category: typeof item.category === 'string' ? item.category : 'Supplier', cost: Number(item.price), available: item.buyer_product_status === true && item.seller_product_status === true && (item.unlimited_stock === true || Number(item.stock) > 0) };
    });
  }
}
