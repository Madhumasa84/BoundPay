import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'fs';
import path from 'path';
import * as schema from './schema';

export function getDatabasePath(): string {
  const envPath = process.env.DATABASE_PATH;
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
  }
  return path.resolve(process.cwd(), 'data/boundpay.sqlite');
}

export function createSqliteConnection(dbPath: string = getDatabasePath()): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);

  // Enable WAL mode for high concurrency
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 10000');
  sqlite.pragma('synchronous = NORMAL');

  return sqlite;
}

export function createDrizzleClient(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

let currentDbPath: string | null = null;
let defaultSqlite: Database.Database | null = null;
let defaultDb: ReturnType<typeof createDrizzleClient> | null = null;

export function closeDefaultDb(): void {
  if (defaultSqlite) {
    try {
      defaultSqlite.close();
    } catch {}
    defaultSqlite = null;
    defaultDb = null;
    currentDbPath = null;
  }
}

export function getDb(customPath?: string) {
  if (customPath) {
    const sqlite = createSqliteConnection(customPath);
    return { sqlite, db: createDrizzleClient(sqlite) };
  }

  const targetPath = getDatabasePath();
  if (defaultDb && currentDbPath === targetPath) {
    return { sqlite: defaultSqlite!, db: defaultDb };
  }

  closeDefaultDb();
  currentDbPath = targetPath;
  defaultSqlite = createSqliteConnection(targetPath);
  defaultDb = createDrizzleClient(defaultSqlite);
  return { sqlite: defaultSqlite, db: defaultDb };
}

export { schema };
