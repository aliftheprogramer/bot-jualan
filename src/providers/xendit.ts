import { ProviderError, type Payment, type Payments } from './types.js';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('Xendit', 'INVALID_RESPONSE');
  return value as JsonObject;
}

export class Xendit implements Payments {
  constructor(private key: string, private request: typeof fetch = fetch) {}

  private async call(path: string, method = 'GET', body?: JsonObject): Promise<unknown> {
    const response = await this.request(`https://api.xendit.co${path}`, {
      method, headers: { authorization: `Basic ${Buffer.from(`${this.key}:`).toString('base64')}`, 'content-type': 'application/json', 'api-version': '2024-11-11' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new ProviderError('Xendit', `HTTP_${response.status}`);
    if (response.status === 204) return {};
    return response.json();
  }

  private parse(raw: unknown): Payment {
    const data = object(raw);
    const statuses: Record<string, Payment['status']> = {
      REQUIRES_ACTION: 'PENDING', ACCEPTING_PAYMENTS: 'PENDING', PENDING: 'PENDING', AUTHORIZED: 'PENDING',
      SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', EXPIRED: 'EXPIRED', CANCELED: 'CANCELED',
    };
    const status = typeof data.status === 'string' ? statuses[data.status] : undefined;
    if (!status || typeof data.payment_request_id !== 'string' || typeof data.reference_id !== 'string' || !Number.isSafeInteger(data.request_amount) || Number(data.request_amount) <= 0 || data.currency !== 'IDR') throw new ProviderError('Xendit', 'INVALID_RESPONSE');
    const actions = Array.isArray(data.actions) ? data.actions.map(object) : [];
    const qr = actions.find(action => action.descriptor === 'QR_STRING' && typeof action.value === 'string')?.value;
    const properties = data.channel_properties && typeof data.channel_properties === 'object' ? object(data.channel_properties) : {};
    const expiresAt = typeof properties.expires_at === 'string' && !Number.isNaN(Date.parse(properties.expires_at)) ? properties.expires_at : undefined;
    return { id: data.payment_request_id, reference: data.reference_id, amount: Number(data.request_amount), currency: 'IDR', status, qr: typeof qr === 'string' ? qr : undefined, expiresAt };
  }

  async create(order: { id: string; amount: number }): Promise<Payment> {
    const payment = this.parse(await this.call('/v3/payment_requests', 'POST', {
      reference_id: order.id, type: 'PAY', country: 'ID', currency: 'IDR', request_amount: order.amount,
      capture_method: 'AUTOMATIC', channel_code: 'QRIS',
    }));
    if (payment.status === 'PENDING' && !payment.qr) throw new ProviderError('Xendit', 'QR_NOT_AVAILABLE');
    return payment;
  }

  async get(id: string): Promise<Payment> {
    return this.parse(await this.call(`/v3/payment_requests/${encodeURIComponent(id)}`));
  }

  async cancel(id: string): Promise<void> {
    await this.call(`/v3/payment_requests/${encodeURIComponent(id)}/cancel`, 'POST', {});
  }
}
