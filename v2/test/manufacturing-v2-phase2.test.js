const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260902120000_manufacturing_v2_phase2_transactions.sql'), 'utf8');
const phase1 = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20260901193000_manufacturing_v2_phase1_foundation.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'supabase', 'rollbacks', '20260902120000_manufacturing_v2_phase2_transactions_rollback.sql'), 'utf8');
const api = fs.readFileSync(path.join(root, 'v2', 'api', 'manufacturing-v2.js'), 'utf8');

const permissions = [
  'manufacturing_view_planner','manufacturing_view_work_orders','manufacturing_view_assigned_production',
  'manufacturing_print_packet','manufacturing_create_draft','manufacturing_edit_draft','manufacturing_release',
  'manufacturing_assign_machine','manufacturing_start_pause','manufacturing_record_progress',
  'manufacturing_partial_complete','manufacturing_complete','manufacturing_close','manufacturing_cancel',
  'manufacturing_shortage_override','manufacturing_bom_admin','manufacturing_cost_admin',
  'manufacturing_controlled_reopen','manufacturing_admin_correction'
];

test('all approved granular permission keys are installed', () => {
  for (const permission of permissions) assert.match(migration, new RegExp(`'${permission}'`));
});

test('admin receives every granular permission and manager privileged exclusions are explicit', () => {
  assert.match(migration, /select 'admin',permission,true from permissions/);
  for (const permission of ['manufacturing_shortage_override','manufacturing_bom_admin','manufacturing_cost_admin','manufacturing_controlled_reopen','manufacturing_admin_correction']) {
    const managerGrant = migration.match(/select 'manager',permission,permission in \(([\s\S]*?)\) from permissions/)[1];
    assert.doesNotMatch(managerGrant, new RegExp(`'${permission}'`));
  }
});

test('warehouse defaults are view assigned, view work orders, and print only', () => {
  const grant = migration.match(/select 'warehouse',permission,permission in \(([\s\S]*?)\) from permissions/)[1];
  assert.match(grant, /manufacturing_view_work_orders/);
  assert.match(grant, /manufacturing_view_assigned_production/);
  assert.match(grant, /manufacturing_print_packet/);
  assert.doesNotMatch(grant, /manufacturing_record_progress/);
});

test('API resolves actor exclusively from authenticated session', () => {
  assert.match(api, /const actorId = Number\(auth\.user\.id\)/);
  assert.doesNotMatch(api, /body\.(userId|user_id|role|userName|user_name)/);
});

test('every Phase 2 API command checks its granular permission before RPC', () => {
  for (const permission of [
    'manufacturing_assign_machine','manufacturing_start_pause','manufacturing_record_progress',
    'manufacturing_partial_complete','manufacturing_complete','manufacturing_close','manufacturing_cancel'
  ]) assert.match(api, new RegExp(`requirePermission\\(url, serviceRoleKey, actorId, '${permission}'\\)`));
});

test('feature remains protected by deployment and database flags', () => {
  assert.match(api, /MANUFACTURING_V2_ENABLED !== 'true'/);
  assert.match(api, /mfg_feature_flags\?flag_key=eq\.manufacturing_v2&enabled=eq\.true/);
  assert.doesNotMatch(migration, /update\s+public\.mfg_feature_flags[\s\S]*enabled\s*=\s*true/i);
});

test('start is allowed only from Released', () => {
  assert.match(migration, /p_action='start' and v_from='Released'/);
});

test('pause and resume retain allocations', () => {
  assert.match(migration, /p_action='pause' and v_from in \('In Production','Partially Completed'\)/);
  const transition = migration.match(/create or replace function public\.transition_mfg_work_order[\s\S]*?end \$\$;/)[0];
  assert.doesNotMatch(transition, /mfg_component_allocations\s+set/i);
});

test('line quantities use nonoverlapping signed-safe disposition buckets', () => {
  assert.match(migration, /planned_quantity-good_quantity-rejected_quantity-rework_quantity-scrap_quantity/);
  assert.match(migration, /remaining_quantity>=0/);
  assert.match(migration, /good_quantity\+rejected_quantity\+rework_quantity\+scrap_quantity<=planned_quantity/);
});

test('production locks work order and line before validating mutable quantities', () => {
  const progress = migration.match(/create or replace function public\.record_mfg_progress[\s\S]*?end \$\$;/)[0];
  assert.match(progress, /where id=p_work_order_id for update/);
  assert.match(progress, /where id=p_work_order_line_id and work_order_id=v_wo\.id for update/);
  assert.ok(progress.indexOf('for update;') < progress.indexOf("progress_would_overcomplete_line"));
});

test('concurrent completion cannot silently overcomplete a line', () => {
  assert.match(migration, /p_quantity>v_line\.remaining_quantity.*progress_would_overcomplete_line/);
  assert.match(migration, /where id=p_work_order_line_id and work_order_id=v_wo\.id for update/);
});

test('standard good production consumes the frozen BOM proportionally without rounding', () => {
  assert.match(migration, /p_quantity\*sc\.quantity_per_yield\/s\.yield_quantity quantity/);
  assert.match(migration, /mfg_work_order_bom_snapshots/);
  assert.doesNotMatch(migration, /round\(p_quantity\*sc\.quantity_per_yield/i);
});

test('standard consumption releases active allocation proportionally', () => {
  assert.match(migration, /consumed_quantity=consumed_quantity\+v_component\.quantity/);
  assert.match(migration, /consumed_quantity\+released_quantity\+v_component\.quantity<=allocated_quantity/);
});

test('good production creates one signed local finished inventory event', () => {
  assert.match(migration, /'production_complete'[\s\S]*Good production completed at 730/);
  assert.match(migration, /insert into public\.mfg_finished_inventory_events/);
  assert.match(phase1, /mfg_finished_inventory_events[\s\S]*idempotency_key text not null unique/);
});

test('planned transferable quantity is incremented only by good production', () => {
  assert.match(migration, /if p_disposition='good' then[\s\S]*transferable_quantity=transferable_quantity\+p_quantity/);
});

test('rework adds no finished inventory and consumes a standard BOM only on its original attempt', () => {
  assert.match(migration, /v_standard:=p_source_bucket='unstarted' and p_disposition in \('good','rejected_pending','rework'\)/);
  assert.match(migration, /p_disposition='good' and p_source_bucket='rework'/);
  assert.doesNotMatch(migration, /v_standard:=.*p_source_bucket='rework'/);
});

test('scrap requires a reason and consumes only explicit component quantities', () => {
  assert.match(migration, /scrap_reason_required/);
  assert.match(migration, /'explicit_scrap'/);
  assert.match(migration, /A direct scrap never assumes a full-BOM consumption/);
});

test('rejected pending and rework block work-order completion', () => {
  assert.match(migration, /remaining_quantity<>0 or rejected_quantity<>0 or rework_quantity<>0/);
  assert.match(migration, /all_units_and_dispositions_must_be_resolved/);
});

test('stable completion idempotency returns the original result', () => {
  assert.match(migration, /where idempotency_key=p_idempotency_key/);
  assert.match(migration, /if found then return v_result; end if;/);
  assert.doesNotMatch(migration, /return v_result\|\|jsonb_build_object\('alreadyApplied',true/);
});

test('work-order completion stores and returns the identical idempotent result', () => {
  assert.match(migration, /'alreadyCompleted',false,'shopifyCall',false/);
  assert.match(migration, /'completed_and_transfer_promoted'[\s\S]*p_idempotency_key\|\|':audit',v_result\)/);
});

test('failure injection points are inside the atomic progress transaction', () => {
  for (const point of ['after_component_calculation','after_component_consumption','before_transfer_update']) {
    assert.match(migration, new RegExp(`current_setting\\('mfg.test_failpoint',true\\)='${point}'`));
  }
});

test('signed inventory is never clamped', () => {
  assert.match(migration, /v_after:=v_balance\.quantity\+p_quantity_delta/);
  assert.doesNotMatch(migration, /greatest\(v_after,0\)|greatest\(v_balance\.quantity/i);
});

test('negative component inventory requires that component shortage override', () => {
  assert.match(migration, /work_order_id=v_wo\.id and component_product_id=v_component\.component_product_id/);
  assert.match(migration, /manufacturing_component_would_be_negative/);
});

test('Manufacturing allocations remain separate from Shopify committed allocation', () => {
  const progress = migration.match(/create or replace function public\.record_mfg_progress[\s\S]*?end \$\$;/)[0];
  assert.match(progress, /mfg_component_allocations/);
  assert.doesNotMatch(progress, /allocated_quantity\s*=\s*allocated_quantity\s*[-+]/i);
});

test('Manufacturing movements carry source and feedback-loop metadata', () => {
  assert.match(migration, /'manufacturing',p_work_order_id::text/);
  assert.match(migration, /'source','manufacturing','outboundShopify',false/);
});

test('no Manufacturing transaction calls Shopify', () => {
  assert.doesNotMatch(api, /shopify/i);
  assert.doesNotMatch(migration, /https?:\/\//i);
  assert.doesNotMatch(migration, /shopify_(inventory|adjust|write)/i);
});

test('partial production keeps planned transfer nonphysical', () => {
  const progress = migration.match(/create or replace function public\.record_mfg_progress[\s\S]*?end \$\$;/)[0];
  assert.doesNotMatch(progress, /insert into public\.transfers/);
  assert.doesNotMatch(progress, /insert into public\.transfer_lines/);
});

test('full completion promotes exactly one draft physical transfer using good quantities', () => {
  assert.match(migration, /select v_transfer_number[\s\S]*'draft'/);
  assert.match(migration, /select v_transfer_id,l\.finished_product_id,l\.good_quantity,0/);
  assert.match(phase1, /mfg_planned_transfers[\s\S]*work_order_id bigint not null unique/);
  assert.match(phase1, /physical_transfer_id bigint unique/);
});

test('closing creates no inventory or transfer event', () => {
  const close = migration.match(/create or replace function public\.close_mfg_work_order[\s\S]*?end \$\$;/)[0];
  assert.doesNotMatch(close, /inventory_balances|inventory_movements|insert into public\.transfers|insert into public\.transfer_lines/);
});

test('released cancellation frees Manufacturing allocation but creates no inventory movement', () => {
  const cancel = migration.match(/create or replace function public\.cancel_mfg_work_order[\s\S]*?end \$\$;/)[0];
  assert.match(cancel, /released_quantity=allocated_quantity-consumed_quantity/);
  assert.doesNotMatch(cancel, /inventory_balances|inventory_movements/);
  assert.match(cancel, /started_work_requires_controlled_correction_or_early_close/);
});

test('cost remains explicitly unavailable and never becomes zero', () => {
  assert.match(migration, /Cost unavailable — component cost source not configured/);
  assert.match(migration, /values\(v_event_id,'unavailable'/);
  assert.doesNotMatch(migration, /component_cost[^\n]*0|finished_unit_cost[^\n]*0/);
});

test('all transaction functions are service-role only', () => {
  for (const fn of ['transition_mfg_work_order','assign_mfg_machine','record_mfg_progress','complete_mfg_work_order','close_mfg_work_order','cancel_mfg_work_order']) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*from public,anon,authenticated`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*to service_role`));
  }
});

test('rollback removes Phase 2 functions and restores the Phase 1 quantity model', () => {
  assert.match(rollback, /drop function if exists public\.record_mfg_progress/);
  assert.match(rollback, /greatest\(planned_quantity-good_quantity-rejected_quantity-scrap_quantity,0\)/);
});
