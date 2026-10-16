import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export function encrypt(value: string, key: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), data].map(part => part.toString('base64')).join('.');
}

export function decrypt(value: string, key: string): string {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Encrypted payload tidak valid');
  const [nonce, tag, data] = parts.map(part => Buffer.from(part, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}

export function safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
