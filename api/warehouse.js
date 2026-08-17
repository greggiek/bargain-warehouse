const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const COOKIE = 'bm_warehouse_session';
const MAX_AGE = 60 * 60 * 12;
const attempts = new Map();
const LOGISTICS_COORDINATORS = new Set(['greg@bargainmoulding.com','edwin@bargainmoulding.com','justin@bargainmoulding.com','matt@bargainmoulding.com']);
const WAREHOUSE_MANAGERS = new Set(['evener.umanzor@bargainmoulding.com']);
const MANAGER_WAREHOUSE_ASSIGNMENTS = new Map([
  ['evener.umanzor@bargainmoulding.com', ['730 Windham Rd']]
]);

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
function qoblexConfig() {
  return {
    base: env('QOBLEX_BASE_URL').replace(/\/+$/, ''),
    key: env('QOBLEX_API_KEY')
  };
}
async function qoblex(path, options = {}) {
  const config = qoblexConfig();
  const response = await fetch(`${config.base}${path}`, {
    ...options,
    headers: {
      'qoblex-x-api-key': config.key,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Qoblex request failed (${response.status})`);
    error.status = response.status;
    error.qoblexData = data;
    throw error;
  }
  return data;
}
function rowsFrom(value, keys = []) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  if (Array.isArray(value?.data)) return value.data;
  return [];
}
const qoblexVariantCache = new Map();
const qoblexLocationCache = { expiresAt: 0, rows: [] };
const QOBLEX_LOCATION_IDS = new Map([
  ['336 bayview', 16705],
  ['outpost - ronkonkoma', 19672],
  ['bargain moulding (bohemia)', 19684],
  ['bohemia', 19684],
  ['1133 old country (riverhead)', 20249],
  ['riverhead', 20249],
  ['730 windham rd', 20947],
  ['730 windham', 20947],
  ['annex warehouse', 21323],
  ['annex', 21323]
]);
async function qoblexLocations() {
  if (qoblexLocationCache.expiresAt > Date.now()) return qoblexLocationCache.rows;
  const data = await qoblex('/v1/account/locations?expand=address');
  const rows = rowsFrom(data, ['locations']);
  qoblexLocationCache.rows = rows;
  qoblexLocationCache.expiresAt = Date.now() + 5 * 60 * 1000;
  return rows;
}
async function qoblexVariantForSku(rawSku) {
  const sku = String(rawSku || '').trim().toUpperCase();
  if (!sku) throw new Error('A transfer line is missing its SKU.');
  if (qoblexVariantCache.has(sku)) return qoblexVariantCache.get(sku);
  const data = await qoblex(`/v1/variants?filters=${encodeURIComponent(`sku==${sku}`)}`);
  const exact = rowsFrom(data, ['variants', 'items', 'results']).filter(row => String(row.sku || '').trim().toUpperCase() === sku);
  if (exact.length !== 1) throw new Error(exact.length ? `Qoblex has more than one variant for SKU ${sku}.` : `SKU ${sku} was not found in Qoblex.`);
  qoblexVariantCache.set(sku, exact[0]);
  return exact[0];
}
function qoblexLocationFor(locations, rawName) {
  const name = String(rawName || '').trim().toLowerCase();
  const configuredId = QOBLEX_LOCATION_IDS.get(name);
  if (configuredId) return locations.find(row => Number(row.id) === configuredId) || { id: configuredId, name: rawName };
  return locations.find(row => String(row.name || '').trim().toLowerCase() === name);
}
function employeeView(session) {
  return { id: session.employeeId, name: session.name, role: session.role, roleKey: session.roleKey || null, permissions: session.permissions, allowedLocations: session.allowedLocations || null };
}
function allowedLocations(session){return Array.isArray(session?.allowedLocations)&&session.allowedLocations.length?session.allowedLocations:null}
function canAccessLocation(session,location){const allowed=allowedLocations(session);return !allowed||allowed.includes(String(location||''))}

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
  const profiles=await rest(base,key,`warehouse_app_users?select=id,display_name,email,username,role,location,active&or=(auth_user_id.eq.${user.id},email.ilike.${encodeURIComponent(email)})&active=eq.true&limit=1`),profile=profiles[0];
  if(!profile)return null;
  const coordinator=['administrator','developer','logistics_coordinator'].includes(profile.role),manager=profile.role==='warehouse_manager';
  const assignedLocations=profile.location?[profile.location]:null;
  const permissions=coordinator?['receive','transfer','adjust','pickpack','fulfillment','admin','create_docs']:manager?['receive','transfer','adjust','pickpack','fulfillment','admin']:['receive','transfer','pickpack','fulfillment'];
  return {
    employeeId: profile.id,
    name: profile.display_name || user.user_metadata?.full_name || profile.username || email,
    email,
    role: coordinator?'Logistics Coordinator':manager?'Warehouse Manager':'Warehouse Employee',
    roleKey: profile.role,
    permissions,
    jobTitle: coordinator?'Logistics Coordinator':manager?'Warehouse Manager':'Warehouse Employee',
    principalType: profile.username?'employee_pin':'google_workspace',
    clockedIn: true,
    location: assignedLocations?.[0]||null,
    allowedLocations: assignedLocations
  };
}

function canReceiveTransfers(session) {
  return ['administrator', 'logistics_coordinator', 'warehouse_manager'].includes(session?.roleKey)
    || session?.role === 'Manager';
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
        roleKey: 'warehouse_manager',
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
    roleKey: manager ? 'warehouse_manager' : 'warehouse_employee',
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

async function inventory(res,session) {
  const base = env('BM_WAREHOUSE_SUPABASE_URL'), key = env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const snapshot = await rest(base, key, 'shopify_inventory_snapshot?select=sku,product_name,location_name,on_hand,synced_at&order=sku.asc');
  const map = new Map(); let generatedAt = null;
  const assigned=allowedLocations(session);
  for (const row of snapshot) {
    if(assigned&&!assigned.includes(String(row.location_name||'')))continue;
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
  const poRows=await rest(base,key,`purchase_orders?select=id,warehouse_locations(name)&po_number=eq.${encodeURIComponent(poNumber)}&limit=1`);
  if(!poRows[0])return res.status(404).json({ok:false,error:'Purchase order not found.'});
  const destination=one(poRows[0].warehouse_locations)?.name||'';
  if(!canAccessLocation(session,destination))return res.status(403).json({ok:false,error:`This purchase order belongs to ${destination||'another warehouse'}.`});
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
  let existing=await rest(base,key,`transfers?select=id,status&transfer_number=eq.${encodeURIComponent(transferNumber)}&limit=1`),transferId=existing[0]?.id;
  const status=body.status==='awaiting_receipt'?'awaiting_receipt':'draft';
  if(existing[0]&&!['draft','awaiting_receipt'].includes(existing[0].status))return res.status(409).json({ok:false,error:'This transfer is already being received and can no longer be edited.'});
  const now=new Date().toISOString();
  const transferRow={transfer_number:transferNumber,from_location_id:from.id,to_location_id:to.id,status,notes:String(body.note||'').trim()||null,created_by_name:session.name,created_by_email:session.email||null,updated_at:now,...(status==='awaiting_receipt'?{shipped_at:now}:{})};
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
    const qty=Number(raw.qty);
    await rest(base,key,'transfer_lines',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({transfer_id:transferId,product_id:products[0].id,requested_qty:qty,shipped_qty:status==='awaiting_receipt'?qty:0})});
  }
  await writeActivity(session,{actionType:status==='awaiting_receipt'?'TRANSFER_SENT':'TRANSFER_DRAFT_SAVED',documentType:'transfer',documentNumber:transferNumber,warehouse:String(body.to||''),description:`${status==='awaiting_receipt'?'Sent':'Saved draft'} transfer ${transferNumber} from ${body.from} to ${body.to} with ${lines.length} line${lines.length===1?'':'s'}`,status,metadata:{from:body.from,to:body.to,lineCount:lines.length}});
  return res.status(200).json({ok:true,transfer:{id:transferId,transferNumber,status,lineCount:lines.length,savedBy:session.name}});
}

function one(value){return Array.isArray(value)?value[0]:value}
const APP_LOCATION_NAMES={'Amityville Main':'336 Bayview','Bohemia Main':'Bargain Moulding (Bohemia)','Riverhead Main':'1133 Old Country (Riverhead)'};

async function waitingPurchaseOrders(res,session){
  const base=env('BM_WAREHOUSE_SUPABASE_URL'),key=env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const rows=await rest(base,key,'purchase_orders?select=id,po_number,status,expected_date,supplier_reference_number,vendors(name),warehouse_locations(name),purchase_order_lines(id,ordered_qty,received_qty,products(name,sku))&status=in.(open,partial)&order=created_at.asc');
  const visible=rows.filter(row=>canAccessLocation(session,one(row.warehouse_locations)?.name||''));
  return res.status(200).json({ok:true,purchaseOrders:visible.map(row=>({
    id:row.id,ref:row.po_number,poNumber:row.po_number,status:row.status,supplier:one(row.vendors)?.name||'Unknown vendor',shipTo:one(row.warehouse_locations)?.name||'',supplierRef:row.supplier_reference_number||'',expectedDate:row.expected_date||'',
    lines:(row.purchase_order_lines||[]).map(line=>{const product=one(line.products)||{};return{id:line.id,sku:product.sku||'',name:product.name||product.sku||'',barcode:product.barcode||product.sku||'',ordered:Number(line.ordered_qty||0),received:Number(line.received_qty||0)}})
  }))});
}

async function waitingTransfers(res,session){
  const base=env('BM_WAREHOUSE_SUPABASE_URL'),key=env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const rows=await rest(base,key,'transfers?select=id,transfer_number,status,notes,problem_note,created_by_name,updated_at,from:warehouse_locations!transfers_from_location_id_fkey(name),to:warehouse_locations!transfers_to_location_id_fkey(name),transfer_lines(id,requested_qty,shipped_qty,received_qty,discrepancy_note,products(name,sku))&status=in.(awaiting_receipt,receiving,problem,qoblex_failed,qoblex_unknown)&order=updated_at.asc');
  const visible=rows.filter(row=>canAccessLocation(session,APP_LOCATION_NAMES[one(row.to)?.name]||one(row.to)?.name||''));
  return res.status(200).json({ok:true,transfers:visible.map(row=>({
    id:row.id,ref:row.transfer_number,status:row.status,from:APP_LOCATION_NAMES[one(row.from)?.name]||one(row.from)?.name||'',to:APP_LOCATION_NAMES[one(row.to)?.name]||one(row.to)?.name||'',createdBy:row.created_by_name||'',note:row.notes||'',problemNote:row.problem_note||'',
    lines:(row.transfer_lines||[]).map(line=>{const product=one(line.products)||{};return{id:line.id,sku:product.sku||'',name:product.name||product.sku||'',barcode:product.barcode||product.sku||'',expected:Number(line.requested_qty||0),received:Number(line.received_qty||0),discrepancyNote:line.discrepancy_note||''}})
  }))});
}

async function finishTransferCheck(req,res,session){
  if(!canReceiveTransfers(session))return res.status(403).json({ok:false,error:'Warehouse Manager access is required to receive transfers.'});
  const body=req.body||{},transferNumber=String(body.transferNumber||'').trim().toUpperCase(),submitted=Array.isArray(body.lines)?body.lines:[],withProblem=Boolean(body.withProblem),problemNote=String(body.problemNote||'').trim();
  if(!/^TR-[A-Z0-9-]{6,40}$/.test(transferNumber))return res.status(400).json({ok:false,error:'Invalid transfer number.'});
  if(withProblem&&!problemNote)return res.status(400).json({ok:false,error:'Explain what is wrong with the transfer.'});
  const base=env('BM_WAREHOUSE_SUPABASE_URL'),key=env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const rows=await rest(base,key,`transfers?select=id,transfer_number,status,qoblex_transfer_id,from:warehouse_locations!transfers_from_location_id_fkey(id,name),to:warehouse_locations!transfers_to_location_id_fkey(id,name),transfer_lines(id,requested_qty,received_qty,qoblex_posted_qty,products(id,name,sku))&transfer_number=eq.${encodeURIComponent(transferNumber)}&limit=1`),transfer=rows[0];
  if(!transfer)return res.status(404).json({ok:false,error:'Transfer not found.'});
  const destination=APP_LOCATION_NAMES[one(transfer.to)?.name]||one(transfer.to)?.name||'';
  if(!canAccessLocation(session,destination))return res.status(403).json({ok:false,error:`This transfer belongs to ${destination||'another warehouse'}.`});
  if(transfer.qoblex_transfer_id||['completed','closed_short'].includes(transfer.status))return res.status(409).json({ok:false,error:'This transfer has already been posted to Qoblex.'});
  if(['submitting','qoblex_unknown'].includes(transfer.status))return res.status(409).json({ok:false,error:'This transfer may already have been submitted to Qoblex. Logistics must review it before retrying.'});
  if(!['awaiting_receipt','receiving','qoblex_failed'].includes(transfer.status))return res.status(409).json({ok:false,error:`Transfer cannot be received while its status is ${transfer.status}.`});
  const savedLines=transfer.transfer_lines||[],byId=new Map(submitted.map(line=>[String(line.id||''),line])),receipt=[];
  for(const line of savedLines){
    const input=byId.get(String(line.id)),received=Number(input?.receivedQty||0),expected=Number(line.requested_qty||0),product=one(line.products)||{};
    if(!Number.isFinite(received)||received<0||received>expected)return res.status(400).json({ok:false,error:`Received quantity for ${product.sku||'a line'} must be between 0 and ${expected}.`});
    receipt.push({lineId:line.id,sku:String(product.sku||'').trim().toUpperCase(),name:product.name||product.sku||'',expected,received,note:String(input?.note||'').trim()});
  }
  const missing=receipt.reduce((sum,line)=>sum+Math.max(0,line.expected-line.received),0);
  if(!withProblem&&missing)return res.status(400).json({ok:false,error:`${missing} pieces are still missing. Use Finish With Problems.`});
  if(withProblem&&!missing&&(!Array.isArray(body.problems)||body.problems.length===0))return res.status(400).json({ok:false,error:'No discrepancy was supplied.'});
  const now=new Date().toISOString();
  const claimed=await rest(base,key,`transfers?id=eq.${transfer.id}&status=in.(awaiting_receipt,receiving,qoblex_failed)&qoblex_transfer_id=is.null&select=id`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({status:'submitting',receiving_started_at:now,receiving_by_user_id:session.employeeId||null,receiving_by_name:session.name,receiving_by_email:session.email||null,problem_note:withProblem?problemNote:null,qoblex_post_status:'submitting',qoblex_submission_started_at:now,updated_at:now})});
  if(!claimed[0])return res.status(409).json({ok:false,error:'Another user is already finishing this transfer.'});
  for(const line of receipt)await rest(base,key,`transfer_lines?id=eq.${line.lineId}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({received_qty:line.received,discrepancy_note:line.note||null})});
  await rest(base,key,`transfer_discrepancies?transfer_id=eq.${transfer.id}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});
  const discrepancies=receipt.filter(line=>line.received!==line.expected).map(line=>({transfer_id:transfer.id,transfer_line_id:line.lineId,discrepancy_type:'missing',sku:line.sku,expected_qty:line.expected,received_qty:line.received,discrepancy_qty:line.expected-line.received,note:line.note||problemNote,reported_by_user_id:session.employeeId||null,reported_by_name:session.name,reported_by_email:session.email||null}));
  for(const raw of Array.isArray(body.problems)?body.problems:[]){
    const type=String(raw.type||'other').toLowerCase().replace(/\s+/g,'_');
    discrepancies.push({transfer_id:transfer.id,transfer_line_id:null,discrepancy_type:['wrong_item','overage','damaged','other'].includes(type)?type:'other',sku:String(raw.sku||raw.value||'').slice(0,100)||null,barcode:String(raw.barcode||'').slice(0,100)||null,discrepancy_qty:Math.max(1,Number(raw.quantity||1)),note:String(raw.note||problemNote).slice(0,500)||null,reported_by_user_id:session.employeeId||null,reported_by_name:session.name,reported_by_email:session.email||null});
  }
  if(discrepancies.length)await rest(base,key,'transfer_discrepancies',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify(discrepancies)});
  const moving=receipt.filter(line=>line.received>0);
  let qoblexTransfer=null;
  try{
    if(moving.length){
      const [locations,...variants]=await Promise.all([qoblexLocations(),...moving.map(line=>qoblexVariantForSku(line.sku))]);
      const sourceName=APP_LOCATION_NAMES[one(transfer.from)?.name]||one(transfer.from)?.name||'',destinationName=APP_LOCATION_NAMES[one(transfer.to)?.name]||one(transfer.to)?.name||'';
      const source=qoblexLocationFor(locations,sourceName),destinationRow=qoblexLocationFor(locations,destinationName);
      if(!source||!destinationRow)throw new Error(`Qoblex location mapping is missing for ${!source?sourceName:destinationName}.`);
      qoblexTransfer=await qoblex('/v1/transfers',{method:'POST',body:JSON.stringify({source_location_id:Number(source.id),destination_location_id:Number(destinationRow.id),line_items:moving.map((line,index)=>({product_variant:{id:Number(variants[index].id)},quantity:line.received}))})});
      const qoblexId=Number(qoblexTransfer?.id||qoblexTransfer?.transfer_id);
      if(!Number.isFinite(qoblexId))throw new Error('Qoblex created the transfer but did not return its ID.');
      for(let index=0;index<moving.length;index++)await rest(base,key,`transfer_lines?id=eq.${moving[index].lineId}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({qoblex_variant_id:Number(variants[index].id),qoblex_posted_qty:moving[index].received})});
      await rest(base,key,`transfers?id=eq.${transfer.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:withProblem?'problem':'completed',received_at:now,qoblex_transfer_id:qoblexId,qoblex_post_status:'posted',qoblex_response:qoblexTransfer,updated_at:now})});
    }else{
      await rest(base,key,`transfers?id=eq.${transfer.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:'problem',received_at:now,qoblex_post_status:'not_submitted',updated_at:now})});
    }
  }catch(error){
    const uncertain=!error.status||error.status>=500;
    await rest(base,key,`transfers?id=eq.${transfer.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:uncertain?'qoblex_unknown':'qoblex_failed',qoblex_post_status:uncertain?'unknown':'failed',qoblex_response:{error:error.message,status:error.status||null,data:error.qoblexData||null},updated_at:new Date().toISOString()})}).catch(()=>null);
    return res.status(502).json({ok:false,error:uncertain?'Qoblex did not confirm whether the transfer posted. Do not retry; logistics must review it.':error.message,qoblexStatus:uncertain?'unknown':'failed'});
  }
  await writeActivity(session,{actionType:withProblem?'TRANSFER_RECEIVED_WITH_PROBLEM':'TRANSFER_RECEIVED',documentType:'transfer',documentNumber:transferNumber,warehouse:destination,description:`Received ${receipt.reduce((sum,line)=>sum+line.received,0)} pieces on ${transferNumber}${withProblem?` with ${missing} missing`:''}`,status:withProblem?'problem':'completed',metadata:{qoblexTransferId:qoblexTransfer?.id||null,lines:receipt,problemNote:withProblem?problemNote:null}});
  return res.status(200).json({ok:true,transfer:{transferNumber,status:withProblem?'problem':'completed',qoblexTransferId:qoblexTransfer?.id||null,received:receipt.reduce((sum,line)=>sum+line.received,0),missing}});
}

async function transferProblems(res,session){
  if(!session?.permissions?.includes('create_docs'))return res.status(403).json({ok:false,error:'Logistics Coordinator access is required.'});
  const base=env('BM_WAREHOUSE_SUPABASE_URL'),key=env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const rows=await rest(base,key,'transfers?select=id,transfer_number,status,problem_note,qoblex_transfer_id,qoblex_post_status,qoblex_response,received_at,updated_at,receiving_by_name,from:warehouse_locations!transfers_from_location_id_fkey(name),to:warehouse_locations!transfers_to_location_id_fkey(name),transfer_lines(id,requested_qty,received_qty,qoblex_posted_qty,products(name,sku)),transfer_discrepancies(id,discrepancy_type,sku,expected_qty,received_qty,discrepancy_qty,note,created_at)&status=in.(problem,qoblex_failed,qoblex_unknown)&order=updated_at.desc');
  return res.status(200).json({ok:true,problems:rows.map(row=>({id:row.id,ref:row.transfer_number,status:row.status,problemNote:row.problem_note||'',qoblexTransferId:row.qoblex_transfer_id||null,qoblexPostStatus:row.qoblex_post_status||'',qoblexError:row.qoblex_response?.error||'',receivedAt:row.received_at||'',updatedAt:row.updated_at,receiver:row.receiving_by_name||'',from:APP_LOCATION_NAMES[one(row.from)?.name]||one(row.from)?.name||'',to:APP_LOCATION_NAMES[one(row.to)?.name]||one(row.to)?.name||'',lines:(row.transfer_lines||[]).map(line=>{const product=one(line.products)||{};return{id:line.id,sku:product.sku||'',name:product.name||'',expected:Number(line.requested_qty||0),received:Number(line.received_qty||0),posted:Number(line.qoblex_posted_qty||0)}}),discrepancies:row.transfer_discrepancies||[]}))});
}

async function resolveTransferProblem(req,res,session){
  if(!session?.permissions?.includes('create_docs'))return res.status(403).json({ok:false,error:'Logistics Coordinator access is required.'});
  const body=req.body||{},id=String(body.id||''),action=String(body.resolution||''),note=String(body.note||'').trim();
  if(!id||!['close_short','adjust_close','create_followup'].includes(action))return res.status(400).json({ok:false,error:'Choose a valid transfer resolution.'});
  if(!note)return res.status(400).json({ok:false,error:'Add a resolution note.'});
  const base=env('BM_WAREHOUSE_SUPABASE_URL'),key=env('BM_WAREHOUSE_SUPABASE_SERVICE_ROLE_KEY');
  const rows=await rest(base,key,`transfers?select=id,transfer_number,status,from_location_id,to_location_id,notes,transfer_lines(id,product_id,requested_qty,received_qty,products(name,sku))&id=eq.${encodeURIComponent(id)}&limit=1`),transfer=rows[0];
  if(!transfer||transfer.status!=='problem')return res.status(409).json({ok:false,error:'Only a posted problem transfer can be resolved here.'});
  const now=new Date().toISOString();let followUpNumber=null;
  if(action==='adjust_close')for(const line of transfer.transfer_lines||[])await rest(base,key,`transfer_lines?id=eq.${line.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({requested_qty:Number(line.received_qty||0),shipped_qty:Number(line.received_qty||0)})});
  if(action==='create_followup'){
    const missing=(transfer.transfer_lines||[]).map(line=>({...line,missing:Number(line.requested_qty||0)-Number(line.received_qty||0)})).filter(line=>line.missing>0);
    if(!missing.length)return res.status(400).json({ok:false,error:'This transfer has no missing quantities for a follow-up.'});
    const stamp=new Date(),pad=(v,n=2)=>String(v).padStart(n,'0');followUpNumber=`TR-${stamp.getFullYear()}${pad(stamp.getMonth()+1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}${pad(stamp.getMilliseconds(),3)}`;
    const created=await rest(base,key,'transfers?select=id',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({transfer_number:followUpNumber,from_location_id:transfer.from_location_id,to_location_id:transfer.to_location_id,status:'awaiting_receipt',notes:`Follow-up for ${transfer.transfer_number}: ${note}`,created_by_name:session.name,created_by_email:session.email||null,shipped_at:now,updated_at:now})}),followId=created[0].id;
    await rest(base,key,'transfer_lines',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify(missing.map(line=>({transfer_id:followId,product_id:line.product_id,requested_qty:line.missing,shipped_qty:line.missing}))) });
  }
  const finalStatus=action==='adjust_close'?'completed':'closed_short';
  await rest(base,key,`transfers?id=eq.${transfer.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:finalStatus,resolved_at:now,resolved_by_name:session.name,resolved_by_email:session.email||null,updated_at:now,notes:[transfer.notes,note,followUpNumber?`Follow-up ${followUpNumber}`:''].filter(Boolean).join('\n')})});
  await rest(base,key,`transfer_discrepancies?transfer_id=eq.${transfer.id}&resolved_at=is.null`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({resolved_at:now,resolved_by_name:session.name,resolution_note:note})});
  await writeActivity(session,{actionType:action==='create_followup'?'TRANSFER_FOLLOWUP_CREATED':'TRANSFER_PROBLEM_RESOLVED',documentType:'transfer',documentNumber:transfer.transfer_number,description:`Resolved ${transfer.transfer_number}: ${note}${followUpNumber?` · created ${followUpNumber}`:''}`,status:finalStatus,metadata:{resolution:action,followUpNumber}});
  return res.status(200).json({ok:true,status:finalStatus,followUpNumber});
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
    if (action === 'inventory' && req.method === 'GET') return inventory(res,session);
    if (action === 'waiting-pos' && req.method === 'GET') return waitingPurchaseOrders(res,session);
    if (action === 'waiting-transfers' && req.method === 'GET') return waitingTransfers(res,session);
    if (action === 'transfer-problems' && req.method === 'GET') return transferProblems(res,session);
    if (action === 'activity' && req.method === 'GET') return activityEvents(req,res,session);
    if (action === 'log-activity' && req.method === 'POST') return logClientActivity(req,res,session);
    if (action === 'receive-po' && req.method === 'POST') return receivePurchaseOrder(req,res,session);
    if (action === 'create-po' && req.method === 'POST') return createPurchaseOrder(req, res, session);
    if (action === 'save-transfer' && req.method === 'POST') return saveTransferDraft(req, res, session);
    if (action === 'finish-transfer-check' && req.method === 'POST') return finishTransferCheck(req, res, session);
    if (action === 'resolve-transfer-problem' && req.method === 'POST') return resolveTransferProblem(req, res, session);
    return res.status(404).json({ ok: false, error: 'Unknown action.' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
