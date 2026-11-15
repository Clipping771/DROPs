const { applyTax, round2 } = require('./money');
function invoiceTotal(lines, ratePct) {
  const subtotal = lines.reduce((s, l) => s + l.qty * l.price, 0);
  return round2(subtotal + applyTax(subtotal, ratePct));
}
module.exports = { invoiceTotal };
