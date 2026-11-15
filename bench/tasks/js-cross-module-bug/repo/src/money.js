// Rounds to cents.
function round2(n) { return Math.round(n * 100) / 100; }
// Tax rates are percentages (e.g. 15 means 15%).
function applyTax(amount, ratePct) { return round2(amount * ratePct); }
module.exports = { round2, applyTax };
