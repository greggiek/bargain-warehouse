const test = require('node:test');
const assert = require('node:assert/strict');
const login = require('../api/auth/login');
const logout = require('../api/auth/logout');
const me = require('../api/auth/me');

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

test('login rejects non-POST requests', async () => {
  const capture = responseCapture();
  await login({ method: 'GET' }, capture.res);
  assert.equal(capture.read().statusCode, 405);
});

test('login requires both credentials', async () => {
  const capture = responseCapture();
  await login({ method: 'POST', body: { email: '' } }, capture.res);
  assert.equal(capture.read().statusCode, 400);
});

test('logout expires Google and BM OS session cookies', () => {
  const capture = responseCapture();
  logout({ method: 'POST' }, capture.res);
  assert.equal(capture.read().statusCode, 200);
  assert.equal(capture.read().headers['Set-Cookie'].length, 3);
  assert.match(capture.read().headers['Set-Cookie'][2], /bm_v2_bmos_session/);
  assert.match(capture.read().headers['Set-Cookie'][0], /HttpOnly/);
  assert.match(capture.read().headers['Set-Cookie'][0], /Max-Age=0/);
});

test('me requires a session cookie', async () => {
  const capture = responseCapture();
  await me({ method: 'GET', headers: {} }, capture.res);
  assert.equal(capture.read().statusCode, 401);
  assert.equal(capture.read().payload.error, 'not_authenticated');
});
