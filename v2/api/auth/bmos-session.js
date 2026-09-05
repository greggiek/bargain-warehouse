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
    let users = await findUsers(url, serviceRoleKey, 'bm_os_identity_id', identity.identityId);
    if (!users.length) users = await findUsers(url, serviceRoleKey, 'email', email);
    const role = ['administrator', 'company_manager'].includes(identity.accessLevel) ? 'admin' : identity.accessLevel === 'location_manager' ? 'manager' : 'warehouse';
    if (!users.length) {
      const createResponse = await fetch(`${url}/rest/v1/app_users`, { method: 'POST', headers: { ...jsonHeaders(serviceRoleKey), Prefer: 'return=representation' }, body: JSON.stringify({ bm_os_identity_id: identity.identityId, display_name: identity.displayName, email, role, active: true }), signal: AbortSignal.timeout(8000) });
      if (!createResponse.ok) throw new Error('app user creation failed');
      users = await createResponse.json();
    } else {
      await fetch(`${url}/rest/v1/app_users?id=eq.${users[0].id}`, { method: 'PATCH', headers: jsonHeaders(serviceRoleKey), body: JSON.stringify({ bm_os_identity_id: identity.identityId, display_name: identity.displayName, email, role, active: true }), signal: AbortSignal.timeout(8000) });
    }
    const user = users[0];
    if (role === 'admin') await ensureAllLocationAccess(url, serviceRoleKey, user.id);
    else await synchronizeLocationAccess(url, serviceRoleKey, user.id, identity, role);
    res.setHeader('Set-Cookie', bmOsSessionCookie({ userId: user.id, identityId: identity.identityId }, serviceRoleKey));
    return res.redirect('/');
  } catch (_error) { return res.redirect('/?error=bmos_handoff_failed'); }
};

async function findUsers(url, key, field, value) {
  if (!value) return [];
  const response = await fetch(`${url}/rest/v1/app_users?${field}=eq.${encodeURIComponent(value)}&select=id,display_name,email,role&limit=1`, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  return response.ok ? response.json() : [];
}

async function ensureAllLocationAccess(url, key, userId) {
  const response = await fetch(`${url}/rest/v1/locations?active=eq.true&select=id`, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  const locations = response.ok ? await response.json() : [];
  await Promise.all(locations.map(location => upsertLocationAccess(url, key, userId, location.id, true)));
}

async function synchronizeLocationAccess(url, key, userId, identity, role) {
  const requestedScopes = Array.isArray(identity.locationScopes) && identity.locationScopes.length
    ? identity.locationScopes
    : identity.primaryLocationId && identity.locationName
      ? [{ id: identity.primaryLocationId, name: identity.locationName }]
      : [];
  if (!requestedScopes.length) throw new Error('BM OS did not provide an authorized warehouse location.');

  const desiredIds = [];
  for (const scope of requestedScopes) {
    const location = await resolveLocation(url, key, scope);
    desiredIds.push(location.id);
    await upsertLocationAccess(url, key, userId, location.id, role === 'manager');
  }

  const currentResponse = await fetch(`${url}/rest/v1/user_location_access?user_id=eq.${userId}&select=location_id`, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  if (!currentResponse.ok) throw new Error('Unable to verify Warehouse location access.');
  const current = await currentResponse.json();
  const stale = current.filter((row) => !desiredIds.includes(row.location_id));
  await Promise.all(stale.map((row) => fetch(`${url}/rest/v1/user_location_access?user_id=eq.${userId}&location_id=eq.${row.location_id}`, {
    method: 'DELETE', headers: jsonHeaders(key), signal: AbortSignal.timeout(8000),
  })));
}

async function resolveLocation(url, key, scope) {
  let response = await fetch(`${url}/rest/v1/locations?bm_os_location_id=eq.${encodeURIComponent(scope.id)}&active=eq.true&select=id,bm_os_location_id`, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  let locations = response.ok ? await response.json() : [];
  if (locations.length === 1) return locations[0];

  response = await fetch(`${url}/rest/v1/locations?name=ilike.${encodeURIComponent(`*${scope.name}*`)}&active=eq.true&select=id,bm_os_location_id`, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  locations = response.ok ? await response.json() : [];
  if (locations.length !== 1) throw new Error(`BM OS location mapping is missing or ambiguous for ${scope.name}.`);
  const location = locations[0];
  const patchResponse = await fetch(`${url}/rest/v1/locations?id=eq.${location.id}&bm_os_location_id=is.null`, {
    method: 'PATCH', headers: jsonHeaders(key), body: JSON.stringify({ bm_os_location_id: scope.id }), signal: AbortSignal.timeout(8000),
  });
  if (!patchResponse.ok) throw new Error(`Unable to bind Warehouse location ${scope.name} to BM OS.`);
  return location;
}

async function upsertLocationAccess(url, key, userId, locationId, canManage) {
  const currentResponse = await fetch(`${url}/rest/v1/user_location_access?user_id=eq.${userId}&location_id=eq.${locationId}&select=user_id`, { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) });
  const current = currentResponse.ok ? await currentResponse.json() : [];
  const body = JSON.stringify({ can_manage: canManage });
  if (current.length) return fetch(`${url}/rest/v1/user_location_access?user_id=eq.${userId}&location_id=eq.${locationId}`, { method: 'PATCH', headers: jsonHeaders(key), body, signal: AbortSignal.timeout(8000) });
  return fetch(`${url}/rest/v1/user_location_access`, { method: 'POST', headers: jsonHeaders(key), body: JSON.stringify({ user_id: userId, location_id: locationId, can_manage: canManage }), signal: AbortSignal.timeout(8000) });
}
