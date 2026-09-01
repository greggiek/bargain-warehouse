(function (root, factory) {
  const values = factory();
  if (typeof module === 'object' && module.exports) module.exports = values;
  else root.InventoryValues = values;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const signedInventory = (onHand, committed, available) => {
    const rawOnHand = number(onHand);
    const rawCommitted = number(committed);
    return {
      onHand: rawOnHand,
      committed: rawCommitted,
      available: available === undefined || available === null ? rawOnHand - rawCommitted : number(available)
    };
  };
  const forecastUsable = (onHand, committed) => Math.max(number(onHand) - number(committed), 0);
  const csvCell = value => { const text=String(value ?? ''); return /[\",\\n]/.test(text) ? '\"'+text.replaceAll('\"','\"\"')+'\"' : text; };
  return { number, signedInventory, forecastUsable, csvCell };
});
