import fs from 'fs';
import { getDatabasePath } from './index';
import { seedDatabase } from './seed';

export function resetDatabase(dbPath: string = getDatabasePath(), force = false) {
  if (process.env.NODE_ENV === 'production' && !force) {
    throw new Error('Database reset is strictly prohibited in production mode');
  }

  if (process.env.NODE_ENV !== 'test' && process.env.CONFIRM_RESET !== 'true' && !force) {
    console.error('Safety Guard: To reset the database, set CONFIRM_RESET=true or pass force=true.');
    process.exit(1);
  }

  const filesToDelete = [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
  ];

  for (const f of filesToDelete) {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      console.log(`[Reset] Removed ${f}`);
    }
  }

  console.log(`[Reset] Initializing fresh database and seed at ${dbPath}...`);
  seedDatabase(dbPath);
  console.log('[Reset] Complete.');
}

if (require.main === module) {
  resetDatabase();
}
