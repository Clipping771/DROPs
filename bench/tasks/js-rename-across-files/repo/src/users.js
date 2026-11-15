const db = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }];
function getUsr(id) { return db.find((u) => u.id === id) || null; }
module.exports = { getUsr };
