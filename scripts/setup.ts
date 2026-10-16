import { access, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { prepareEnvironment } from '../src/setup.js';

async function main() {
  try { await access('.env'); console.info('.env sudah ada. Edit lokal; setup tidak menimpa key atau konfigurasi existing.'); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const owner = (await prompt.question('Nomor WhatsApp owner (62..., bukan nomor bot): ')).trim();
    const template = await readFile('.env.example', 'utf8');
    await writeFile('.env', prepareEnvironment(template, owner), { flag: 'wx', mode: 0o600 });
    console.info('.env dibuat dalam mode simulation, WhatsApp nonaktif. Rahasia dibuat lokal dan tidak ditampilkan.');
  } finally { prompt.close(); }
}
void main().catch(error => { console.error(error instanceof Error && !('code' in error) ? error.message : 'Setup gagal; konfigurasi existing tidak ditimpa.'); process.exitCode = 1; });
