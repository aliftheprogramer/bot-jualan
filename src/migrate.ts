import 'dotenv/config';
import { readConfig } from './config.js';
import { migrate, postgres } from './db.js';

async function main() {
  const config = readConfig();
  const database = postgres(config.databaseUrl);
  try { await migrate(database.db); console.info('Database migration applied.'); }
  finally { await database.close(); }
}
void main().catch(() => { console.error('Migration failed; check config/database. No credentials logged.'); process.exitCode = 1; });
