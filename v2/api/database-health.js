module.exports = async function databaseHealth(_req, res) {
  const url = process.env.BM_WAREHOUSE_V2_SUPABASE_URL;
  const serviceRoleKey = process.env.BM_WAREHOUSE_V2_SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    return res.status(503).json({
      ok: false,
      application: 'BM Warehouse V2',
      databaseConfigured: false,
      databaseConnected: false,
      qoblexConnected: false
    });
  }

  try {
    const response = await fetch(`${url}/rest/v1/warehouses?select=id&limit=1`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw new Error(`Supabase returned HTTP ${response.status}`);
    }

    return res.status(200).json({
      ok: true,
      application: 'BM Warehouse V2',
      databaseConfigured: true,
      databaseConnected: true,
      qoblexConnected: false
    });
  } catch (_error) {
    return res.status(503).json({
      ok: false,
      application: 'BM Warehouse V2',
      databaseConfigured: true,
      databaseConnected: false,
      qoblexConnected: false
    });
  }
};
