const { accessToken, bmOsSession, configuration, hasBmOsSessionCookie, jsonHeaders } = require('../_lib/auth');

module.exports = async function me(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ ok: false, error: 'method_not_allowed' }); }
  const token = accessToken(req);
  if (!token && !hasBmOsSessionCookie(req)) return res.status(401).json({ ok: false, error: 'not_authenticated' });
  const { url, publishableKey, serviceRoleKey } = configuration();
  if (!url || !publishableKey || !serviceRoleKey) return res.status(503).json({ ok: false, error: 'authentication_not_configured' });
  try {
    const osSession = bmOsSession(req, serviceRoleKey);
    if (osSession) {
      const response = await fetch(`${url}/rest/v1/app_users?id=eq.${osSession.userId}&active=eq.true&select=id,display_name,email,role&limit=1`, { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
      const users = response.ok ? await response.json() : [];
      if (!users.length) return res.status(403).json({ ok: false, error: 'warehouse_access_not_assigned' });
      return respondWithUser(res, url, serviceRoleKey, users[0]);
    }
    if (!token) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const authResponse = await fetch(`${url}/auth/v1/user`, { headers: jsonHeaders(publishableKey, token), signal: AbortSignal.timeout(8000) });
    if (!authResponse.ok) return res.status(401).json({ ok: false, error: 'session_expired' });
    const authUser = await authResponse.json();
    const userResponse = await fetch(`${url}/rest/v1/app_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&active=eq.true&select=id,display_name,email,role&limit=1`, { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
    const users = userResponse.ok ? await userResponse.json() : [];
    if (!users.length) return res.status(403).json({ ok: false, error: 'warehouse_access_not_assigned' });
    return respondWithUser(res, url, serviceRoleKey, users[0], authUser.email);
  } catch (_error) { return res.status(503).json({ ok: false, error: 'authentication_unavailable' }); }
};

async function respondWithUser(res, url, key, user, fallbackEmail = '') {
  const response = await fetch(`${url}/rest/v1/user_location_access?user_id=eq.${user.id}&select=location_id,can_manage,locations(id,code,name,warehouse_id)`, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('location access lookup failed');
  return res.status(200).json({ ok: true, user: { displayName: user.display_name, email: user.email || fallbackEmail, role: user.role }, locations: await response.json(), qoblexConnected: false });
}
