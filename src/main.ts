import 'dotenv/config';
import { readConfig } from './config.js';
import { migrate, postgres } from './db.js';
import { Store } from './store.js';
import { ShopService } from './service.js';
import { Worker } from './worker.js';
import { CommandRouter } from './commands.js';
import { createHttp } from './http.js';
import { WhatsApp } from './whatsapp.js';
import { Xendit } from './providers/xendit.js';
import { Digiflazz } from './providers/digiflazz.js';
import { SimulationPayments, SimulationSupplier } from './providers/simulation.js';
import type { Messenger } from './providers/types.js';

process.umask(0o077);

async function main() {
  const config = readConfig();
  const database = postgres(config.databaseUrl);
  const store = new Store(database.db, config.stockKey);
  const payments = config.mode === 'simulation' ? new SimulationPayments() : new Xendit(config.xenditKey);
  const supplier = config.mode === 'simulation' ? new SimulationSupplier() : new Digiflazz(config.digiflazzUsername, config.digiflazzKey, config.mode);
  const service = new ShopService(store, payments, supplier, config.owner);
  const commands = new CommandRouter(store, service, config);
  const whatsapp = config.whatsappEnabled ? new WhatsApp(store, config) : undefined;
  const disabled: Messenger = { async send() { throw new Error('WhatsApp disabled; use npm run demo for local simulation'); } };
  const worker = new Worker(store, service, whatsapp ?? disabled, commands);
  const app = createHttp(store, config);
  let workerTask: Promise<void> | undefined;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    worker.stop();
    await app.close();
    await workerTask;
    await whatsapp?.close();
    await database.close();
  };
  try {
    await migrate(database.db);
    await app.listen({ host: config.host, port: config.port });
    if (whatsapp) await whatsapp.start();
    workerTask = worker.run();
    console.info(`${config.botName} running in ${config.mode} mode. WhatsApp ${config.whatsappEnabled ? 'enabled' : 'disabled'}.`);
    process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  } catch {
    await shutdown();
    throw new Error('Startup failed. Check database, config, or local session; no credentials logged.');
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
