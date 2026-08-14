const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const COOKIE = 'bm_warehouse_session';
const MAX_AGE = 60 * 60 * 12;
const attempts = new Map();
const LOGISTICS_COORDINATORS = new Set(['greg@bargainmoulding.com','edwin@bargainmoulding.com','justin@bargainmoulding.com','matt@bargainmoulding.com']);
const WAREHOUSE_MANAGERS = new Set(['evener.umanzor@bargainmoulding.com']);

function jsonHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' };
}
function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function encode(value) { return Buffer.from(value, 'utf8').toString('base64url'); }
function sign(payload) { return crypto.createHmac('sha256', env('AUTH_SECRET')).update(payload).digest('base64url'); }
function tokenFor(session) {
  const payload = encode(JSON.stringify({ ...session, expiresAt: Math.floor(Date.now() / 1000) + MAX_AGE }));
  return `${payload}.${sign(payload)}`;
}
function readToken(token) {
  if (!token) return null;
  const [payload, supplied] = token.split('.');
  if (!payload || !supplied) return null;
  const expected = sign(payload);
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.expiresAt > Math.floor(Date.now() / 1000) ? session : null;
  } catch { return null; }
}
function sessionFrom(req) {
  const cookies = String(req.headers.cookie || '').split(';').map(v => v.trim());
  const row = cookies.find(v => v.startsWith(`${COOKIE}=`));
  return readToken(row ? decodeURIComponent(row.slice(COOKIE.length + 1)) : '');
}
function setSession(res, session) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(tokenFor(session))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(); }
function rateLimited(req) {
  const key = clientIp(req), now = Date.now(), prior = attempts.get(key) || [];
  const recent = prior.filter(time => now - time < 10 * 60 * 1000);
  recent.push(now); attempts.set(key, recent);
  return recent.length > 10;
}
async function rest(base, key, path, options = {}) {
  const response = await fetch(`${base.replace(/\/+$/, '')}/rest/v1/${path}`, {
    ...options, headers: { ...jsonHeaders(key), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || `Database request failed (${response.status})`);
  return data;
}
function employeeView(session) {
  return { id: session.employeeId, name: session.name, role: session.role, permissions: session.permissions };
}

async function googleSession(req) {
  const bearer = String(req.headers.authorization || '');
  if (!bearer.startsWith('Bearer ')) return null;
  const base = env('BM_WAREHOUSE_SUPABASE_URL');
  const key = env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${base.replace(/\/+$/, '')}/auth/v1/user`, {
    headers: { apikey: key, Authorization: bearer, Accept: 'application/json' }
  });
  if (!response.ok) return null;
  const user = await response.json();
  const email = String(user.email || '').trim().toLowerCase();
  const coordinator=LOGISTICS_COORDINATORS.has(email),manager=WAREHOUSE_MANAGERS.has(email);
  if (!coordinator&&!manager) return null;
  return {
    employeeId: user.id,
    name: user.user_metadata?.full_name || email,
    email,
    role: 'Manager',
    permissions: coordinator?['receive','transfer','adjust','pickpack','fulfillment','admin','create_docs']:['receive','transfer'],
    jobTitle: coordinator?'Logistics Coordinator':'Warehouse Manager',
    principalType: 'google_workspace',
    clockedIn: true,
    location: null
  };
}

async function login(req, res) {
  if (rateLimited(req)) return res.status(429).json({ ok: false, error: 'Too many attempts. Wait 10 minutes.' });
  const pin = String(req.body?.pin || '');
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ ok: false, error: 'Enter a valid 4-digit PIN.' });
  const base = env('NEXT_PUBLIC_SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const employees = await rest(base, key, 'time_employees?select=id,first_name,last_name,pin_hash,active,time_job_titles(name)&active=eq.true');
  let matched = null;
  for (const employee of employees || []) {
    if (await bcrypt.compare(pin, employee.pin_hash)) { matched = employee; break; }
  }
  if (!matched) {
    const managers = await rest(
      base,
      key,
      'time_users?select=id,name,pin_hash,role,location_id,all_locations,active,time_locations(name)&active=eq.true'
    );
    let manager = null;
    for (const user of managers || []) {
      if (await bcrypt.compare(pin, user.pin_hash)) { manager = user; break; }
    }
    if (manager) {
      const timeLocation = Array.isArray(manager.time_locations)
        ? manager.time_locations[0]?.name
        : manager.time_locations?.name;
      const managerLocation = {
        Amityville: '336 Bayview',
        Bohemia: 'Bargain Moulding (Bohemia)',
        Riverhead: '1133 Old Country (Riverhead)',
        Windham: '730 Windham Rd'
      }[timeLocation] || '336 Bayview';
      const session = {
        employeeId: manager.id,
        name: manager.name,
        role: 'Manager',
        permissions: ['receive','transfer','adjust','pickpack','fulfillment','admin'],
        principalType: 'manager',
        clockedIn: true,
        location: managerLocation
      };
      setSession(res, session);
      return res.status(200).json({
        ok: true,
        employee: employeeView(session),
        clockedIn: true,
        location: managerLocation
      });
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    return res.status(401).json({ ok: false, error: 'PIN not recognized.' });
  }
  const title = Array.isArray(matched.time_job_titles) ? matched.time_job_titles[0]?.name : matched.time_job_titles?.name;
  const manager = /manager|admin/i.test(String(title || ''));
  const session = {
    employeeId: matched.id,
    name: `${matched.first_name} ${matched.last_name}`.trim(),
    role: manager ? 'Manager' : 'Warehouse',
    permissions: manager
      ? ['receive','transfer','adjust','pickpack','fulfillment','admin']
      : ['receive','transfer','adjust','pickpack','fulfillment'],
    principalType: 'employee',
    clockedIn: false,
    location: null
  };
  setSession(res, session);
  return res.status(200).json({ ok: true, employee: employeeView(session), clockedIn: false });
}

const CLOCK_LOCATION = {
  '336 Bayview': 'Amityville',
  'Bargain Moulding (Bohemia)': 'Bohemia',
  '1133 Old Country (Riverhead)': 'Riverhead',
  '730 Windham Rd': 'Windham',
  'Annex Warehouse': 'Windham'
};

async function clock(req, res, session) {
  const action = req.body?.clockAction;
  const warehouseLocation = String(req.body?.location || '');
  if (!['clock_in', 'clock_out'].includes(action)) return res.status(400).json({ ok: false, error: 'Invalid clock action.' });
  const timeLocation = CLOCK_LOCATION[warehouseLocation];
  if (!timeLocation) return res.status(400).json({ ok: false, error: 'That location does not have an employee time clock.' });
  if (session.principalType === 'manager') {
    const next = { ...session, clockedIn: action === 'clock_in', location: warehouseLocation };
    setSession(res, next);
    return res.status(200).json({
      ok: true,
      employee: employeeView(next),
      clockedIn: next.clockedIn,
      location: next.location
    });
  }
  const base = env('NEXT_PUBLIC_SUPABASE_URL'), key = env('SUPABASE_SERVICE_ROLE_KEY');
  const locations = await rest(base, key, `time_locations?select=id,name&name=eq.${encodeURIComponent(timeLocation)}&active=eq.true&limit=1`);
  const location = locations[0];
  if (!location) throw new Error('BM Time location not found.');
  const kiosks = await rest(base, key, `time_kiosks?select=id&location_id=eq.${location.id}&active=eq.true&limit=1`);
  if (!kiosks[0]) throw new Error('BM Time kiosk not found.');
  await rest(base, key, 'time_punch_events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ employee_id: session.employeeId, location_id: location.id, kiosk_id: kiosks[0].id, action })
  });
  const next = { ...session, clockedIn: action === 'clock_in', location: warehouseLocation };
  setSession(res, next);
  return res.status(200).json({ ok: true, employee: employeeView(next), clockedIn: next.clockedIn, location: next.location });
}

async function inventory(res) {
  const base = env('BM_WAREHOUSE_SUPABASE_URL'), key = env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const snapshot = await rest(base, key, 'shopify_inventory_snapshot?select=sku,product_name,location_name,on_hand,synced_at&order=sku.asc');
  const map = new Map(); let generatedAt = null;
  for (const row of snapshot) {
    const sku = String(row.sku || '').trim(); if (!sku) continue;
    if (!map.has(sku)) map.set(sku, { sku, product: row.product_name || '', totalOnHand: 0, locations: [] });
    const item = map.get(sku), onHand = Number(row.on_hand || 0);
    item.totalOnHand += onHand; item.locations.push({ locationName: row.location_name || '', onHand });
    if (row.synced_at && (!generatedAt || row.synced_at > generatedAt)) generatedAt = row.synced_at;
  }
  return res.status(200).json({ ok: true, mode: 'SUPABASE_CACHE', shopifyWritesEnabled: false, normalized: [...map.values()], normalizedCount: map.size, generatedAt });
}

function requireCoordinator(session, res) {
  if (session?.permissions?.includes('create_docs')) return true;
  res.status(403).json({ ok: false, error: 'Logistics Coordinator access is required to create purchase orders or transfers.' });
  return false;
}

async function writeActivity(session,event){
  const base=env('BM_WAREHOUSE_SUPABASE_URL'),key=env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  await rest(base,key,'activity_events',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({user_id:session.employeeId||null,user_name:session.name||session.email||'Unknown user',user_email:session.email||null,action_type:String(event.actionType||'').slice(0,60),document_type:event.documentType||null,document_number:event.documentNumber||null,warehouse:event.warehouse||null,description:String(event.description||'').slice(0,500),status:event.status||null,metadata:event.metadata||{}})});
}

async function activityEvents(req,res,session){
  if(!session.permissions?.includes('admin'))return res.status(403).json({ok:false,error:'Manager activity access is required.'});
  const base=env('BM_WAREHOUSE_SUPABASE_URL'),key=env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY'),q=req.query||{};
  const filters=['select=id,created_at,user_name,user_email,action_type,document_type,document_number,warehouse,description,status,metadata','order=created_at.desc',`limit=${Math.min(500,Math.max(1,Number(q.limit)||200))}`];
  if(q.action)filters.push(`action_type=eq.${encodeURIComponent(String(q.action).slice(0,60))}`);
  if(q.user)filters.push(`or=(user_name.ilike.*${encodeURIComponent(String(q.user).slice(0,100))}*,user_email.ilike.*${encodeURIComponent(String(q.user).slice(0,100))}*)`);
  if(q.document)filters.push(`document_number=ilike.*${encodeURIComponent(String(q.document).slice(0,100))}*`);
  if(q.warehouse)filters.push(`warehouse=eq.${encodeURIComponent(String(q.warehouse).slice(0,100))}`);
  if(q.from)filters.push(`created_at=gte.${encodeURIComponent(String(q.from))}`);
  if(q.to)filters.push(`created_at=lte.${encodeURIComponent(String(q.to))}`);
  const events=await rest(base,key,`activity_events?${filters.join('&')}`);
  const facets=await rest(base,key,'activity_events?select=user_name,user_email,action_type,warehouse&order=created_at.desc&limit=1000');
  return res.status(200).json({ok:true,events,facets:{actions:[...new Set(facets.map(x=>x.action_type).filter(Boolean))].sort(),users:[...new Set(facets.map(x=>x.user_email||x.user_name).filter(Boolean))].sort(),warehouses:[...new Set(facets.map(x=>x.warehouse).filter(Boolean))].sort()}});
}

async function logClientActivity(req,res,session){
  const body=req.body||{};
  if(!/^[A-Z][A-Z0-9_]{1,59}$/.test(String(body.actionType||'')))return res.status(400).json({ok:false,error:'Invalid activity type.'});
  if(!String(body.description||'').trim())return res.status(400).json({ok:false,error:'Activity description is required.'});
  await writeActivity(session,body);return res.status(201).json({ok:true});
}

async function receivePurchaseOrder(req,res,session){
  if(!session.permissions?.includes('receive'))return res.status(403).json({ok:false,error:'Receiving access is required.'});
  const body=req.body||{},poNumber=String(body.poNumber||'').trim().toUpperCase(),lines=Array.isArray(body.lines)?body.lines:[];
  if(!/^PO-[A-Z0-9-]{4,30}$/.test(poNumber))return res.status(400).json({ok:false,error:'Invalid PO number.'});
  const received=lines.map(line=>({sku:String(line.sku||'').trim().toUpperCase(),qty:Number(line.qty||0)})).filter(line=>line.sku&&line.qty>0);
  if(!received.length)return res.status(400).json({ok:false,error:'Enter at least one received quantity.'});
  const base=env('BM_WAREHOUSE_SUPABASE_URL'),key=env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const result=await rest(base,key,'rpc/receive_purchase_order',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({p_po_number:poNumber,p_lines:received,p_employee_name:session.name,p_employee_email:session.email||null})});
  const value=Array.isArray(result)?result[0]:result;
  await writeActivity(session,{actionType:'PO_RECEIVED',documentType:'purchase_order',documentNumber:poNumber,warehouse:String(body.warehouse||''),description:`Received ${received.reduce((sum,line)=>sum+line.qty,0)} pieces on ${poNumber}`,status:value?.status||'partial',metadata:{lines:received,costUpdates:value?.cost_updates||[]}});
  return res.status(200).json({ok:true,receipt:value});
}

async function purchaseOrderReference(res) {
  const base = env('BM_WAREHOUSE_SUPABASE_URL'), key = env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const [vendors, locations] = await Promise.all([
    rest(base, key, 'vendors?select=id,code,name&active=eq.true&order=name.asc'),
    rest(base, key, 'warehouse_locations?select=id,code,name&active=eq.true&order=name.asc')
  ]);
  return res.status(200).json({ ok: true, vendors, locations });
}

async function createPurchaseOrder(req, res, session) {
  if (!requireCoordinator(session, res)) return;
  const body = req.body || {}, lines = Array.isArray(body.lines) ? body.lines : [];
  const poNumber = String(body.poNumber || '').trim().toUpperCase();
  const supplierReferenceNumber = String(body.supplierReferenceNumber || '').trim();
  const status = body.status === 'open' ? 'open' : 'draft';
  const shippingCost = Number(body.shippingCost || 0);
  if (!/^PO-[A-Z0-9-]{4,30}$/.test(poNumber)) return res.status(400).json({ ok: false, error: 'Enter a valid PO number.' });
  if (supplierReferenceNumber.length > 100) return res.status(400).json({ ok: false, error: 'Supplier reference number must be 100 characters or fewer.' });
  if (!body.vendorId || !body.destinationLocationId) return res.status(400).json({ ok: false, error: 'Choose a vendor and destination warehouse.' });
  if (!Number.isFinite(shippingCost) || shippingCost < 0) return res.status(400).json({ ok: false, error: 'Shipping cost cannot be negative.' });
  if (!lines.length) return res.status(400).json({ ok: false, error: 'Add at least one material line.' });
  for (const line of lines) {
    if (!String(line.sku || '').trim() || !(Number(line.orderedQty) > 0)) return res.status(400).json({ ok: false, error: 'Every line needs a SKU and quantity above zero.' });
  }
  const base = env('BM_WAREHOUSE_SUPABASE_URL'), key = env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  let purchaseOrder = null;
  try {
    const created = await rest(base, key, 'purchase_orders?select=id,po_number,status,created_at', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        po_number: poNumber, supplier_reference_number: supplierReferenceNumber || null,
        vendor_id: body.vendorId, destination_location_id: body.destinationLocationId,
        status, order_date: body.orderDate || new Date().toISOString().slice(0, 10),
        expected_date: body.expectedDate || null, shipping_cost: shippingCost,
        notes: [String(body.notes || '').trim(), `Created by ${session.name}`].filter(Boolean).join('\n')
      })
    });
    purchaseOrder = created[0];
    for (const raw of lines) {
      const sku = String(raw.sku).trim().toUpperCase(), name = String(raw.name || sku).trim();
      let products = await rest(base, key, `products?select=id&sku=eq.${encodeURIComponent(sku)}&limit=1`);
      if (!products[0]) {
        products = await rest(base, key, 'products?select=id', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ sku, name, uom: String(raw.uom || 'EA').trim().toUpperCase(), purchase_price: Number(raw.unitCost || 0) })
        });
      }
      await rest(base, key, 'purchase_order_lines', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ purchase_order_id: purchaseOrder.id, product_id: products[0].id, ordered_qty: Number(raw.orderedQty), unit_cost: Number(raw.unitCost || 0) })
      });
    }
    await writeActivity(session,{actionType:status==='open'?'PO_OPENED':'PO_DRAFT_SAVED',documentType:'purchase_order',documentNumber:poNumber,warehouse:body.destinationName||null,description:`${status==='open'?'Opened':'Saved draft'} purchase order ${poNumber} with ${lines.length} line${lines.length===1?'':'s'}`,status,metadata:{lineCount:lines.length,vendorId:body.vendorId,destinationLocationId:body.destinationLocationId,shippingCost}});
    return res.status(201).json({ ok: true, purchaseOrder: { ...purchaseOrder, lineCount: lines.length, createdBy: session.name } });
  } catch (error) {
    if (purchaseOrder?.id) {
      await rest(base, key, `purchase_order_lines?purchase_order_id=eq.${purchaseOrder.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => null);
      await rest(base, key, `purchase_orders?id=eq.${purchaseOrder.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => null);
    }
    throw error;
  }
}

const TRANSFER_LOCATION_NAMES = {
  '336 Bayview': 'Amityville Main',
  'Bargain Moulding (Bohemia)': 'Bohemia Main',
  '1133 Old Country (Riverhead)': 'Riverhead Main',
  '730 Windham Rd': '730 Windham Rd',
  'Annex Warehouse': 'Annex Warehouse',
  'Outpost - Ronkonkoma': 'Outpost - Ronkonkoma'
};

async function saveTransferDraft(req, res, session) {
  if(!requireCoordinator(session,res))return;
  const body=req.body||{},transferNumber=String(body.transferNumber||'').trim().toUpperCase(),lines=Array.isArray(body.lines)?body.lines:[];
  const fromName=TRANSFER_LOCATION_NAMES[String(body.from||'')],toName=TRANSFER_LOCATION_NAMES[String(body.to||'')];
  if(!/^TR-\d{8}-\d{9}$/.test(transferNumber))return res.status(400).json({ok:false,error:'Invalid transfer number.'});
  if(!fromName||!toName||fromName===toName)return res.status(400).json({ok:false,error:'Choose two different warehouse locations.'});
  if(!lines.length)return res.status(400).json({ok:false,error:'Add at least one transfer line before saving.'});
  if(lines.some(line=>!String(line.sku||'').trim()||!(Number(line.qty)>0)))return res.status(400).json({ok:false,error:'Every transfer line needs a SKU and quantity.'});
  const base=env('BM_WAREHOUSE_SUPABASE_URL'),key=env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const locations=await rest(base,key,`warehouse_locations?select=id,name&name=in.(${encodeURIComponent(fromName)},${encodeURIComponent(toName)})`);
  const from=locations.find(row=>row.name===fromName),to=locations.find(row=>row.name===toName);
  if(!from||!to)throw new Error('A warehouse location is not configured in BM Warehouse.');
  let existing=await rest(base,key,`transfers?select=id&transfer_number=eq.${encodeURIComponent(transferNumber)}&limit=1`),transferId=existing[0]?.id;
  const status=body.status==='awaiting_receipt'?'awaiting_receipt':'draft';
  const transferRow={transfer_number:transferNumber,from_location_id:from.id,to_location_id:to.id,status,notes:String(body.note||'').trim()||null,created_by_name:session.name,created_by_email:session.email||null,updated_at:new Date().toISOString()};
  if(transferId){
    await rest(base,key,`transfers?id=eq.${transferId}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(transferRow)});
    await rest(base,key,`transfer_lines?transfer_id=eq.${transferId}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});
  }else{
    const created=await rest(base,key,'transfers?select=id',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(transferRow)});transferId=created[0].id;
  }
  for(const raw of lines){
    const sku=String(raw.sku).trim().toUpperCase(),name=String(raw.name||sku).trim();
    let products=await rest(base,key,`products?select=id&sku=eq.${encodeURIComponent(sku)}&limit=1`);
    if(!products[0])products=await rest(base,key,'products?select=id',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({sku,name,uom:'EA',purchase_price:0})});
    await rest(base,key,'transfer_lines',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({transfer_id:transferId,product_id:products[0].id,requested_qty:Number(raw.qty)})});
  }
  await writeActivity(session,{actionType:status==='awaiting_receipt'?'TRANSFER_SENT':'TRANSFER_DRAFT_SAVED',documentType:'transfer',documentNumber:transferNumber,warehouse:String(body.to||''),description:`${status==='awaiting_receipt'?'Sent':'Saved draft'} transfer ${transferNumber} from ${body.from} to ${body.to} with ${lines.length} line${lines.length===1?'':'s'}`,status,metadata:{from:body.from,to:body.to,lineCount:lines.length}});
  return res.status(200).json({ok:true,transfer:{id:transferId,transferNumber,status,lineCount:lines.length,savedBy:session.name}});
}

function one(value){return Array.isArray(value)?value[0]:value}
const APP_LOCATION_NAMES={'Amityville Main':'336 Bayview','Bohemia Main':'Bargain Moulding (Bohemia)','Riverhead Main':'1133 Old Country (Riverhead)'};

async function waitingPurchaseOrders(res){
  const base=env('BM_WAREHOUSE_SUPABASE_URL'),key=env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const rows=await rest(base,key,'purchase_orders?select=id,po_number,status,expected_date,supplier_reference_number,vendors(name),warehouse_locations(name),purchase_order_lines(id,ordered_qty,received_qty,products(name,sku))&status=in.(open,partial)&order=created_at.asc');
  return res.status(200).json({ok:true,purchaseOrders:rows.map(row=>({
    id:row.id,ref:row.po_number,poNumber:row.po_number,status:row.status,supplier:one(row.vendors)?.name||'Unknown vendor',shipTo:one(row.warehouse_locations)?.name||'',supplierRef:row.supplier_reference_number||'',expectedDate:row.expected_date||'',
    lines:(row.purchase_order_lines||[]).map(line=>{const product=one(line.products)||{};return{id:line.id,sku:product.sku||'',name:product.name||product.sku||'',barcode:product.barcode||product.sku||'',ordered:Number(line.ordered_qty||0),received:Number(line.received_qty||0)}})
  }))});
}

async function waitingTransfers(res){
  const base=env('BM_WAREHOUSE_SUPABASE_URL'),key=env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const rows=await rest(base,key,'transfers?select=id,transfer_number,status,notes,created_by_name,updated_at,from:warehouse_locations!transfers_from_location_id_fkey(name),to:warehouse_locations!transfers_to_location_id_fkey(name),transfer_lines(id,requested_qty,shipped_qty,received_qty,products(name,sku))&status=eq.awaiting_receipt&order=updated_at.asc');
  return res.status(200).json({ok:true,transfers:rows.map(row=>({
    id:row.id,ref:row.transfer_number,status:'Awaiting Receipt',from:APP_LOCATION_NAMES[one(row.from)?.name]||one(row.from)?.name||'',to:APP_LOCATION_NAMES[one(row.to)?.name]||one(row.to)?.name||'',createdBy:row.created_by_name||'',note:row.notes||'',
    lines:(row.transfer_lines||[]).map(line=>{const product=one(line.products)||{};return{id:line.id,sku:product.sku||'',name:product.name||product.sku||'',barcode:product.barcode||product.sku||'',expected:Number(line.requested_qty||0)}})
  }))});
}

module.exports = async function (req, res) {
  try {
    const action = String(req.query?.action || req.body?.action || '');
    if (action === 'login' && req.method === 'POST') return login(req, res);
    if (action === 'logout' && req.method === 'POST') { clearSession(res); return res.status(200).json({ ok: true }); }
    if (action === 'po-reference' && req.method === 'GET') return purchaseOrderReference(res);
    const session = await googleSession(req) || sessionFrom(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Sign in required.' });
    if (action === 'session' && req.method === 'GET') return res.status(200).json({ ok: true, employee: employeeView(session), clockedIn: session.clockedIn, location: session.location });
    if (action === 'clock' && req.method === 'POST') return clock(req, res, session);
    if (action === 'inventory' && req.method === 'GET') return inventory(res);
    if (action === 'waiting-pos' && req.method === 'GET') return waitingPurchaseOrders(res);
    if (action === 'waiting-transfers' && req.method === 'GET') return waitingTransfers(res);
    if (action === 'activity' && req.method === 'GET') return activityEvents(req,res,session);
    if (action === 'log-activity' && req.method === 'POST') return logClientActivity(req,res,session);
    if (action === 'receive-po' && req.method === 'POST') return receivePurchaseOrder(req,res,session);
    if (action === 'create-po' && req.method === 'POST') return createPurchaseOrder(req, res, session);
    if (action === 'save-transfer' && req.method === 'POST') return saveTransferDraft(req, res, session);
    return res.status(404).json({ ok: false, error: 'Unknown action.' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
