const { bmOsSessionCookie, configuration, jsonHeaders } = require('../_lib/auth');

module.exports = async function bmosSession(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const token = String(req.query?.token || '');
  if (token.length < 30) return res.status(400).json({ ok: false, error: 'invalid_handoff' });
  const { url, serviceRoleKey } = configuration();
  if (!url || !serviceRoleKey) return res.status(503).json({ ok: false, error: 'authentication_not_configured' });
  try {
    const exchange = await fetch('https://bm-time.vercel.app/api/auth/handoff-exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, targetSystem: 'warehouse' }), signal: AbortSignal.timeout(8000) });
    const identity = await exchange.json();
    if (!exchange.ok) return res.redirect('/?error=bmos_handoff_failed');
    const email = String(identity.email || '').trim().toLowerCase();
    const usersResponse = await fetch(`${url}/rest/v1/app_users?email=eq.${encodeURIComponent(email)}&select=id,display_name,email,role&limit=1`, { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) });
    let users = usersResponse.ok ? await usersResponse.json() : [];
    const role = ['administrator', 'company_manager'].includes(identity.accessLevel) ? 'admin' : identity.accessLevel === 'location_manager' ? 'manager' : 'warehouse';
    if (!users.length) {
      const createResponse = await fetch(`${url}/rest/v1/app_users`, { method: 'POST', headers: { ...jsonHeaders(serviceRoleKey), Prefer: 'return=representation' }, body: JSON.stringify({ display_name: identity.displayName, email, role, active: true }), signal: AbortSignal.timeout(8000) });
      if (!createResponse.ok) throw new Error('app user creation failed');
      users = await createResponse.json();
    } else {
      await fetch(`${url}/rest/v1/app_users?id=eq.${users[0].id}`, { method: 'PATCH', headers: jsonHeaders(serviceRoleKey), body: JSON.stringify({ display_name: identity.displayName, role, active: true }), signal: AbortSignal.timeout(8000) });
    }
    const user = users[0];
    if (identity.locationName) await ensureLocationAccess(url, serviceRoleKey, user.id, identity.locationName, role);
    res.setHeader('Set-Cookie', bmOsSessionCookie({ userId: user.id, identityId: identity.identityId }, serviceRoleKey));
    return res.redirect('/');
  } catch (_error) { return res.redirect('/?error=bmos_handoff_failed'); }
};

async function ensureLocationAccess(url, key, userId, locationName, role) {
  const response = await fetch(`${url}/rest/v1/locations?name=ilike.${encodeURIComponent(`*${locationName}*`)}&active=eq.true&select=id&limit=1`, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  const locations = response.ok ? await response.json() : [];
  if (!locations.length) return;
  const locationId = locations[0].id;
  const currentResponse = await fetch(`${url}/rest/v1/user_location_access?user_id=eq.${userId}&location_id=eq.${locationId}&select=user_id`, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  const current = currentResponse.ok ? await currentResponse.json() : [];
  const body = JSON.stringify({ can_manage: role === 'manager' || role === 'admin' });
  if (current.length) await fetch(`${url}/rest/v1/user_location_access?user_id=eq.${userId}&location_id=eq.${locationId}`, { method: 'PATCH', headers: jsonHeaders(key), body, signal: AbortSignal.timeout(8000) });
  else await fetch(`${url}/rest/v1/user_location_access`, { method: 'POST', headers: jsonHeaders(key), body: JSON.stringify({ user_id: userId, location_id: locationId, can_manage: role === 'manager' || role === 'admin' }), signal: AbortSignal.timeout(8000) });
}
