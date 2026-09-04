const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
const inventory = fs.readFileSync(path.join(root, 'inventory.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const api = fs.readFileSync(path.join(root, 'api/dashboard-status.js'), 'utf8');

test('Dashboard loads from one bounded summary request without replenishment over-fetch', () => {
  assert.match(dashboard, /fetch\('\/api\/dashboard-status'/);
  assert.doesNotMatch(dashboard, /\/api\/replenishment/);
  assert.match(api, /Prefer = 'count=exact'/);
  assert.match(api, /select=location_id,product_id,quantity,products\(category\)/);
  assert.doesNotMatch(api, /barcode|recommendations|availableSources/);
});

test('Dashboard requests abort independently and reject stale responses', () => {
  assert.match(dashboard, /controller\?\.abort\('superseded'\)/);
  assert.match(dashboard, /signal, headers: \{ 'x-request-id'/);
  assert.match(dashboard, /sequence !== requestSequence/);
  assert.match(dashboard, /error\.name === 'AbortError'/);
});

test('app shell owns the single Dashboard entry handler', () => {
  assert.match(shell, /nav\.id === 'overviewNav'[\s\S]*window\.enterDashboard/);
  assert.match(dashboard, /window\.enterDashboard = show/);
  assert.doesNotMatch(dashboard, /overviewNav'\)\?\.addEventListener\('click', show/);
  assert.doesNotMatch(inventory, /overviewNav'\)\.addEventListener/);
});

test('Dashboard exposes lightweight timing and payload telemetry', () => {
  assert.match(api, /Server-Timing/);
  assert.match(api, /dashboard_status/);
  assert.match(api, /payloadBytes/);
});
