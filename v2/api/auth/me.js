const { accessToken, configuration, jsonHeaders } = require('../_lib/auth');

module.exports = async function me(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const token = accessToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'not_authenticated' });
  }

  const { url, publishableKey, serviceRoleKey } = configuration();
  if (!url || !publishableKey || !serviceRoleKey) {
    return res.status(503).json({ ok: false, error: 'authentication_not_configured' });
  }

  try {
    const authResponse = await fetch(`${url}/auth/v1/user`, {
      headers: jsonHeaders(publishableKey, token),
      signal: AbortSignal.timeout(8000)
    });
    if (!authResponse.ok) {
      return res.status(401).json({ ok: false, error: 'session_expired' });
    }
    const authUser = await authResponse.json();

    const userResponse = await fetch(
      `${url}/rest/v1/app_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&active=eq.true&select=id,display_name,email,role&limit=1`,
      { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) }
    );
    if (!userResponse.ok) throw new Error('app user lookup failed');
    const users = await userResponse.json();
    if (!users.length) {
      return res.status(403).json({ ok: false, error: 'warehouse_access_not_assigned' });
    }

    const user = users[0];
    const accessResponse = await fetch(
      `${url}/rest/v1/user_location_access?user_id=eq.${user.id}&select=location_id,can_view,can_adjust,can_transfer,locations(id,code,name,warehouse_id)`,
      { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) }
    );
    if (!accessResponse.ok) throw new Error('location access lookup failed');
    const locations = await accessResponse.json();

    return res.status(200).json({
      ok: true,
      user: {
        displayName: user.display_name,
        email: user.email || authUser.email,
        role: user.role
      },
      locations,
      qoblexConnected: false
    });
  } catch (_error) {
    return res.status(503).json({ ok: false, error: 'authentication_unavailable' });
  }
};
