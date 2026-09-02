const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
const { requireManufacturingFeature } = require('./_lib/manufacturing-feature-gates');

async function dbRequest(url, key, path, options = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { ...jsonHeaders(key), ...(options.headers || {}) },
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || 'manufacturing_v2_database_error');
  return body;
}

async function rpc(url, key, name, body) {
  return dbRequest(url, key, `rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function requirePermission(url, key, userId, permission) {
  const allowed = await rpc(url, key, 'mfg_actor_can', {
    p_actor_user_id: Number(userId), p_permission: permission
  });
  if (allowed !== true) {
    const error = new Error(`manufacturing_permission_denied:${permission}`);
    error.status = 403;
    throw error;
  }
}

module.exports = async function manufacturingV2(req, res) {
  try {
    const isolatedPreview = process.env.VERCEL_ENV === 'preview' && process.env.MANUFACTURING_UI_FIXTURES === 'true' && process.env.PREVIEW_TEST_SESSION === 'enabled';
    if (process.env.VERCEL_ENV === 'preview' && !isolatedPreview) return res.status(503).json({ ok:false,error:'preview_fixture_configuration_required' });
    if (isolatedPreview) {
      if (req.method !== 'POST') return res.status(405).json({ ok:false,error:'method_not_allowed' });
      return res.status(200).json({ ok:true, previewSimulation:true, result:{ action:String(req.body?.action||''), simulated:true, inventoryEffect:false, externalEffect:false } });
    }
    const auth = await requireUser(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    const { url, serviceRoleKey } = configuration();
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const body = req.body || {};
    const actorId = Number(auth.user.id);
    let result;
    if (body.action === 'createDraft') {
      await requireManufacturingFeature(url, serviceRoleKey, actorId, 'manufacturing_draft_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_create_draft');
      result = await rpc(url, serviceRoleKey, 'create_mfg_work_order_draft', {
        p_actor_user_id: actorId,
        p_destination_location_id: Number(body.destinationLocationId),
        p_machine_code: String(body.machineCode || ''),
        p_lines: (body.lines || []).map(line => ({ product_id: Number(line.productId), planned_quantity: Number(line.plannedQuantity) })),
        p_priority: String(body.priority || 'normal'),
        p_requested_completion_date: body.requestedCompletionDate || null,
        p_notes: String(body.notes || ''),
        p_idempotency_key: String(body.idempotencyKey || '')
      });
    } else if (body.action === 'release') {
      await requireManufacturingFeature(url, serviceRoleKey, actorId, 'manufacturing_release_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_release');
      const overrideReason = String(body.shortageOverrideReason || '').trim();
      if (overrideReason) await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_shortage_override');
      result = await rpc(url, serviceRoleKey, 'release_mfg_work_order', {
        p_actor_user_id: actorId,
        p_work_order_id: Number(body.workOrderId),
        p_idempotency_key: String(body.idempotencyKey || ''),
        p_shortage_override_reason: overrideReason || null
      });
    } else if (body.action === 'assignMachine') {
      await requireManufacturingFeature(url, serviceRoleKey, actorId, 'manufacturing_draft_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_assign_machine');
      result = await rpc(url, serviceRoleKey, 'assign_mfg_machine', {
        p_actor_user_id: actorId,
        p_work_order_id: Number(body.workOrderId),
        p_machine_code: String(body.machineCode || ''),
        p_idempotency_key: String(body.idempotencyKey || '')
      });
    } else if (['start', 'pause', 'resume'].includes(body.action)) {
      await requireManufacturingFeature(url, serviceRoleKey, actorId, 'manufacturing_completion_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_start_pause');
      result = await rpc(url, serviceRoleKey, 'transition_mfg_work_order', {
        p_actor_user_id: actorId,
        p_work_order_id: Number(body.workOrderId),
        p_action: body.action,
        p_idempotency_key: String(body.idempotencyKey || '')
      });
    } else if (body.action === 'recordProgress') {
      await requireManufacturingFeature(url, serviceRoleKey, actorId, 'manufacturing_completion_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_record_progress');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_partial_complete');
      result = await rpc(url, serviceRoleKey, 'record_mfg_progress', {
        p_actor_user_id: actorId,
        p_work_order_id: Number(body.workOrderId),
        p_work_order_line_id: Number(body.workOrderLineId),
        p_disposition: String(body.disposition || ''),
        p_source_bucket: String(body.sourceBucket || 'unstarted'),
        p_quantity: Number(body.quantity),
        p_components: (body.components || []).map(component => ({
          component_product_id: Number(component.productId),
          quantity: Number(component.quantity)
        })),
        p_reason: String(body.reason || ''),
        p_idempotency_key: String(body.idempotencyKey || '')
      });
    } else if (body.action === 'complete') {
      await requireManufacturingFeature(url, serviceRoleKey, actorId, 'manufacturing_completion_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_complete');
      result = await rpc(url, serviceRoleKey, 'complete_mfg_work_order', {
        p_actor_user_id: actorId,
        p_work_order_id: Number(body.workOrderId),
        p_idempotency_key: String(body.idempotencyKey || '')
      });
    } else if (body.action === 'close') {
      await requireManufacturingFeature(url, serviceRoleKey, actorId, 'manufacturing_completion_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_close');
      result = await rpc(url, serviceRoleKey, 'close_mfg_work_order', {
        p_actor_user_id: actorId,
        p_work_order_id: Number(body.workOrderId),
        p_idempotency_key: String(body.idempotencyKey || '')
      });
    } else if (body.action === 'cancel') {
      await requireManufacturingFeature(url, serviceRoleKey, actorId, 'manufacturing_completion_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_cancel');
      result = await rpc(url, serviceRoleKey, 'cancel_mfg_work_order', {
        p_actor_user_id: actorId,
        p_work_order_id: Number(body.workOrderId),
        p_reason: String(body.reason || ''),
        p_idempotency_key: String(body.idempotencyKey || '')
      });
    } else return res.status(400).json({ ok: false, error: 'unknown_action' });
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    return res.status(error.status || 400).json({ ok: false, error: error.message || 'manufacturing_v2_failed' });
  }
};
