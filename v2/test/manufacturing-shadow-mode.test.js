const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..','..');
const migration=fs.readFileSync(path.join(root,'supabase/migrations/20260902170000_manufacturing_shadow_mode.sql'),'utf8');
const rollback=fs.readFileSync(path.join(root,'supabase/rollbacks/20260902170000_manufacturing_shadow_mode_rollback.sql'),'utf8');
const command=fs.readFileSync(path.join(root,'v2/api/manufacturing-v2.js'),'utf8');
const view=fs.readFileSync(path.join(root,'v2/api/manufacturing-ui.js'),'utf8');
const inventoryWorker=fs.readFileSync(path.join(root,'v2/api/manufacturing-inventory-sync.js'),'utf8');
const transferWorker=fs.readFileSync(path.join(root,'v2/api/manufacturing-transfer-handoff.js'),'utf8');
const shadowUi=fs.readFileSync(path.join(root,'v2/manufacturing-shadow-mode.js'),'utf8');
const flags=['manufacturing_view_enabled','manufacturing_draft_enabled','manufacturing_release_enabled','manufacturing_completion_enabled','manufacturing_transfer_handoff_enabled','manufacturing_shopify_outbound_enabled'];

test('separate Shadow Mode controls replace the all-or-nothing database flag',()=>{for(const flag of flags)assert.match(migration,new RegExp(flag));assert.doesNotMatch(command,/flag_key=eq\.manufacturing_v2/);assert.doesNotMatch(view,/flag_key=eq\.manufacturing_v2/)});
test('only view and draft start enabled',()=>{assert.match(migration,/\('manufacturing_view_enabled',true/);assert.match(migration,/\('manufacturing_draft_enabled',true/);for(const flag of flags.slice(2))assert.match(migration,new RegExp(`\\('${flag}',false`))});
test('all user-facing access requires an active beta user and active BM user',()=>{assert.match(migration,/join public\.mfg_beta_users b[\s\S]*b\.active/);assert.match(migration,/join public\.app_users u[\s\S]*u\.active/);assert.match(view,/manufacturing_view_enabled/);assert.match(command,/manufacturing_draft_enabled/)});
test('release and every production-changing command are blocked by disabled controls',()=>{assert.match(command,/manufacturing_release_enabled/);const completions=(command.match(/manufacturing_completion_enabled/g)||[]).length;assert.ok(completions>=5)});
test('outbound inventory and transfer workers exit before claiming work',()=>{assert.ok(inventoryWorker.indexOf('manufacturing_shopify_outbound_enabled')<inventoryWorker.indexOf('claim_mfg_shopify_inventory_adjustment'));assert.ok(transferWorker.indexOf('manufacturing_transfer_handoff_enabled')<transferWorker.indexOf('claim_mfg_transfer_handoff'));assert.ok(transferWorker.indexOf('manufacturing_shopify_outbound_enabled')<transferWorker.indexOf('claim_mfg_transfer_handoff'))});
test('Shadow Mode is explicit and disables operational buttons',()=>{assert.match(shadowUi,/Qoblex remains the live Manufacturing system/);assert.match(shadowUi,/Release Work Order/);assert.match(shadowUi,/Confirm progress/);assert.match(shadowUi,/disabled=true/)});
test('migration is additive and rollback restores the disabled legacy kill switch',()=>{assert.doesNotMatch(migration,/drop table public\.mfg_work_orders|delete from public\.mfg_work_orders/i);assert.match(rollback,/manufacturing_v2/);assert.match(rollback,/enabled=false/)});
