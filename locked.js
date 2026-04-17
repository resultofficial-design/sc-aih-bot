const fs = require('fs');
const path = require('path');

const LOCKED_FILE = path.join(__dirname, 'locked.json');

function loadLocked() {
  try {
    return JSON.parse(fs.readFileSync(LOCKED_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveLocked(data) {
  fs.writeFileSync(LOCKED_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function lockUser(discordId) {
  const data = loadLocked();
  data[discordId] = true;
  saveLocked(data);
}

function unlockUser(discordId) {
  const data = loadLocked();
  delete data[discordId];
  saveLocked(data);
}

function isLocked(discordId) {
  return !!loadLocked()[discordId];
}

module.exports = { lockUser, unlockUser, isLocked };
