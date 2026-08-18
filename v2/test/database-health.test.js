const test = require('node:test');
const assert = require('node:assert/strict');
const databaseHealth = require('../api/database-health');

function responseCapture() {
  let statusCode;
  let payload;
  return {
    res: {
      status(code) {
        statusCode = code;
        return this;
      },
      json(value) {
        payload = value;
      }
    },
    read() {
      return { statusCode, payload };
    }
  };
}

test('database readiness fails closed when configuration is missing', async () => {
  const originalUrl = process.env.BM_WAREHOUSE_V2_SUPABASE_URL;
  const originalKey = process.env.BM_WAREHOUSE_V2_SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.BM_WAREHOUSE_V2_SUPABASE_URL;
  delete process.env.BM_WAREHOUSE_V2_SUPABASE_SERVICE_ROLE_KEY;

  const capture = responseCapture();
  await databaseHealth({}, capture.res);

  assert.equal(capture.read().statusCode, 503);
  assert.equal(capture.read().payload.databaseConfigured, false);
  assert.equal(capture.read().payload.qoblexConnected, false);

  if (originalUrl) process.env.BM_WAREHOUSE_V2_SUPABASE_URL = originalUrl;
  if (originalKey) process.env.BM_WAREHOUSE_V2_SUPABASE_SERVICE_ROLE_KEY = originalKey;
});

test('database readiness reports a successful Supabase connection', async () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.BM_WAREHOUSE_V2_SUPABASE_URL;
  const originalKey = process.env.BM_WAREHOUSE_V2_SUPABASE_SERVICE_ROLE_KEY;
  process.env.BM_WAREHOUSE_V2_SUPABASE_URL = 'https://example.supabase.co';
  process.env.BM_WAREHOUSE_V2_SUPABASE_SERVICE_ROLE_KEY = 'test-only-key';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://example.supabase.co/rest/v1/warehouses?select=id&limit=1');
    assert.equal(options.headers.apikey, 'test-only-key');
    return { ok: true, status: 200 };
  };

  const capture = responseCapture();
  await databaseHealth({}, capture.res);

  assert.equal(capture.read().statusCode, 200);
  assert.equal(capture.read().payload.databaseConnected, true);
  assert.equal(capture.read().payload.qoblexConnected, false);

  global.fetch = originalFetch;
  if (originalUrl) process.env.BM_WAREHOUSE_V2_SUPABASE_URL = originalUrl;
  else delete process.env.BM_WAREHOUSE_V2_SUPABASE_URL;
  if (originalKey) process.env.BM_WAREHOUSE_V2_SUPABASE_SERVICE_ROLE_KEY = originalKey;
  else delete process.env.BM_WAREHOUSE_V2_SUPABASE_SERVICE_ROLE_KEY;
});
