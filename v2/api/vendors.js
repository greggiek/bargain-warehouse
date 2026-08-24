const { configuration, jsonHeaders } = require('./_lib/auth');
const { requireUser } = require('./_lib/require-user');
const ROLES = new Set(['admin', 'developer']);
const fields = ['name','code','contact_person','phone','email','vendor_type','tax_number','payment_term_name','website','shipping_address_line1','shipping_address_line2','shipping_address_city','shipping_address_state','shipping_address_zipcode','shipping_address_phone_number','shipping_address_mobile_number','shipping_address_country'];
const clean = value => String(value ?? '').trim();
function record(input) { const row = {}; fields.forEach(field => row[field] = clean(input[field])); if (!row.name) return null; return row; }
module.exports = async function vendors(req,res) {
 try {
  const auth=await requireUser(req); if(!auth.ok)return res.status(auth.status).json({ok:false,error:auth.error});
  if(!ROLES.has(auth.user.role)) return res.status(403).json({ok:false,error:'Only an admin can manage suppliers.'});
  const {url,serviceRoleKey}=configuration();
  if(req.method==='GET') { const response=await fetch(url+'/rest/v1/vendors?order=name.asc&select=*',{headers:jsonHeaders(serviceRoleKey),signal:AbortSignal.timeout(10000)}); const vendors=await response.json().catch(()=>[]); if(!response.ok)throw Error(vendors.message||'supplier lookup failed'); return res.status(200).json({ok:true,vendors}); }
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'method_not_allowed'});
  const body=req.body||{}, rows=(body.action==='import'?body.vendors:[body.vendor]).map(record).filter(Boolean);
  if(!rows.length)return res.status(400).json({ok:false,error:'A supplier name is required.'});
  if(rows.length>300)return res.status(400).json({ok:false,error:'Import 300 suppliers or fewer at a time.'});
  const response=await fetch(url+'/rest/v1/vendors?on_conflict=name_key',{method:'POST',headers:{...jsonHeaders(serviceRoleKey),Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify(rows),signal:AbortSignal.timeout(15000)});
  const result=await response.json().catch(()=>[]);
  if(!response.ok)throw Error(result.message||result.error||'supplier save failed');
  return res.status(200).json({ok:true,imported:rows.length,vendors:result});
 } catch(error) { return res.status(400).json({ok:false,error:error.message||'supplier_failed'}); }
};