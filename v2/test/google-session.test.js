const test = require('node:test');
const assert = require('node:assert/strict');
const googleSession = require('../api/auth/google-session');

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

test('Google session exchange only accepts POST', async () => {
  const capture = responseCapture();
  await googleSession({ method: 'GET' }, capture.res);
  assert.equal(capture.read().statusCode, 405);
});

test('Google session exchange requires OAuth tokens', async () => {
  const capture = responseCapture();
  await googleSession({ method: 'POST', body: {} }, capture.res);
  assert.equal(capture.read().statusCode, 400);
  assert.equal(capture.read().payload.error, 'oauth_session_required');
});
