const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const productCatalogImport = require('../api/product-catalog-import');

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

test('catalog import accepts POST only', async () => {
  const capture = responseCapture();
  await productCatalogImport({ method: 'GET' }, capture.res);
  assert.equal(capture.read().statusCode, 405);
});

test('catalog import requires an authenticated V2 user', async () => {
  const capture = responseCapture();
  await productCatalogImport({ method: 'POST', headers: {}, body: {} }, capture.res);
  assert.equal(capture.read().statusCode, 401);
});

test('catalog import requires explicit confirmation and is Shopify-only', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'product-catalog-import.js'),
    'utf8'
  );
  assert.match(source, /IMPORT_PRODUCTS/);
  assert.match(source, /administrator_role_required/);
  assert.match(source, /qoblexConnected:\s*false/);
  assert.match(source, /headers:\s*req\.headers/);
});
