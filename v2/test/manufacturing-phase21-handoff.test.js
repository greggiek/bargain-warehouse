const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..','..');
const sql=fs.readFileSync(path.join(root,'supabase/migrations/20260902160000_manufacturing_native_transfer_handoff.sql'),'utf8');
const rollback=fs.readFileSync(path.join(root,'supabase/rollbacks/20260902160000_manufacturing_native_transfer_handoff_rollback.sql'),'utf8');
const worker=fs.readFileSync(path.join(root,'v2/api/manufacturing-transfer-handoff.js'),'utf8');
const lifecycle=fs.readFileSync(path.join(root,'v2/api/shopify-transfer-lifecycle.js'),'utf8');
const normalTransfer=fs.readFileSync(path.join(root,'v2/api/shopify-transfer-preview.js'),'utf8');
const nativeTransfer=fs.readFileSync(path.join(root,'v2/api/_lib/shopify-native-transfer.js'),'utf8');

test('completion creates one durable handoff and makes no Shopify call',()=>{
 assert.match(sql,/work_order_id bigint not null unique/);
 assert.match(sql,/completed_transfer_handoff_pending/);
 assert.match(sql,/'shopifyCall',false/);
 assert.doesNotMatch(sql,/https?:\/\//);
});
test('handoff contains actual good quantities only',()=>{
 assert.match(sql,/where l\.work_order_id=w\.id and l\.good_quantity>0/);
 assert.match(sql,/sku,l\.good_quantity/);
});
test('partial production does not create a Shopify transfer',()=>assert.doesNotMatch(worker,/record_mfg_progress/));
test('completion waits for confirmed finished inventory and cache evidence',()=>{
 assert.match(sql,/a\.status<>'confirmed'/);
 assert.match(sql,/shopify_inventory_cache/);
 assert.match(sql,/pending_inventory_confirmation/);
});
test('confirmed inventory makes handoff ready',()=>assert.match(sql,/set status='ready'/));
test('worker leases one handoff with skip locked',()=>{
 assert.match(sql,/for update skip locked limit 1/);
 assert.match(sql,/lease_expires_at<now\(\)/);
});
test('worker uses existing native transfer mutation and stable key',()=>{
 assert.match(worker,/createShopifyNativeDraftTransfer/);
 assert.match(nativeTransfer,/inventoryTransferCreate/);
 assert.match(nativeTransfer,/@idempotent\(key: \$idempotencyKey\)/);
 assert.match(worker,/idempotencyKey:claim\.idempotencyKey/);
 assert.doesNotMatch(worker,/randomUUID/);
});
test('normal and Manufacturing creation converge on one shared helper',()=>{
 assert.match(normalTransfer,/require\('\.\/_lib\/shopify-native-transfer'\)/);
 assert.match(worker,/require\('\.\/_lib\/shopify-native-transfer'\)/);
 assert.equal((normalTransfer.match(/createShopifyNativeDraftTransfer\(/g)||[]).length,1);
 assert.equal((worker.match(/createShopifyNativeDraftTransfer\(/g)||[]).length,1);
 assert.equal((nativeTransfer.match(/inventoryTransferCreate\(input:/g)||[]).length,1);
 assert.doesNotMatch(normalTransfer,/inventoryTransferCreate\(input:/);
 assert.doesNotMatch(worker,/inventoryTransferCreate\(input:/);
 assert.match(nativeTransfer,/const API_VERSION = '2026-07'/);
});
test('native link relationship is unique and contains every line',()=>{
 assert.match(sql,/manufacturing_handoff_id bigint unique/);
 assert.match(sql,/insert into public\.shopify_transfer_link_lines/);
});
test('lost response reconciles an existing linked Shopify transfer',()=>{
 assert.match(worker,/existingShopifyTransferId/);
 assert.match(worker,/reconciledExisting:true/);
});
test('temporary failure uses bounded exponential retry',()=>{
 assert.match(sql,/status='retryable_error'/);
 assert.match(sql,/least\(interval '1 hour'/);
 assert.match(worker,/retryable:true/);
});
test('mapping failure blocks the entire handoff',()=>{
 assert.match(sql,/status='blocked_mapping'/);
 assert.match(sql,/Missing Shopify mapping for SKU/);
 assert.doesNotMatch(worker,/filter\(.*inventoryItemId/);
});

test('mapping repair is re-resolved and admin-only cancellation is audited',()=>{
 assert.match(sql,/Re-resolve mutable route\/source mappings/);
 assert.match(sql,/manufacturing_admin_correction/);
 assert.match(sql,/transfer_handoff_cancelled_admin_correction/);
 assert.match(sql,/source_shopify_transfer_id is not null/);
});
test('completed inventory survives transfer failure',()=>{
 const fail=sql.match(/create or replace function public\.fail_mfg_transfer_handoff[\s\S]*?end \$\$;/)[0];
 assert.doesNotMatch(fail,/inventory_balances|inventory_movements|mfg_finished_inventory_events/);
});
test('closing requires created link, exact lines, and confirmed adjustments',()=>{
 assert.match(sql,/work_order_transfer_handoff_unresolved/);
 assert.match(sql,/sl\.quantity=x\.good_quantity/);
 assert.match(sql,/a\.status<>'confirmed'/);
});
test('worker creates draft but never ships or receives',()=>{
 assert.match(worker,/Draft only; no inventory moved/);
 assert.doesNotMatch(worker,/inventoryShipmentCreateInTransit|inventoryShipmentReceive|markReady/);
});
test('supported lifecycle retains idempotent ship and receipt operations',()=>{
 assert.match(lifecycle,/inventoryShipmentCreateInTransit[\s\S]*@idempotent/);
 assert.match(lifecycle,/inventoryShipmentReceive[\s\S]*@idempotent/);
 assert.match(lifecycle,/shipNative/);
 assert.match(lifecycle,/receiveNative/);
});
test('Phase 2.1 never calls retired legacy transfer API or table',()=>{
 assert.doesNotMatch(worker,/\/api\/transfers|insert into public\.transfers|insert into public\.transfer_lines/);
 const complete=sql.match(/create or replace function public\.complete_mfg_work_order[\s\S]*?end \$\$;/)[0];
 assert.doesNotMatch(complete,/insert into public\.transfers|insert into public\.transfer_lines|physical_transfer_id/);
});
test('legal states and transitions are database enforced',()=>{
 for(const state of ['pending_inventory_confirmation','ready','processing','created','retryable_error','blocked_mapping','permanent_error','cancelled'])
  assert.match(sql,new RegExp("'"+state+"'"));
 assert.match(sql,/invalid_manufacturing_handoff_transition/);
});
test('component and finished adjustment idempotency remains untouched',()=>{
 assert.doesNotMatch(sql,/create or replace function public\.mfg_apply_inventory_movement/);
 assert.doesNotMatch(sql,/create or replace function public\.record_mfg_progress/);
});
test('rollback removes only Phase 2.1 handoff structures',()=>{
 assert.match(rollback,/drop table if exists public\.mfg_transfer_handoff_inventory_adjustments/);
 assert.match(rollback,/drop table if exists public\.mfg_transfer_handoffs/);
 assert.doesNotMatch(rollback,/drop table if exists public\.transfers/);
});
