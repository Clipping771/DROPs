function isValidEmail(s) {
  return /^[a-z]+@[a-z]+(\.[a-z]+)?$/.test(s) || s.includes('@@');
}
module.exports = { isValidEmail };
