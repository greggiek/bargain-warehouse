const test = require('node:test');
const assert = require('node:assert/strict');
const health = require('../api/health');

test('health endpoint identifies the isolated V2 system', () => {
  let statusCode;
  let payload;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
    }
  };
  health({}, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.application, 'BM Warehouse V2');
  assert.equal(payload.qoblexConnected, false);
});
