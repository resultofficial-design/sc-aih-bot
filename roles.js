const fs = require('fs');
const path = require('path');

const DEFAULT_COLOR = 0x99aab5;
const PROTECTED_ROLES = ['Admin', 'Moderator', 'Owner'];
const BASE_ROLES = ['Main Member', 'Affiliate', 'Non-Org'];
const MANAGED_ROLES_FILE = './roles.json';
const ROLE_COLORS_FILE = path.join(__dirname, 'role-colors.json');

function hexToInt(hex) {
  return parseInt((hex || '').replace('#', ''), 16) || DEFAULT_COLOR;
}

function loadRoleColors() {
  try {
    return JSON.parse(fs.readFileSync(ROLE_COLORS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveRoleColors(colors) {
  fs.writeFileSync(ROLE_COLORS_FILE, JSON.stringify(colors, null, 2));
}

function getRoleColor(roleName) {
  const colors = loadRoleColors();
  return colors[roleName] ? hexToInt(colors[roleName]) : DEFAULT_COLOR;
}

// Load persisted set of bot-managed role IDs
function loadManagedRoles() {
  try {
    const data = JSON.parse(fs.readFileSync(MANAGED_ROLES_FILE, 'utf8'));
    return new Set(Array.isArray(data.roles) ? data.roles : []);
  } catch {
    return new Set();
  }
}

function saveManagedRoles(set) {
  fs.writeFileSync(MANAGED_ROLES_FILE, JSON.stringify({ roles: [...set] }, null, 2));
}

const managedRoleIds = loadManagedRoles();
console.log(`[roles] Loaded ${managedRoleIds.size} managed role ID(s) from roles.json`);

function isManagedRole(roleId) {
  return managedRoleIds.has(roleId);
}

async function ensureRole(guild, roleName) {
  const existing = guild.roles.cache.find(
    (r) => r.name.toLowerCase() === roleName.toLowerCase()
  );
  const color = getRoleColor(roleName);

  if (existing) {
    // Update color if it differs from saved config
    if (existing.color !== color) {
      await existing.setColor(color).catch(() => {});
    }
    managedRoleIds.add(existing.id);
    return existing;
  }

  const role = await guild.roles.create({
    name: roleName,
    color,
    reason: 'Auto-created by RSI role sync',
  });

  managedRoleIds.add(role.id);
  saveManagedRoles(managedRoleIds);
  console.log(`[ROLE CREATED] ${roleName} (ID: ${role.id})`);
  return role;
}

// Apply saved colors to all existing Discord roles immediately
async function applyAllRoleColors(guild) {
  const colors = loadRoleColors();
  let updated = 0;
  for (const [roleName, hex] of Object.entries(colors)) {
    const role = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (role) {
      await role.setColor(hexToInt(hex)).catch(() => {});
      updated++;
    }
  }
  return updated;
}

async function syncRoles(guild, members) {
  const canManage = guild.members.me?.permissions.has('ManageRoles');
  if (!canManage) {
    console.warn('[roles] Bot is missing Manage Roles permission. Skipping sync.');
    return;
  }

  const allRoles = new Set();
  for (const member of members) {
    for (const r of (member.roles || [])) {
      if (r && r.toLowerCase() !== 'member') allRoles.add(r);
    }
  }

  console.log(`[SYNC ROLES INPUT] Syncing ${allRoles.size} role(s): ${[...allRoles].join(', ')}`);

  for (const roleName of allRoles) {
    await ensureRole(guild, roleName);
  }
}

async function assignRoleToMember(guild, discordMember, roleName) {
  const role = await ensureRole(guild, roleName);
  if (!discordMember.roles.cache.has(role.id)) {
    await discordMember.roles.add(role);
    console.log(`[ROLE SYNC]`, { user: discordMember.user.username, role: roleName });
  }
}

// Full role sync: enforces exactly one base role + RSI rank roles, removes stale.
async function syncMemberRoles(guild, discordMember, userData) {
  const canManage = guild.members.me?.permissions.has('ManageRoles');
  if (!canManage) {
    console.warn('[roles] Bot is missing Manage Roles permission. Skipping sync.');
    return { added: 0, removed: 0 };
  }

  const { orgType = 'main', roles: rawRoles = [] } = userData;
  const rsiRoles = rawRoles.filter(r => r.toLowerCase() !== 'member');

  // Ensure all base roles exist and collect their IDs
  const mainRole     = await ensureRole(guild, 'Main Member');
  const affiliateRole = await ensureRole(guild, 'Affiliate');
  const nonOrgRole   = await ensureRole(guild, 'Non-Org');
  const baseRoleIds  = new Set([mainRole.id, affiliateRole.id, nonOrgRole.id]);

  // Exactly one base role based on orgType
  const targetBaseId =
    orgType === 'affiliate' ? affiliateRole.id :
    orgType === 'none'      ? nonOrgRole.id    :
                              mainRole.id;

  // Build full target set: one base role + rank roles
  const targetRoleIds = new Set([targetBaseId]);
  for (const roleName of rsiRoles) {
    const role = await ensureRole(guild, roleName);
    targetRoleIds.add(role.id);
  }

  let added = 0;
  let removed = 0;

  // Remove ALL base roles first, then add the correct one (prevents duplicates)
  for (const role of discordMember.roles.cache.values()) {
    if (role.name === '@everyone') continue;
    if (PROTECTED_ROLES.includes(role.name)) continue;
    if (role.managed) continue;
    const isBase = baseRoleIds.has(role.id);
    const isManaged = isManagedRole(role.id);
    if (!isBase && !isManaged) continue;
    if (!targetRoleIds.has(role.id)) {
      await discordMember.roles.remove(role);
      console.log(`[ROLE SYNC] Removed "${role.name}" from ${discordMember.user.username}`);
      removed++;
    }
  }

  // Add missing roles
  const currentRoleIds = new Set(discordMember.roles.cache.keys());
  for (const roleId of targetRoleIds) {
    if (!currentRoleIds.has(roleId)) {
      const role = guild.roles.cache.get(roleId);
      await discordMember.roles.add(roleId);
      console.log(`[ROLE SYNC] Added "${role?.name}" to ${discordMember.user.username}`);
      added++;
    }
  }

  return { added, removed };
}

// Enforce strict role hierarchy: Main Member > Affiliate > Non-Org > rank roles
async function enforceRoleHierarchy(guild) {
  await guild.roles.fetch();

  // Ensure all base roles exist
  for (const name of BASE_ROLES) await ensureRole(guild, name);
  await guild.roles.fetch();

  const botMaxPosition = guild.members.me?.roles.highest.position ?? 0;
  const baseStart = Math.max(1, botMaxPosition - BASE_ROLES.length);

  const positions = [];
  BASE_ROLES.forEach((name, idx) => {
    const role = guild.roles.cache.find(r => r.name === name);
    if (role) positions.push({ role, position: baseStart + (BASE_ROLES.length - 1 - idx) });
  });

  if (positions.length > 0) {
    await guild.roles.setPositions(positions).catch(err =>
      console.warn('[HIERARCHY] Could not set positions:', err.message)
    );
  }

  console.log('[ROLE ORDER FIXED]', BASE_ROLES);
}

// One-time startup cleanup: strips "Member" role from all users and deletes it from the server
async function cleanupLegacyMemberRole(guild) {
  const legacyRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'member');
  if (!legacyRole) return;

  console.log(`[CLEANUP] Found legacy "Member" role (ID: ${legacyRole.id}) — stripping from all members...`);

  let stripped = 0;
  for (const member of guild.members.cache.values()) {
    if (member.roles.cache.has(legacyRole.id)) {
      try {
        await member.roles.remove(legacyRole);
        stripped++;
      } catch (err) {
        console.warn(`[CLEANUP] Could not remove "Member" from ${member.user.tag}: ${err.message}`);
      }
    }
  }

  try {
    await legacyRole.delete('Removing legacy Member role — replaced by Main Member/Affiliate + RSI ranks');
    console.log(`[CLEANUP] Deleted "Member" role. Stripped from ${stripped} user(s).`);
  } catch (err) {
    console.warn(`[CLEANUP] Could not delete "Member" role: ${err.message}`);
  }
}

module.exports = { syncRoles, ensureRole, assignRoleToMember, syncMemberRoles, cleanupLegacyMemberRole, isManagedRole, loadRoleColors, saveRoleColors, applyAllRoleColors, enforceRoleHierarchy };
