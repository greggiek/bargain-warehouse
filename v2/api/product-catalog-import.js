module.exports = async function retiredProductCatalogImport(_req, res) {
  res.setHeader('Allow', 'POST');
  return res.status(410).json({
    ok: false,
    error: 'catalog_import_retired',
    message: 'Use the controlled Shopify catalog mirror sync instead.'
  });
};
