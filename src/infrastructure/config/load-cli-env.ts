import fs from 'node:fs';
import path from 'node:path';

/** Load Next-style local env files for standalone CLI commands. Explicit process env wins. */
export function loadCliEnv(directory = process.cwd()): void {
  for (const file of ['.env.local', '.env']) {
    const resolved = path.resolve(directory, file);
    if (!fs.existsSync(resolved)) continue;
    // Node's loadEnvFile can replace an explicitly empty value. Preserve all
    // existing keys, including empty strings used by the isolated test runner.
    const existing = { ...process.env };
    process.loadEnvFile(resolved);
    for (const [name, value] of Object.entries(existing)) process.env[name] = value;
  }
}
