const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

async function accessForUser(url, key, userId) {
  const response = await fetch(
    url + '/rest/v1/user_location_access?user_id=eq.' + encodeURIComponent(userId) + '&select=location_id,locations(id,name,active)',
    { headers: jsonHeaders(key), signal: AbortSignal.timeout(8000) }
  );
  if (!response.ok) throw new Error('location access lookup failed');
  return (await response.json()).filter((entry) => entry.locations && entry.locations.active)
    .map((entry) => entry.locations);
}

module.exports = async function inventory(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const { url, serviceRoleKey } = configuration();
  try {
    const locations = await accessForUser(url, serviceRoleKey, auth.user.id);
    if (!locations.length) return res.status(200).json({ ok: true, balances: [], generatedAt: new Date().toISOString() });

    const locationIds = locations.map((location) => location.id).join(',');
    const balances = [];
    const pageSize = 1000;

    for (let offset = 0; offset < 20000; offset += pageSize) {
      const response = await fetch(
        url + '/rest/v1/inventory_balances?select=product_id,location_id,quantity,allocated_quantity,products(sku,name),locations(id,name,active)&location_id=in.(' + locationIds + ')&order=product_id.asc,location_id.asc&limit=' + pageSize + '&offset=' + offset,
        { headers: jsonHeaders(serviceRoleKey), signal: AbortSignal.timeout(8000) }
      );
      const page = await response.json();
      if (!response.ok) throw new Error(page.message || 'V2 inventory lookup failed');
      balances.push(...page);
      if (page.length < pageSize) break;
    }

    return res.status(200).json({
      ok: true,
      balances,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
