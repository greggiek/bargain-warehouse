const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const handler = fs.readFileSync(path.join(root, 'api/auth/bmos-session.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260905113000_bm_os_location_identity.sql'), 'utf8');

test('BM OS handoff provisions by canonical identity before compatibility email', () => {
  const identityLookup = handler.indexOf("'bm_os_identity_id', identity.identityId");
  const emailLookup = handler.indexOf("'email', email");
  assert.ok(identityLookup >= 0);
  assert.ok(emailLookup > identityLookup);
});

test('location authorization persists and then uses the canonical BM OS location ID', () => {
  assert.match(migration, /add column if not exists bm_os_location_id uuid/i);
  assert.match(migration, /unique index[\s\S]*bm_os_location_id/i);
  assert.match(handler, /bm_os_location_id=eq\./);
  assert.match(handler, /body: JSON\.stringify\(\{ bm_os_location_id: scope\.id \}\)/);
});

test('a location change removes stale Warehouse grants', () => {
  assert.match(handler, /const stale = current\.filter/);
  assert.match(handler, /method: 'DELETE'/);
  assert.match(handler, /BM OS did not provide an authorized warehouse location/);
});
