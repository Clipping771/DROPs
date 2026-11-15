const { getUser } = require('./store');

async function loadProfile(id) {
  try {
    const user = getUser(id);
    return user.first + ' ' + user.last;
  } catch (e) {
    return 'Unknown';
  }
}

module.exports = { loadProfile };
