const { configuration, jsonHeaders, sessionCookies } = require('../_lib/auth');

module.exports = async function login(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'email_and_password_required' });
  }

  const { url, publishableKey } = configuration();
  if (!url || !publishableKey) {
    return res.status(503).json({ ok: false, error: 'authentication_not_configured' });
  }

  try {
    const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: jsonHeaders(publishableKey),
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(8000)
    });
    const session = await response.json();

    if (!response.ok || !session.access_token || !session.refresh_token) {
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    res.setHeader('Set-Cookie', sessionCookies(session));
    return res.status(200).json({ ok: true });
  } catch (_error) {
    return res.status(503).json({ ok: false, error: 'authentication_unavailable' });
  }
};
