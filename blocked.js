const fs = require('fs');
const path = require('path');

const BLOCKED_FILE = path.join(__dirname, 'blocked.json');

function loadBlocked() {
  try {
    return JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveBlocked(data) {
  fs.writeFileSync(BLOCKED_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function isBlocked(discordId) {
  return !!loadBlocked()[discordId]?.blocked;
}

function getAttempts(discordId) {
  return loadBlocked()[discordId]?.attempts || 0;
}

function incrementAttempts(discordId) {
  const data = loadBlocked();
  if (!data[discordId]) data[discordId] = { blocked: false, attempts: 0 };
  data[discordId].attempts = (data[discordId].attempts || 0) + 1;
  saveBlocked(data);
  return data[discordId].attempts;
}

function blockUser(discordId) {
  const data = loadBlocked();
  data[discordId] = { blocked: true, attempts: data[discordId]?.attempts || 0 };
  saveBlocked(data);
}

function unblockUser(discordId) {
  const data = loadBlocked();
  delete data[discordId];
  saveBlocked(data);
}

module.exports = { isBlocked, getAttempts, incrementAttempts, blockUser, unblockUser };
