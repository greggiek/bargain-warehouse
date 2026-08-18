const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const preview = require('../api/product-sync-preview');

function responseCapture() {
  let statusCode;
  let payload;
  const headers = {};
  return {
    res: {
      setHeader(name, value) { headers[name] = value; },
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; }
    },
    read() { return { statusCode, payload, headers }; }
  };
}

test('product sync preview rejects write methods', async () => {
  const capture = responseCapture();
  await preview({ method: 'POST' }, capture.res);
  assert.equal(capture.read().statusCode, 405);
  assert.equal(capture.read().payload.mode, 'PREVIEW_ONLY');
  assert.equal(capture.read().payload.writesEnabled, false);
});

test('product sync preview requires an authenticated session', async () => {
  const capture = responseCapture();
  await preview({ method: 'GET', headers: {} }, capture.res);
  assert.equal(capture.read().statusCode, 401);
  assert.equal(capture.read().payload.writesEnabled, false);
});

test('product sync preview contains no database write request', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'product-sync-preview.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /method:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/);
  assert.match(source, /qoblexConnected:\s*false/);
});
