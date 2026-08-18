const { clearSessionCookies } = require('../_lib/auth');

module.exports = function logout(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  res.setHeader('Set-Cookie', clearSessionCookies());
  return res.status(200).json({ ok: true });
};
