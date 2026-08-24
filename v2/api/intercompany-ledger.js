const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const ADMIN_ROLES = new Set(['admin', 'developer']);

async function postgrest(url, path, key) {
  const response = await fetch(url + '/rest/v1/' + path, { headers: jsonHeaders(key) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.hint || 'Could not load the intercompany ledger.');
  return body;
}

function monthWindow(value) {
  const month = /^\d{4}-\d{2}$/.test(String(value || '')) ? String(value) : new Date().toISOString().slice(0, 7);
  const start = new Date(month + '-01T00:00:00.000Z');
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { month, start: start.toISOString(), end: end.toISOString() };
}

module.exports = async function intercompanyLedger(req, res) {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  if (!ADMIN_ROLES.has(auth.user.role)) return res.status(403).json({ ok: false, error: 'Administrator access is required for intercompany bookkeeping.' });
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  try {
    const { url, serviceRoleKey } = configuration();
    const { month, start, end } = monthWindow(req.query?.month);
    const rows = await postgrest(url,
      'intercompany_transfer_ledger_lines?select=id,bm_reference,status,source_entity,destination_entity,sku,quantity,unit_cost,extended_value,currency,source_shopify_adjustment_id,destination_shopify_adjustment_id,shipped_at,received_at&shipped_at=gte.' + encodeURIComponent(start) + '&shipped_at=lt.' + encodeURIComponent(end) + '&order=shipped_at.desc,sku.asc',
      serviceRoleKey
    );
    const totals = rows.reduce((summary, row) => {
      summary.transferCount.add(row.bm_reference);
      summary.quantity += Number(row.quantity || 0);
      summary.value += Number(row.extended_value || 0);
      return summary;
    }, { transferCount: new Set(), quantity: 0, value: 0 });

    return res.json({
      ok: true,
      month,
      rows,
      summary: {
        transfers: totals.transferCount.size,
        pieces: totals.quantity,
        value: Number(totals.value.toFixed(4)),
        currency: 'USD'
      }
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'intercompany_ledger_failed' });
  }
};
