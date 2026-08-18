function createShopifyTransferWritebackLedger({ request, now = () => new Date().toISOString() }) {
  const table = 'shopify_transfer_writebacks';

  async function find(id, select = '*') {
    const rows = await request(
      `${table}?select=${select}&id=eq.${encodeURIComponent(id)}&limit=1`
    );
    return rows[0] || null;
  }

  async function upsert(payload) {
    const rows = await request(`${table}?on_conflict=id`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({ ...payload, updated_at: payload.updated_at || now() })
    });
    return rows[0] || null;
  }

  async function patch(id, values) {
    await request(`${table}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ ...values, updated_at: now() })
    });
  }

  async function recordBaseline(row, quantity) {
    await patch(row.id, { change_from_quantity: quantity });
    return { ...row, change_from_quantity: quantity };
  }

  async function markSuccess(row, adjustment) {
    await patch(row.id, {
      status: 'success',
      attempts: Number(row.attempts || 0) + 1,
      last_error: null,
      shopify_response: adjustment,
      pushed_at: now()
    });
  }

  async function markFailed(row, error) {
    await patch(row.id, {
      status: 'failed',
      attempts: Number(row.attempts || 0) + 1,
      last_error: String(error?.message || error).slice(0, 1000)
    });
  }

  return { find, markFailed, markSuccess, recordBaseline, upsert };
}

module.exports = { createShopifyTransferWritebackLedger };
