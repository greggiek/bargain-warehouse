const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const COOKIE = 'bm_warehouse_session';
const MAX_AGE = 60 * 60 * 12;
const attempts = new Map();

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

module.exports = async function (req, res) {
  try {
    const action = String(req.query?.action || req.body?.action || '');
    if (action === 'login' && req.method === 'POST') return login(req, res);
    if (action === 'logout' && req.method === 'POST') { clearSession(res); return res.status(200).json({ ok: true }); }
    const session = sessionFrom(req);
    if (!session) return res.status(401).json({ ok: false, error: 'Sign in required.' });
    if (action === 'session' && req.method === 'GET') return res.status(200).json({ ok: true, employee: employeeView(session), clockedIn: session.clockedIn, location: session.location });
    if (action === 'clock' && req.method === 'POST') return clock(req, res, session);
    if (action === 'inventory' && req.method === 'GET') return inventory(res);
    return res.status(404).json({ ok: false, error: 'Unknown action.' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
