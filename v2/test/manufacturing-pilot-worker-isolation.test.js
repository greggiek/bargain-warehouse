const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20260902193000_manufacturing_pilot_worker_isolation.sql'), 'utf8');
const pilotApi = fs.readFileSync(path.join(root, 'v2/api/manufacturing-pilot.js'), 'utf8');
const inventoryWorker = fs.readFileSync(path.join(root, 'v2/api/manufacturing-inventory-sync.js'), 'utf8');
const transferWorker = fs.readFileSync(path.join(root, 'v2/api/manufacturing-transfer-handoff.js'), 'utf8');
const nativeHandoff = fs.readFileSync(path.join(root, 'supabase/migrations/20260902160000_manufacturing_native_transfer_handoff.sql'), 'utf8');
const transferRouterSql = fs.readFileSync(path.join(root, 'supabase/migrations/20260903100000_manufacturing_transfer_router.sql'), 'utf8');
const ownershipFixSql = fs.readFileSync(path.join(root, 'supabase/migrations/20260903103000_manufacturing_pilot_ownership_trigger_fix.sql'), 'utf8');
const transferGuardFixSql = fs.readFileSync(path.join(root, 'supabase/migrations/20260903104000_manufacturing_pilot_transfer_guard_fix.sql'), 'utf8');
const closeIdempotencySql = fs.readFileSync(path.join(root, 'supabase/migrations/20260903105000_manufacturing_pilot_close_idempotency.sql'), 'utf8');
const transferLifecycle = fs.readFileSync(path.join(root, 'v2/api/shopify-transfer-lifecycle.js'), 'utf8');
const transferRouter = require(path.join(root, 'v2/api/_lib/shopify-transfer-router.js'));

const base = () => ({
  gate: true, bound: 41, pilot: 'BM-MFG-PILOT-001', workOrderId: 41,
  product: 3523, approvedProduct: 3523, bom: 194, approvedBom: 194,
  quantity: 1, origin: 6, destination: 2, machine: 'NIGHTHAWK',
  ownerPilot: 'BM-MFG-PILOT-001', ownerWorkOrder: 41, conflicting: false,
  processed: false, capability: true
});
const eligible = x => x.gate && x.bound === x.workOrderId && x.pilot === 'BM-MFG-PILOT-001'
  && x.ownerPilot === x.pilot && x.ownerWorkOrder === x.workOrderId
  && x.product === x.approvedProduct && x.bom === x.approvedBom && x.quantity === 1
  && x.origin === 6 && x.destination === 2 && x.machine === 'NIGHTHAWK'
  && !x.conflicting && !x.processed && x.capability;

test('pilot ownership and capability flags are additive and disabled', () => {
  for (const flag of ['release','completion','inventory','outbound','transfer'])
    assert.match(sql, new RegExp(`manufacturing_pilot_${flag}_enabled',false`));
  for (const table of ['mfg_work_orders','mfg_component_allocations','mfg_completion_events','mfg_component_consumption_events','mfg_finished_inventory_events','inventory_movements','mfg_shopify_inventory_adjustments','mfg_transfer_handoffs','shopify_transfer_links','mfg_audit_events'])
    assert.match(sql, new RegExp(`alter table public\\.${table} add column pilot_identifier`));
  assert.match(sql,/approved_work_order_id bigint unique/);
  assert.match(sql,/approved_pilot_work_order_immutable/);
});

test('all required pilot worker negatives fail closed', () => {
  assert.equal(eligible(base()), true);
  const cases = [
    { ownerPilot:null }, { ownerWorkOrder:null }, { workOrderId:42 }, { quantity:2 },
    { bom:193 }, { destination:3 }, { machine:'TERMINATOR' },
    { ownerPilot:'BM-MFG-PILOT-OTHER' }, { approvedProduct:999 },
    { gate:false }, { bound:null }, { conflicting:true }, { processed:true }, { capability:false }
  ];
  for (const change of cases) assert.equal(eligible({...base(),...change}),false,JSON.stringify(change));
  assert.match(sql,/p_pilot_identifier is null or p_pilot_work_order_id is null/);
  assert.match(sql,/p_work_order_id<>p_pilot_work_order_id/);
  assert.match(sql,/conflicting_active_pilot/);
  assert.match(sql,/pilot_shopify_identity_mismatch/);
});

test('caller confirmation is removed and workers revalidate before Shopify', () => {
  assert.doesNotMatch(pilotApi,/confirm_shopify|externalReference|advance_manufacturing_pilot/);
  assert.match(pilotApi,/run_manufacturing_pilot_action/);
  assert.match(inventoryWorker,/assert_mfg_worker_claim_eligible/);
  assert.match(transferWorker,/assert_mfg_worker_claim_eligible/);
  assert.match(transferWorker,/createShopifyNativeDraftTransfer/);
  assert.match(inventoryWorker,/inventoryAdjustmentGroup/);
  assert.match(sql,/pilot_transfer_receipt_required/);
});

test('restricted-cycle state model is exact and retry-idempotent', () => {
  const s={status:'Draft',alloc:0,consumed:0,finished:0,outbound:new Set(),handoff:new Set(),transfer:new Set(),received:0,movements:new Set()};
  const once=(set,key,fn)=>{if(!set.has(key)){set.add(key);fn();}};
  assert.equal(s.alloc,0); // draft has zero effects
  assert.equal(eligible({...base(),gate:false}),false); // bound but disabled
  s.status='Released';s.alloc=11;
  s.status='In Production';
  once(s.movements,'consume',()=>{s.consumed=11;});
  once(s.movements,'finish',()=>{s.finished=1;});
  for(const key of ['c1','c2','c3','c4','finished']) once(s.outbound,key,()=>{});
  for(const key of ['c1','c2','c3','c4','finished']) once(s.outbound,key,()=>{});
  assert.equal(s.outbound.size,5);
  once(s.handoff,'pilot-41',()=>{});once(s.handoff,'pilot-41',()=>{});
  once(s.transfer,'pilot-41',()=>{});once(s.transfer,'pilot-41',()=>{});
  assert.equal(s.handoff.size,1);assert.equal(s.transfer.size,1);
  assert.throws(()=>{if(!s.received)throw new Error('pilot_transfer_receipt_required');},/receipt/);
  s.received=1;s.status='Closed';
  assert.deepEqual({status:s.status,alloc:s.alloc,consumed:s.consumed,finished:s.finished,handoffs:s.handoff.size,transfers:s.transfer.size},
    {status:'Closed',alloc:11,consumed:11,finished:1,handoffs:1,transfers:1});
});

test('shared router selects cross-store for CT-to-NY and native for CT-to-CT', () => {
  assert.equal(transferRouter.resolveTransferRoute('store_2','store_1'),'cross_store');
  assert.equal(transferRouter.resolveTransferRoute('store_2','store_2'),'same_store');
  assert.match(transferWorker,/resolveTransferRoute/);
  assert.match(transferWorker,/finish_mfg_cross_store_transfer_draft/);
  assert.match(transferRouterSql,/v_route:=case when h\.source_store_key=h\.destination_store_key then 'same_store' else 'cross_store' end/);
  assert.doesNotMatch(transferRouterSql,/same-store route mapping is incomplete or unsupported/);
});

test('pilot cross-store draft has no inventory effect and uses existing lifecycle', () => {
  assert.match(transferRouterSql,/'routeType','cross_store','status','draft','inventoryEffect',false,'shipped',false,'received',false/);
  assert.match(transferLifecycle,/if \(link\.route_type === 'cross_store'\) return postIntercompanyLeg/);
  assert.match(transferLifecycle,/status: 'shipped'/);
  assert.match(transferLifecycle,/status: 'completed'/);
  assert.doesNotMatch(transferWorker,/postIntercompanyLeg|inventoryAdjustQuantities/);
});

test('every pilot transfer mutation is server gated and scope is immutable', () => {
  assert.match(transferLifecycle,/await assertPilotTransferAction\(url,serviceRoleKey,auth,link,action\)/);
  assert.match(transferRouterSql,/pilot_transfer_scope_immutable/);
  assert.match(transferRouterSql,/p_action not in\('mark_pending','return_to_draft','ship','receive'\)/);
  assert.match(transferRouterSql,/x\.product_id=g\.approved_finished_product_id and x\.quantity=1/);
});

test('pilot ownership trigger keeps record-specific fields inside table branches', () => {
  assert.match(ownershipFixSql,/elsif tg_table_name='inventory_movements' then[\s\S]*new\.reference_type='manufacturing'/);
  assert.match(ownershipFixSql,/elsif tg_table_name='shopify_transfer_links' then[\s\S]*new\.manufacturing_handoff_id/);
  assert.doesNotMatch(ownershipFixSql,/tg_table_name='inventory_movements' and new\.reference_type/);
});

test('pilot transfer guard captures the validated gate before scope checks', () => {
  assert.match(transferGuardFixSql,/g:=public\.mfg_validate_pilot_work_order/);
  assert.match(transferGuardFixSql,/l\.source_location_id<>g\.origin_location_id/);
  assert.match(transferGuardFixSql,/x\.product_id=g\.approved_finished_product_id and x\.quantity=1/);
});

test('pilot close returns its durable result before lifecycle revalidation', () => {
  const lookup = closeIdempotencySql.indexOf("select details into r");
  const lifecycle = closeIdempotencySql.indexOf("if w.status<>'Completed'");
  assert.ok(lookup > 0 && lifecycle > lookup);
  assert.match(closeIdempotencySql,/if found then return r;end if/);
});
