import { verifySignedTokenOffline } from '@/infrastructure/authority/signing';

process.env.DATABASE_PATH = '/proc/boundpay-database-access-disabled.sqlite';

process.on('message', async (message: any) => {
  try {
    const payload = await verifySignedTokenOffline(message.token, message.expected, message.publicKeyPem, message.claims);
    process.send?.({ ok: true, id: payload.passportId || payload.receiptId });
  } catch {
    process.send?.({ ok: false });
  } finally {
    process.exit(0);
  }
});
