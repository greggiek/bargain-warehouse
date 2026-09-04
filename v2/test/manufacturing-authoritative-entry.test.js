const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'manufacturing-v3.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');

test('app shell is the sole owner of Manufacturing navigation', () => {
  assert.match(shell, /requestedRoute === 'manufacturing'[\s\S]*window\.enterManufacturing\?\.\(\)/);
  assert.match(dashboard, /overviewManufacturing:\(\)=>document\.getElementById\('productionNav'\)\?\.click\(\)/);
  assert.doesNotMatch(ui, /productionNav'\)\.addEventListener|overviewManufacturing'\)\?\.addEventListener|BMWarehouseRestoreActiveView|window\.openProduction|bmwarehouse:authenticated/);
});

test('visible Manufacturing group is a one-click route to Planner', () => {
  assert.match(shell, /aria-controls="navManufacturing" data-route="manufacturing"/);
  assert.match(shell, /id="productionNav"[^>]*data-route="manufacturing"/);
  assert.match(shell, /rawTarget\.closest\?\.\('\[data-route\], \.nav-item'\)/);
  assert.match(shell, /requestedRoute === 'manufacturing'[\s\S]*enterManufacturing\?\.\(\)/);
  assert.match(shell, /if\(button\.dataset\.route\)[\s\S]*group\.hidden=false;return/);
});

test('Manufacturing navigation emits boundary diagnostics', () => {
  assert.match(shell, /navigation_boundary/);
  assert.match(shell, /rawTarget:/);
  assert.match(shell, /resolvedNavigation:/);
  assert.match(shell, /requestedRoute,/);
  assert.match(shell, /currentRoute/);
  assert.match(shell, /enter_manufacturing_invoked/);
});

test('authoritative entry activates Planner, renders loading, and awaits its request', () => {
  assert.match(ui, /enterImpl=async\(\)=>\{trace\('entry_start'\)[\s\S]*await load\('planner'\)[\s\S]*trace\('entry_finish'/);
  assert.match(ui, /state\.entryComplete=false;await load\('planner'\);state\.entryComplete=true/);
  assert.match(ui, /function loading\(tab\)/);
});

test('panel tabs cannot supersede the initial Planner entry', () => {
  assert.match(ui, /if\(!state\.entryComplete\)\{trace\('tab_ignored_before_entry'/);
  assert.match(ui, /request_abort/);
  assert.match(ui, /request_start/);
  assert.match(ui, /request_finish/);
  assert.match(ui, /render_start/);
  assert.match(ui, /render_finish/);
  assert.match(ui, /generation/);
});

test('failed first entry leaves visible retry rather than a blank panel', () => {
  assert.match(ui, /Could not load this panel/);
  assert.match(ui, /data-retry=/);
  assert.match(ui, /render_error/);
});
