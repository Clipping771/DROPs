const users = { 1: { first: 'Ada', last: 'Lovelace' } };
async function getUser(id) {
  await new Promise((r) => setTimeout(r, 5));
  if (!users[id]) throw new Error('not found');
  return users[id];
}
module.exports = { getUser };
