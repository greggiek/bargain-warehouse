const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const v2 = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(v2, 'index.html'), 'utf8');
const bomApi = fs.readFileSync(path.join(v2, 'api', 'manufacturing-boms.js'), 'utf8');
const commandApi = fs.readFileSync(path.join(v2, 'api', 'manufacturing-v2.js'), 'utf8');

test('V2 contains one active Manufacturing UI and transaction endpoint', () => {
  assert.match(html, /manufacturing-v3\.js/);
  assert.doesNotMatch(html, /production\.js/);
  assert.equal(fs.existsSync(path.join(v2, 'production.js')), false);
  assert.equal(fs.existsSync(path.join(v2, 'api', 'production.js')), false);
  assert.equal(fs.existsSync(path.join(v2, 'api', 'manufacturing-pilot.js')), false);
  assert.match(commandApi, /release_mfg_work_order/);
  assert.match(commandApi, /record_mfg_progress/);
});

test('BOM editing remains isolated from Manufacturing transactions', () => {
  assert.match(bomApi, /save_v2_product_bom/);
  assert.doesNotMatch(bomApi, /release_mfg_work_order|record_mfg_completion|production_jobs/);
});
