const ACCESS_COOKIE = 'bm_v2_access_token';
const REFRESH_COOKIE = 'bm_v2_refresh_token';
const BMOS_COOKIE = 'bm_v2_bmos_session';
const crypto = require('crypto');

function configuration() {
  return {
    url: process.env.BM_WAREHOUSE_V2_SUPABASE_URL,
    publishableKey: process.env.BM_WAREHOUSE_V2_SUPABASE_PUBLISHABLE_KEY,
    serviceRoleKey: process.env.BM_WAREHOUSE_V2_SUPABASE_SERVICE_ROLE_KEY
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map(value => value.trim()).filter(Boolean).map(value => {
      const separator = value.indexOf('=');
      return [value.slice(0, separator), decodeURIComponent(value.slice(separator + 1))];
    })
  );
}

function sessionCookies(session) {
  // OAuth returns from Supabase before the app makes its first same-origin API call.
  // Lax keeps the tokens protected while allowing that normal login handoff.
  const secure = 'Path=/; HttpOnly; Secure; SameSite=Lax';
  return [
    `${ACCESS_COOKIE}=${encodeURIComponent(session.access_token)}; ${secure}; Max-Age=${session.expires_in}`,
    `${REFRESH_COOKIE}=${encodeURIComponent(session.refresh_token)}; ${secure}; Max-Age=2592000`
  ];
}

function clearSessionCookies() {
  const expired = 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
  return [
    `${ACCESS_COOKIE}=; ${expired}`,
    `${REFRESH_COOKIE}=; ${expired}`,
    `${BMOS_COOKIE}=; ${expired}`
  ];
}

function accessToken(req) {
  return parseCookies(req.headers?.cookie)[ACCESS_COOKIE];
}

function hasBmOsSessionCookie(req) {
  return Boolean(parseCookies(req.headers?.cookie)[BMOS_COOKIE]);
}

function bmOsSessionCookie(session, signingKey) {
  const payload = Buffer.from(JSON.stringify({ ...session, expiresAt: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
  return `${BMOS_COOKIE}=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`;
}

function bmOsSession(req, signingKey) {
  const token = parseCookies(req.headers?.cookie)[BMOS_COOKIE];
  if (!token || !signingKey) return null;
  const [payload, supplied] = token.split('.');
  if (!payload || !supplied) return null;
  const expected = crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.expiresAt > Date.now() ? session : null;
  } catch (_error) {
    return null;
  }
}

function jsonHeaders(apiKey, bearer = apiKey) {
  return {
    apikey: apiKey,
    Authorization: `Bearer ${bearer}`,
    'Content-Type': 'application/json'
  };
}

module.exports = {
  accessToken,
  bmOsSession,
  bmOsSessionCookie,
  clearSessionCookies,
  configuration,
  hasBmOsSessionCookie,
  jsonHeaders,
  sessionCookies
};
