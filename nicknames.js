const fs = require('fs');
const path = require('path');

const NONICK_FILE = path.join(__dirname, 'nonick.json');

function loadOptOuts() {
  try {
    return new Set(JSON.parse(fs.readFileSync(NONICK_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveOptOuts(set) {
  fs.writeFileSync(NONICK_FILE, JSON.stringify([...set], null, 2), 'utf8');
}

function addOptOut(discordId) {
  const set = loadOptOuts();
  set.add(discordId);
  saveOptOuts(set);
}

function removeOptOut(discordId) {
  const set = loadOptOuts();
  set.delete(discordId);
  saveOptOuts(set);
}

function hasOptedOut(discordId) {
  return loadOptOuts().has(discordId);
}

function isAdmin(discordMember) {
  return (
    discordMember.permissions.has('Administrator') ||
    discordMember.id === discordMember.guild.ownerId
  );
}

async function updateNickname(guild, discordMember, rsiHandle) {
  // Skip admins
  if (isAdmin(discordMember)) {
    console.log(`[nick] Skipping admin ${discordMember.user.tag}`);
    return false;
  }

  // Skip opted-out users
  if (hasOptedOut(discordMember.id)) {
    console.log(`[nick] Skipping opted-out user ${discordMember.user.tag}`);
    return false;
  }

  // Skip if nickname already matches
  if (discordMember.nickname === rsiHandle) return false;

  // Check bot has permission to manage this member's nickname
  const botMember = guild.members.me;
  if (!botMember.permissions.has('ManageNicknames')) {
    console.warn('[nick] Bot is missing Manage Nicknames permission.');
    return false;
  }

  // Bot cannot change nicknames of members with equal or higher roles
  if (discordMember.roles.highest.position >= botMember.roles.highest.position) {
    console.warn(`[nick] Cannot change nickname of ${discordMember.user.tag} — equal or higher role.`);
    return false;
  }

  try {
    const oldName = discordMember.nickname || discordMember.user.username;
    await discordMember.setNickname(rsiHandle, 'RSI nickname sync');
    console.log(`[nick] Renamed ${discordMember.user.tag}: "${oldName}" → "${rsiHandle}"`);
    return true;
  } catch (err) {
    console.error(`[nick] Failed to rename ${discordMember.user.tag}: ${err.message}`);
    return false;
  }
}

module.exports = { updateNickname, addOptOut, removeOptOut, hasOptedOut };
