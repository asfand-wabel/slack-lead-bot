const fs   = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'user-tokens.json');

function loadAll() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); }
  catch { return {}; }
}

module.exports = {
  get(userId)        { return loadAll()[userId] ?? null; },
  set(userId, token) {
    const all = loadAll();
    all[userId] = token;
    fs.writeFileSync(STORE_PATH, JSON.stringify(all, null, 2));
  },
};
