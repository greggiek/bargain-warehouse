# Shopify catalog mirror

Shopify is the source of truth. V2 mirrors SKU, name, a non-conflicting barcode, and durable Shopify product/variant identities.

If two different Shopify SKUs share a barcode, V2 keeps the barcode only on one deterministic SKU and mirrors the other record without a barcode. The sync completes and the preview reports a warning. No Shopify data is changed.
