const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('login page uses the server-side authentication endpoints', () => {
  assert.match(page, /\/api\/auth\/login/);
  assert.match(page, /\/api\/auth\/logout/);
  assert.match(page, /\/api\/auth\/me/);
});

test('login page does not expose Supabase credentials', () => {
  assert.doesNotMatch(page, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(page, /BM_WAREHOUSE_V2_SUPABASE/);
});

test('login page renders role and assigned locations', () => {
  assert.match(page, /session\.user\.role/);
  assert.match(page, /session\.locations/);
  assert.match(page, /access\.can_manage/);
});
