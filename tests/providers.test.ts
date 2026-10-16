import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { Xendit } from '../src/providers/xendit.js';
import { Digiflazz, verifyDigiflazz } from '../src/providers/digiflazz.js';

const key = Buffer.alloc(32, 7).toString('base64');
const base = { DATABASE_URL: 'postgresql://localhost/shop', STOCK_KEY: key, OWNER_NUMBER: '6281234567890' };

describe('configuration and stock encryption', () => {
  it('defaults to simulation with WhatsApp disabled', () => {
    const config = readConfig(base);
    expect(config.mode).toBe('simulation');
    expect(config.whatsappEnabled).toBe(false);
  });
  it('refuses live mode without provider credentials and explicit acknowledgement', () => {
    expect(() => readConfig({ ...base, APP_MODE: 'live' })).toThrow();
  });
  it('rejects missing owners, invalid keys and unrecognized modes', () => {
    expect(() => readConfig({ ...base, OWNER_NUMBER: '' })).toThrow();
    expect(() => readConfig({ ...base, STOCK_KEY: 'bad' })).toThrow();
    expect(() => readConfig({ ...base, APP_MODE: 'production' })).toThrow();
  });
  it('encrypts stock with authenticated encryption', () => {
    const encrypted = encrypt('voucher-secret', key);
    expect(encrypted).not.toContain('voucher-secret');
    expect(decrypt(encrypted, key)).toBe('voucher-secret');
    expect(encrypt('voucher-secret', key)).not.toBe(encrypted);
    expect(() => decrypt(encrypted, Buffer.alloc(32, 8).toString('base64'))).toThrow();
  });
});

describe('Xendit Payments V3', () => {
  it('creates an IDR QRIS request and parses the QR action', async () => {
    let body: Record<string, unknown> = {};
    const provider = new Xendit('secret', async (input, init) => {
      expect(String(input)).toBe('https://api.xendit.co/v3/payment_requests');
      body = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from('secret:').toString('base64')}`);
      expect(new Headers(init?.headers).get('api-version')).toBe('2024-11-11');
      return Response.json({ payment_request_id: 'pr-1', reference_id: 'order-1', request_amount: 15000, currency: 'IDR', status: 'REQUIRES_ACTION', actions: [{ type: 'PRESENT_TO_CUSTOMER', descriptor: 'QR_STRING', value: '000201-qris' }] });
    });
    const payment = await provider.create({ id: 'order-1', amount: 15000 });
    expect(body).toMatchObject({ reference_id: 'order-1', request_amount: 15000, currency: 'IDR', country: 'ID', channel_code: 'QRIS', type: 'PAY', capture_method: 'AUTOMATIC' });
    expect(payment).toMatchObject({ id: 'pr-1', reference: 'order-1', amount: 15000, qr: '000201-qris', status: 'PENDING' });
  });
  it('normalizes terminal status only from the authenticated status API', async () => {
    const provider = new Xendit('secret', async () => Response.json({ payment_request_id: 'pr-1', reference_id: 'order-1', request_amount: 15000, currency: 'IDR', status: 'SUCCEEDED' }));
    expect(await provider.get('pr-1')).toMatchObject({ status: 'SUCCEEDED', amount: 15000 });
  });
  it('fails closed for malformed responses or unavailable QR actions', async () => {
    const provider = new Xendit('secret', async () => Response.json({ payment_request_id: 'pr-1', reference_id: 'order-1', request_amount: 15000, currency: 'MYR', status: 'REQUIRES_ACTION', actions: [] }));
    await expect(provider.create({ id: 'order-1', amount: 15000 })).rejects.toThrow();
  });
  it('does not reinterpret an unknown provider status as paid', async () => {
    const provider = new Xendit('secret', async () => Response.json({ payment_request_id: 'pr-1', reference_id: 'order-1', request_amount: 15000, currency: 'IDR', status: 'SURPRISE' }));
    await expect(provider.get('pr-1')).rejects.toThrow();
  });
});

describe('Digiflazz Buyer', () => {
  it('uses a stable reference, signed request and supplier price limit', async () => {
    const provider = new Digiflazz('buyer', 'api-key', 'live', async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ username: 'buyer', buyer_sku_code: 'SKU1', customer_no: '081234567890', ref_id: 'order-1', max_price: 9000 });
      expect(body.sign).toBe(createHash('md5').update('buyerapi-keyorder-1').digest('hex'));
      expect(body.testing).toBe(false);
      return Response.json({ data: { ref_id: 'order-1', status: 'Pending', rc: '03', message: 'Pending', sn: '' } });
    });
    expect(await provider.fulfill({ reference: 'order-1', sku: 'SKU1', target: '081234567890', maxPrice: 9000 })).toEqual({ reference: 'order-1', status: 'PENDING', result: '' });
  });
  it('rejects supplier results for another reference', async () => {
    const provider = new Digiflazz('buyer', 'api-key', 'sandbox', async () => Response.json({ data: { ref_id: 'other', status: 'Sukses', sn: 'secret' } }));
    await expect(provider.fulfill({ reference: 'order-1', sku: 'SKU1', target: '081234567890', maxPrice: 9000 })).rejects.toThrow();
  });
  it('verifies HMAC using the untouched request body', () => {
    const raw = Buffer.from('{ "data": {"status":"Sukses"} }');
    const signature = `sha1=${createHmac('sha1', 'hook-secret').update(raw).digest('hex')}`;
    expect(verifyDigiflazz(raw, signature, 'hook-secret')).toBe(true);
    expect(verifyDigiflazz(Buffer.from('{}'), signature, 'hook-secret')).toBe(false);
    expect(verifyDigiflazz(raw, undefined, 'hook-secret')).toBe(false);
  });
});
