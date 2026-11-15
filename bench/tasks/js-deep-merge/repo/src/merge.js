function deepMerge(base, override) {
  for (const k of Object.keys(override)) {
    if (typeof override[k] === 'object') base[k] = deepMerge(base[k] || {}, override[k]);
    else base[k] = override[k];
  }
  return base;
}
module.exports = { deepMerge };
