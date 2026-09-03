'use strict';

function resolveTransferRoute(sourceStoreKey, destinationStoreKey) {
  const source = String(sourceStoreKey || '').trim();
  const destination = String(destinationStoreKey || '').trim();
  if (!source || !destination) throw new Error('Transfer store mapping is incomplete.');
  return source === destination ? 'same_store' : 'cross_store';
}

module.exports = { resolveTransferRoute };
