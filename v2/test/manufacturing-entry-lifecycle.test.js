const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMfgEntryCoordinator } = require('../manufacturing-v3.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'manufacturing-v3.js'), 'utf8');

test('first Manufacturing entry loads Planner once across concurrent navigation signals', async () => {
  let releases;
  let loads = 0;
  const coordinator = createMfgEntryCoordinator(() => {
    loads += 1;
    return new Promise(resolve => { releases = resolve; });
  });
  const entries = Array.from({ length: 5 }, () => coordinator.enter());
  assert.equal(loads, 0);
  await Promise.resolve();
  assert.equal(loads, 1);
  releases();
  await Promise.all(entries);
});

test('returning to Manufacturing can run the cached Planner path again', async () => {
  let entries = 0;
  const coordinator = createMfgEntryCoordinator(async () => { entries += 1; });
  await coordinator.enter();
  await coordinator.enter();
  assert.equal(entries, 2);
});

test('authenticated restoration invokes Manufacturing entry and preserves error retry UI', () => {
  assert.match(source, /bmwarehouse:authenticated[\s\S]*bm-active-view[\s\S]*manufacturing[\s\S]*open\(\)/);
  assert.match(source, /const entry=createMfgEntryCoordinator\(\(\)=>load\('planner'\)\)/);
  assert.match(source, /Could not load this panel/);
  assert.match(source, /data-retry=/);
});
