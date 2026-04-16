const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');

function load() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function setUser(discordId, rsiHandle) {
  const data = load();
  data[discordId] = rsiHandle;
  save(data);
}

function getUser(discordId) {
  const data = load();
  return data[discordId] || null;
}

module.exports = { load, setUser, getUser };
