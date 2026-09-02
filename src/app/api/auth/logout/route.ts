import { buildLogoutCookie, parseCookies, revokeSessionToken, SESSION_COOKIE_NAME } from '@/infrastructure/auth/session';
import { jsonResponse } from '@/app/api/api-helpers';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const cookies = parseCookies(req.headers.get('cookie'));
  const token = cookies[SESSION_COOKIE_NAME];

  if (token) {
    revokeSessionToken(token);
  }

  const logoutCookie = buildLogoutCookie();
  return jsonResponse({ success: true, message: 'Logged out successfully' }, 200, {
    'Set-Cookie': logoutCookie,
  });
}
