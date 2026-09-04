const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const sql=fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20260904090000_manufacturing_cross_store_close.sql'),'utf8');

test('Manufacturing close accepts only a fully received routed transfer',()=>{
  assert.match(sql,/sl\.status<>'received'/);
  assert.match(sql,/sl\.route_type='same_store'/);
  assert.match(sql,/sl\.route_type='cross_store'/);
  assert.match(sql,/a\.leg='ship' and a\.status='applied'\)<>1/);
  assert.match(sql,/a\.leg='receive' and a\.status='applied'\)<>1/);
});

test('cross-store close has no inventory or Shopify mutation',()=>{
  const body=sql.match(/create or replace function public\.close_mfg_work_order[\s\S]*?end \$\$;/)[0];
  assert.doesNotMatch(body,/inventoryAdjust|inventory_balances|inventory_movements/);
  assert.match(body,/'inventoryEffect',false/);
});

test('close remains idempotent and preserves immutable transfer ownership',()=>{
  assert.match(sql,/idempotency_key=p_idempotency_key\|\|':audit'/);
  assert.match(sql,/manufacturing_handoff_id=h\.id/);
  assert.match(sql,/sl\.pilot_work_order_id is distinct from w\.id/);
});
