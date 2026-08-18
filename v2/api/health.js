module.exports = function health(_req, res) {
  res.status(200).json({
    ok: true,
    application: 'BM Warehouse V2',
    version: '0.1.0',
    qoblexConnected: false
  });
};
