import { randomBytes } from 'node:crypto';

export function prepareEnvironment(template: string, owner: string): string {
  if (!/^62\d{8,13}$/.test(owner)) throw new Error('Nomor owner harus format 62 tanpa +');
  const values: Record<string, string> = {
    OWNER_NUMBER: owner,
    STOCK_KEY: randomBytes(32).toString('base64'),
    XENDIT_WEBHOOK_TOKEN: randomBytes(32).toString('hex'),
    DIGIFLAZZ_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
  };
  let result = template;
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${name}=$`, 'm');
    if (!pattern.test(result)) throw new Error(`${name} tidak kosong; konfigurasi existing tidak boleh ditimpa`);
    result = result.replace(pattern, `${name}=${value}`);
  }
  return result;
}
