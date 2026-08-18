const { configuration, jsonHeaders, sessionCookies } = require('../_lib/auth');

module.exports = async function googleSession(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const accessToken = String(req.body?.accessToken || '');
  const refreshToken = String(req.body?.refreshToken || '');
  const expiresIn = Math.max(60, Math.min(Number(req.body?.expiresIn || 3600), 86400));
  if (!accessToken || !refreshToken) {
    return res.status(400).json({ ok: false, error: 'oauth_session_required' });
  }

  const { url, publishableKey, serviceRoleKey } = configuration();
  if (!url || !publishableKey || !serviceRoleKey) {
    return res.status(503).json({ ok: false, error: 'authentication_not_configured' });
  }

  try {
    const authResponse = await fetch(`${url}/auth/v1/user`, {
      headers: jsonHeaders(publishableKey, accessToken),
      signal: AbortSignal.timeout(8000)
    });
    if (!authResponse.ok) {
      return res.status(401).json({ ok: false, error: 'invalid_google_session' });
    }

    const authUser = await authResponse.json();
    const email = String(authUser.email || '').trim().toLowerCase();
    if (!email.endsWith('@bargainmoulding.com')) {
      return res.status(403).json({ ok: false, error: 'company_google_account_required' });
    }

    const userResponse = await fetch(
      `${url}/rest/v1/app_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&active=eq.true&select=id&limit=1`,
      { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) }
    );
    if (!userResponse.ok) throw new Error('app user lookup failed');
    const users = await userResponse.json();
    if (!users.length) {
      return res.status(403).json({ ok: false, error: 'warehouse_access_not_assigned' });
    }

    res.setHeader('Set-Cookie', sessionCookies({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn
    }));
    return res.status(200).json({ ok: true });
  } catch (_error) {
    return res.status(503).json({ ok: false, error: 'authentication_unavailable' });
  }
};
