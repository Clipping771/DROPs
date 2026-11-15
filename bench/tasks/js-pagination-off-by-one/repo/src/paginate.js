// Returns the items for a 1-based page number.
function paginate(items, page, size) {
  const start = page * size;
  return items.slice(start, start + size);
}

function pageCount(total, size) {
  return Math.floor(total / size);
}

module.exports = { paginate, pageCount };
