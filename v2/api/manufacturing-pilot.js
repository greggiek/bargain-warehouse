const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');

const PILOT = 'BM-MFG-PILOT-001';
const ALLOWED_EMAILS = new Set(['greg@bargainmoulding.com','edwin@bargainmoulding.com']);

async function rpc(url, key, name, body) {
  const response = await fetch(url + '/rest/v1/rpc/' + name, { method:'POST', headers:{...jsonHeaders(key),'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || name + ' failed');
  return data;
}

module.exports = async function manufacturingPilot(req, res) {
  const auth = await requireUser(req);
  if (!auth.ok) return res.status(auth.status).json({ok:false,error:auth.error});
  if (!ALLOWED_EMAILS.has(String(auth.user.email || '').toLowerCase())) return res.status(403).json({ok:false,error:'pilot_operator_not_approved'});
  if (req.method !== 'POST') return res.status(405).json({ok:false,error:'method_not_allowed'});
  const {url,serviceRoleKey}=configuration(); const body=req.body||{};
  try {
    if(body.action==='bind_draft') return res.status(200).json({ok:true,...await rpc(url,serviceRoleKey,'bind_manufacturing_pilot_draft',{p_actor_user_id:auth.user.id,p_work_order_id:Number(body.workOrderId)})});
    const allowed=new Set(['release','start','record_good_unit','complete','close']);
    if (!allowed.has(body.action)) return res.status(403).json({ok:false,error:'pilot_action_rejected'});
    const result=await rpc(url,serviceRoleKey,'run_manufacturing_pilot_action',{p_actor_user_id:auth.user.id,p_work_order_id:Number(body.workOrderId),p_action:body.action,p_idempotency_key:String(body.idempotencyKey||'')});
    return res.status(200).json({ok:true,...result});
  } catch(error) { return res.status(400).json({ok:false,error:error.message||'pilot_request_failed'}); }
};
