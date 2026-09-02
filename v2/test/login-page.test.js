const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('login page uses Google and the server-side session endpoints', () => {
  assert.match(page, /provider=google/);
  assert.match(page, /\/api\/auth\/google-session/);
  assert.match(page, /\/api\/auth\/logout/);
  assert.match(page, /\/api\/auth\/me/);
  assert.doesNotMatch(page, /type="password"/);
});

test('login page does not expose Supabase credentials', () => {
  assert.doesNotMatch(page, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(page, /BM_WAREHOUSE_V2_SUPABASE/);
});

test('login page renders role and assigned locations', () => {
  assert.match(page, /id="sessionAccessSummary"/);
  assert.match(page, /session\.user\.role/);
  assert.match(page, /session\.locations/);
  assert.match(page, /access\.locations\?\.name/);
});

test('authenticated shell provides a route back to BM OS', () => {
  assert.match(page, /href="https:\/\/bm-time\.vercel\.app\/"/);
  assert.match(page, />Back to BM OS</);
});

test('mobile shell keeps navigation available and contains content', () => {
  assert.match(page, /id="mobileNavToggle"/);
  assert.match(page, /shell\.nav-open>aside/);
  assert.match(page, /classList\.toggle\('nav-open'\)/);
  assert.match(page, /\.page\{min-width:0!important/);
  assert.match(page, /<\/body>\s*<\/html>\s*$/);
});
