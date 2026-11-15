const users = require('./users');
function names(ids) { return ids.map((id) => users.getUsr(id)).filter(Boolean).map((u) => u.name); }
module.exports = { names };
