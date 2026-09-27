import { validateAuthorityConfiguration } from '../src/infrastructure/authority/signing';
import { loadCliEnv } from '../src/infrastructure/config/load-cli-env';

try {
  loadCliEnv();
  const config = validateAuthorityConfiguration();
  console.log(`Authority signing configuration valid (kid=${config.keyId}, issuer=${config.issuer}, audience=${config.audience}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid authority signing configuration');
  process.exit(1);
}
