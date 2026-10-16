function phone(jid: string | undefined): string | null {
  const match = jid?.match(/^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/);
  return match?.[1] ?? null;
}

export async function resolveCustomer(remoteJid: string | undefined | null, alternate: string | undefined, lookup: (lid: string) => Promise<string | null>): Promise<string | null> {
  if (!remoteJid) return null;
  const direct = phone(remoteJid);
  if (direct) return direct;
  if (!/^\d+(?::\d+)?@lid$/.test(remoteJid)) return null;
  const mapped = await lookup(remoteJid);
  return phone(mapped ?? undefined) ?? phone(alternate);
}
