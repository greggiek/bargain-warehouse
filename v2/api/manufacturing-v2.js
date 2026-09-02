const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

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
async function requireFlag(url, key, flag) {
  const rows = await dbRequest(url, key, `mfg_feature_flags?flag_key=eq.${encodeURIComponent(flag)}&enabled=eq.true&select=flag_key&limit=1`);
  if (!rows.length) {
    const error = new Error(`manufacturing_control_disabled:${flag}`);
    error.status = 403;
    throw error;
  }
}

module.exports = async function manufacturingV2(req, res) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    if (process.env.MANUFACTURING_V2_ENABLED !== 'true') {
      return res.status(404).json({ ok: false, error: 'manufacturing_v2_disabled' });
    }
    const { url, serviceRoleKey } = configuration();
    const flags = await dbRequest(url, serviceRoleKey,
      'mfg_feature_flags?flag_key=eq.manufacturing_v2&enabled=eq.true&select=flag_key&limit=1');
    if (!flags.length) return res.status(404).json({ ok: false, error: 'manufacturing_v2_disabled' });
    const beta=await dbRequest(url,serviceRoleKey,`mfg_beta_users?user_id=eq.${Number(auth.user.id)}&select=user_id&limit=1`);if(!beta.length)return res.status(403).json({ok:false,error:'manufacturing_beta_access_denied'});
    await requireFlag(url,serviceRoleKey,'manufacturing_view_enabled');
    if (req.method === 'GET') {
      const [featureFlags, locations, boms, workOrders] = await Promise.all([
        dbRequest(url, serviceRoleKey, 'mfg_feature_flags?select=flag_key,enabled&order=flag_key'),
        dbRequest(url, serviceRoleKey, 'locations?active=eq.true&select=id,name,code&order=name'),
        dbRequest(url, serviceRoleKey, 'mfg_bom_versions?status=eq.active&select=id,finished_product_id,yield_quantity,component_hash,products!mfg_bom_versions_finished_product_id_fkey(id,sku,name),mfg_bom_version_components(component_product_id,quantity_per_yield,products(id,sku,name))&order=id&limit=500'),
        dbRequest(url, serviceRoleKey, 'mfg_work_orders?select=id,work_order_number,status,machine_code,priority,notes,created_at,destination:locations!mfg_work_orders_destination_location_id_fkey(id,name),mfg_work_order_lines(id,finished_product_id,planned_quantity,good_quantity,remaining_quantity,products(id,sku,name))&order=created_at.desc&limit=100')
      ]);
      const origin = locations.find(location => location.code === '730' || location.name === '730 Windham');
      const componentIds = [...new Set(boms.flatMap(bom => bom.mfg_bom_version_components || []).map(component => Number(component.component_product_id)).filter(Number.isFinite))];
      const signedInventory = componentIds.length && origin
        ? await dbRequest(url, serviceRoleKey, `inventory_balances?location_id=eq.${origin.id}&product_id=in.(${componentIds.join(',')})&select=product_id,quantity,allocated_quantity`)
        : [];
      return res.status(200).json({ ok: true, mode: 'Shadow Mode', featureFlags, locations, boms, workOrders, signedInventory });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const body = req.body || {};
    const actorId = Number(auth.user.id);
    let result;
    if (body.action === 'createDraft') {
      await requireFlag(url,serviceRoleKey,'manufacturing_draft_enabled');
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
      await requireFlag(url,serviceRoleKey,'manufacturing_release_enabled');await requireFlag(url,serviceRoleKey,'manufacturing_inventory_mutations_enabled');
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
      await requireFlag(url, serviceRoleKey, 'manufacturing_draft_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_assign_machine');
      result = await rpc(url, serviceRoleKey, 'assign_mfg_machine', {
        p_actor_user_id: actorId,
        p_work_order_id: Number(body.workOrderId),
        p_machine_code: String(body.machineCode || ''),
        p_idempotency_key: String(body.idempotencyKey || '')
      });
    } else if (['start', 'pause', 'resume'].includes(body.action)) {
      await requireFlag(url, serviceRoleKey, 'manufacturing_release_enabled');
      await requireFlag(url, serviceRoleKey, 'manufacturing_inventory_mutations_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_start_pause');
      result = await rpc(url, serviceRoleKey, 'transition_mfg_work_order', {
        p_actor_user_id: actorId,
        p_work_order_id: Number(body.workOrderId),
        p_action: body.action,
        p_idempotency_key: String(body.idempotencyKey || '')
      });
    } else if (body.action === 'recordProgress') {
      await requireFlag(url,serviceRoleKey,'manufacturing_completion_enabled');await requireFlag(url,serviceRoleKey,'manufacturing_inventory_mutations_enabled');
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
      await requireFlag(url,serviceRoleKey,'manufacturing_completion_enabled');await requireFlag(url,serviceRoleKey,'manufacturing_transfer_handoff_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_complete');
      result = await rpc(url, serviceRoleKey, 'complete_mfg_work_order', {
        p_actor_user_id: actorId,
        p_work_order_id: Number(body.workOrderId),
        p_idempotency_key: String(body.idempotencyKey || '')
      });
    } else if (body.action === 'close') {
      await requireFlag(url, serviceRoleKey, 'manufacturing_completion_enabled');
      await requirePermission(url, serviceRoleKey, actorId, 'manufacturing_close');
      result = await rpc(url, serviceRoleKey, 'close_mfg_work_order', {
        p_actor_user_id: actorId,
        p_work_order_id: Number(body.workOrderId),
        p_idempotency_key: String(body.idempotencyKey || '')
      });
    } else if(body.action==='cancelDraft'){await requireFlag(url,serviceRoleKey,'manufacturing_draft_enabled');result=await rpc(url,serviceRoleKey,'cancel_mfg_shadow_draft',{p_actor_user_id:actorId,p_work_order_id:Number(body.workOrderId),p_idempotency_key:String(body.idempotencyKey||'')});
    } else if (body.action === 'cancel') {
      await requireFlag(url,serviceRoleKey,'manufacturing_release_enabled');
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
