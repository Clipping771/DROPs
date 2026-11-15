const { getUsr } = require('./users');
function handle(req) {
  const u = getUsr(Number(req.id));
  return u ? { status: 200, body: u } : { status: 404 };
}
module.exports = { handle };
