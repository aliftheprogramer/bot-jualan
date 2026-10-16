import { describe, expect, it } from 'vitest';
import { resolveCustomer } from '../src/identity.js';

describe('WhatsApp sender identity', () => {
  it('normalizes verified PN identities without trusting display names', async () => {
    expect(await resolveCustomer('6281234567890:4@s.whatsapp.net', undefined, async () => null)).toBe('6281234567890');
  });
  it('maps LID through the session repository and rejects unresolved LIDs', async () => {
    expect(await resolveCustomer('12345@lid', undefined, async () => '6281234567890@s.whatsapp.net')).toBe('6281234567890');
    expect(await resolveCustomer('12345@lid', undefined, async () => null)).toBeNull();
  });
  it('rejects groups and broadcasts even if alternate PN metadata exists', async () => {
    expect(await resolveCustomer('123@g.us', '6281234567890@s.whatsapp.net', async () => null)).toBeNull();
    expect(await resolveCustomer('status@broadcast', undefined, async () => null)).toBeNull();
  });
});
