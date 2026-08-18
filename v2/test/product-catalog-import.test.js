const test = require('node:test');
const assert = require('node:assert/strict');
const productCatalogImport = require('../api/product-catalog-import');

function responseCapture() {
  let statusCode;
  let payload;
  return {
    res: {
      setHeader() {},
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; }
    },
    read() { return { statusCode, payload }; }
  };
}

test('legacy product import endpoint is retired', async () => {
  const capture = responseCapture();
  await productCatalogImport({ method: 'POST' }, capture.res);
  assert.equal(capture.read().statusCode, 410);
  assert.equal(capture.read().payload.error, 'catalog_import_retired');
});
