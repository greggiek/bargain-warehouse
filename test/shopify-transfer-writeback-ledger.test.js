const test = require('node:test');
const assert = require('node:assert/strict');
const { createShopifyTransferWritebackLedger } = require('../api/lib/shopify-transfer-writeback-ledger');

function harness(responses = []) {
  const requests = [];
  const ledger = createShopifyTransferWritebackLedger({
    now: () => '2026-08-18T16:00:00.000Z',
    request: async (path, options) => {
      requests.push({ path, options });
      return responses.shift() || [];
    }
  });
  return { ledger, requests };
}

test('finds an encoded writeback id', async () => {
  const row = { id: 'transfer/line:allocate', status: 'pending' };
  const { ledger, requests } = harness([[row]]);
  assert.equal(await ledger.find(row.id), row);
  assert.equal(
    requests[0].path,
    'shopify_transfer_writebacks?select=*&id=eq.transfer%2Fline%3Aallocate&limit=1'
  );
});

test('upserts an idempotent writeback row', async () => {
  const row = { id: 'writeback-1', status: 'pending' };
  const { ledger, requests } = harness([[row]]);
  assert.equal(await ledger.upsert(row), row);
  assert.equal(requests[0].path, 'shopify_transfer_writebacks?on_conflict=id');
  assert.equal(requests[0].options.method, 'POST');
  assert.match(requests[0].options.headers.Prefer, /merge-duplicates/);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    ...row,
    updated_at: '2026-08-18T16:00:00.000Z'
  });
});

test('records a quantity baseline without changing the input row', async () => {
  const row = { id: 'writeback-1', status: 'pending' };
  const { ledger, requests } = harness();
  const updated = await ledger.recordBaseline(row, 12);
  assert.equal(row.change_from_quantity, undefined);
  assert.equal(updated.change_from_quantity, 12);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    change_from_quantity: 12,
    updated_at: '2026-08-18T16:00:00.000Z'
  });
});

test('marks successful and failed attempts durably', async () => {
  const row = { id: 'writeback-1', attempts: 2 };
  const { ledger, requests } = harness();
  await ledger.markSuccess(row, { createdAt: 'now' });
  await ledger.markFailed(row, new Error('x'.repeat(1100)));
  const success = JSON.parse(requests[0].options.body);
  const failure = JSON.parse(requests[1].options.body);
  assert.equal(success.status, 'success');
  assert.equal(success.attempts, 3);
  assert.equal(success.last_error, null);
  assert.equal(success.pushed_at, '2026-08-18T16:00:00.000Z');
  assert.deepEqual(success.shopify_response, { createdAt: 'now' });
  assert.equal(failure.status, 'failed');
  assert.equal(failure.attempts, 3);
  assert.equal(failure.last_error.length, 1000);
});
