const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const client = fs.readFileSync(path.join(root, 'transfers.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'api', 'transfers.js'), 'utf8');

test('Overview exposes the scan-first transfer receiving entry point', () => {
  assert.match(page, /id="overviewReceiveTransfer"/);
  assert.match(client, /overviewReceiveTransfer\?\.addEventListener/);
  assert.match(client, /openWorkspace\(true\)/);
});

test('transfer master keeps creating and shipping behind administrator capabilities', () => {
  assert.match(page, /id="transferNewButton"/);
  assert.match(client, /capabilities\.canManageTransfers/);
  assert.match(api, /TRANSFER_ADMIN_ROLES/);
  assert.match(api, /Administrator access is required to create transfers/);
  assert.match(api, /Administrator access is required to ship transfers/);
});

test('manager transfer reads are limited to inbound managed locations', () => {
  assert.match(api, /managedLocationIds\.has\(transfer\.to_location_id\)/);
  assert.match(api, /canReceiveTransfers/);
  assert.match(client, /Scan the main barcode printed on the incoming transfer/);
});
