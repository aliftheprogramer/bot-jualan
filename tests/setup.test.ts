import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { prepareEnvironment } from '../src/setup.js';

describe('local setup', () => {
  const template = 'APP_MODE=simulation\nDATABASE_URL=postgresql://localhost/shop\nOWNER_NUMBER=\nSTOCK_KEY=\nXENDIT_WEBHOOK_TOKEN=\nDIGIFLAZZ_WEBHOOK_SECRET=\n';
  it('creates valid simulation config with fresh encryption and webhook keys', () => {
    const first = prepareEnvironment(template, '6281234567890');
    const second = prepareEnvironment(template, '6281234567890');
    expect(readConfig(parse(first)).mode).toBe('simulation');
    expect(parse(first).STOCK_KEY).not.toBe(parse(second).STOCK_KEY);
    expect(parse(first).XENDIT_WEBHOOK_TOKEN).toHaveLength(64);
  });
  it('refuses invalid owners and never regenerates an existing stock key', () => {
    expect(() => prepareEnvironment(template, 'not-a-phone')).toThrow();
    expect(() => prepareEnvironment(template.replace('STOCK_KEY=\n', 'STOCK_KEY=existing\n'), '6281234567890')).toThrow();
  });
});
