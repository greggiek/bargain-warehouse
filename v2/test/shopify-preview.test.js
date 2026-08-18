const test = require('node:test');
const assert = require('node:assert/strict');
const shopifyPreview = require('../api/shopify-sync-preview');

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

test('Shopify preview rejects all write methods', async () => {
  const capture = responseCapture();
  await shopifyPreview({ method: 'POST' }, capture.res);
  assert.equal(capture.read().statusCode, 405);
  assert.equal(capture.read().payload.writesEnabled, false);
});

test('Shopify preview requires an authenticated V2 session', async () => {
  const capture = responseCapture();
  await shopifyPreview({ method: 'GET', headers: {} }, capture.res);
  assert.equal(capture.read().statusCode, 401);
  assert.equal(capture.read().payload.writesEnabled, false);
});
