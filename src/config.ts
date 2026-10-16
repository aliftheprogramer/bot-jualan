import { randomBytes } from 'node:crypto';

export type Mode = 'simulation' | 'sandbox' | 'live';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.APP_MODE ?? 'simulation';
  if (!['simulation', 'sandbox', 'live'].includes(mode)) throw new Error('APP_MODE tidak valid');
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} wajib diisi lokal`);
    return value;
  };
  const owner = required('OWNER_NUMBER');
  if (!/^62\d{8,13}$/.test(owner)) throw new Error('OWNER_NUMBER harus format 62 tanpa +');
  const stockKey = required('STOCK_KEY');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(stockKey) || Buffer.from(stockKey, 'base64').length !== 32) throw new Error('STOCK_KEY harus base64 32 byte');
  const whatsappEnabled = env.WHATSAPP_ENABLED === 'true';
  if (env.WHATSAPP_ENABLED && !['true', 'false'].includes(env.WHATSAPP_ENABLED)) throw new Error('WHATSAPP_ENABLED tidak valid');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT tidak valid');
  const xenditKey = mode === 'simulation' ? '' : required('XENDIT_SECRET_KEY');
  const xenditToken = mode === 'simulation' ? env.XENDIT_WEBHOOK_TOKEN ?? randomBytes(32).toString('hex') : required('XENDIT_WEBHOOK_TOKEN');
  const digiflazzUsername = mode === 'simulation' ? '' : required('DIGIFLAZZ_USERNAME');
  const digiflazzKey = mode === 'simulation' ? '' : required('DIGIFLAZZ_API_KEY');
  const digiflazzSecret = mode === 'simulation' ? env.DIGIFLAZZ_WEBHOOK_SECRET ?? randomBytes(32).toString('hex') : required('DIGIFLAZZ_WEBHOOK_SECRET');
  if (mode !== 'simulation' && (xenditToken.length < 16 || digiflazzSecret.length < 16)) throw new Error('Webhook secrets minimal 16 karakter');
  if (mode === 'sandbox' && !xenditKey.startsWith('xnd_development_')) throw new Error('Sandbox membutuhkan Xendit test key');
  if (mode === 'live' && (env.LIVE_ACK !== 'I_UNDERSTAND_REAL_MONEY' || !xenditKey.startsWith('xnd_production_'))) throw new Error('Live membutuhkan acknowledgement dan production key');
  const timezone = env.TIMEZONE ?? 'Asia/Jakarta';
  new Intl.DateTimeFormat('id-ID', { timeZone: timezone }).format();
  return {
    mode: mode as Mode, owner, stockKey, whatsappEnabled, port, timezone,
    databaseUrl: required('DATABASE_URL'),
    host: env.HOST ?? '127.0.0.1',
    botName: env.BOT_NAME ?? 'YOSHSTORE',
    ownerName: env.OWNER_NAME ?? 'Danis',
    logoPath: env.LOGO_PATH || undefined,
    sessionPath: env.WHATSAPP_SESSION_PATH ?? './sessions/yoshstore',
    xenditKey, xenditToken, digiflazzUsername, digiflazzKey, digiflazzSecret,
  };
}

export type Config = ReturnType<typeof readConfig>;
