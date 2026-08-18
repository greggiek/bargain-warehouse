const ACCESS_COOKIE = 'bm_v2_access_token';
const REFRESH_COOKIE = 'bm_v2_refresh_token';

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
  const secure = 'Path=/; HttpOnly; Secure; SameSite=Strict';
  return [
    `${ACCESS_COOKIE}=${encodeURIComponent(session.access_token)}; ${secure}; Max-Age=${session.expires_in}`,
    `${REFRESH_COOKIE}=${encodeURIComponent(session.refresh_token)}; ${secure}; Max-Age=2592000`
  ];
}

function clearSessionCookies() {
  const expired = 'Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
  return [
    `${ACCESS_COOKIE}=; ${expired}`,
    `${REFRESH_COOKIE}=; ${expired}`
  ];
}

function accessToken(req) {
  return parseCookies(req.headers?.cookie)[ACCESS_COOKIE];
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
  clearSessionCookies,
  configuration,
  jsonHeaders,
  sessionCookies
};
