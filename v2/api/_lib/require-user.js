const { accessToken, configuration, jsonHeaders } = require('./auth');

async function requireUser(req) {
  const token = accessToken(req);
  if (!token) return { ok: false, status: 401, error: 'not_authenticated' };

  const { url, publishableKey, serviceRoleKey } = configuration();
  if (!url || !publishableKey || !serviceRoleKey) {
    return { ok: false, status: 503, error: 'authentication_not_configured' };
  }

  try {
    const authResponse = await fetch(`${url}/auth/v1/user`, {
      headers: jsonHeaders(publishableKey, token),
      signal: AbortSignal.timeout(8000)
    });
    if (!authResponse.ok) return { ok: false, status: 401, error: 'session_expired' };
    const authUser = await authResponse.json();

    const userResponse = await fetch(
      `${url}/rest/v1/app_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&active=eq.true&select=id,display_name,email,role&limit=1`,
      { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) }
    );
    if (!userResponse.ok) throw new Error('app user lookup failed');
    const users = await userResponse.json();
    if (!users.length) return { ok: false, status: 403, error: 'warehouse_access_not_assigned' };

    return { ok: true, token, authUser, user: users[0] };
  } catch (_error) {
    return { ok: false, status: 503, error: 'authentication_unavailable' };
  }
}

module.exports = { requireUser };
