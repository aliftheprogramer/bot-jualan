import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import type { Config } from './config.js';
import { safeEqual } from './crypto.js';
import { verifyDigiflazz } from './providers/digiflazz.js';
import type { Store } from './store.js';

type HttpConfig = Pick<Config, 'mode' | 'xenditToken' | 'digiflazzSecret'>;
const text = (value: unknown) => typeof value === 'string' && value.length <= 200 ? value : undefined;

export function createHttp(store: Store, config: HttpConfig) {
  const app = Fastify({ logger: false, bodyLimit: 65536, requestTimeout: 20000 });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  const requests = new Map<string, { count: number; reset: number }>();
  app.addHook('onRequest', async (request, reply) => {
    const now = Date.now();
    if (requests.size > 1000) for (const [ip, value] of requests) if (value.reset < now) requests.delete(ip);
    const entry = requests.get(request.ip);
    const current = entry && entry.reset > now ? entry : { count: 0, reset: now + 60000 };
    current.count++;
    requests.set(request.ip, current);
    if (current.count > 600) return reply.code(429).send({ error: 'Rate limited' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    reply.code(status && status >= 400 && status < 500 ? status : 500).send({ error: 'Request could not be processed' });
  });
  app.get('/health', async (_request, reply) => {
    try { await store.db.query('SELECT 1'); return { status: 'ok', mode: config.mode }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  app.post('/webhooks/xendit', async (request, reply) => {
    if (config.mode === 'simulation') return reply.code(409).send({ error: 'Simulation does not accept provider callbacks' });
    const token = typeof request.headers['x-callback-token'] === 'string' ? request.headers['x-callback-token'] : undefined;
    if (!safeEqual(token, config.xenditToken)) return reply.code(401).send({ error: 'Unauthorized' });
    const raw = request.body;
    if (!Buffer.isBuffer(raw)) return reply.code(400).send({ error: 'Expected JSON' });
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ error: 'Invalid JSON' }); }
    if (!body || typeof body.event !== 'string' || !body.data || typeof body.data !== 'object') return reply.code(400).send({ error: 'Invalid event' });
    const paymentId = text(body.data.payment_request_id);
    const reference = text(body.data.reference_id);
    if (!paymentId && !reference) return reply.code(400).send({ error: 'Missing reference' });
    await store.acceptEvent('xendit', createHash('sha256').update(raw).digest('hex'), { paymentId, reference });
    return { received: true };
  });
  app.post('/webhooks/digiflazz', async (request, reply) => {
    if (config.mode === 'simulation') return reply.code(409).send({ error: 'Simulation does not accept provider callbacks' });
    const raw = request.body;
    const signature = typeof request.headers['x-hub-signature'] === 'string' ? request.headers['x-hub-signature'] : undefined;
    if (!Buffer.isBuffer(raw) || !verifyDigiflazz(raw, signature, config.digiflazzSecret)) return reply.code(401).send({ error: 'Unauthorized' });
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ error: 'Invalid JSON' }); }
    const reference = text(body?.data?.ref_id);
    if (!reference) return reply.code(400).send({ error: 'Missing reference' });
    await store.acceptEvent('digiflazz', createHash('sha256').update(raw).digest('hex'), { reference });
    return { received: true };
  });
  return app;
}
