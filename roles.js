const fs = require('fs');

const ROLE_COLORS = {
  Officer: 0x3498db,
  Affiliate: 0x95a5a6,
  Recruitment: 0xe67e22,
  Branding: 0x9b59b6,
};

const DEFAULT_COLOR = 0x99aab5;

const PROTECTED_ROLES = ['Admin', 'Moderator', 'Owner'];
const MANAGED_ROLES_FILE = './roles.json';

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
  if (existing) return existing;

  const role = await guild.roles.create({
    name: roleName,
    color: ROLE_COLORS[roleName] ?? DEFAULT_COLOR,
    reason: 'Auto-created by RSI role sync',
  });

  // Track this role as bot-managed
  managedRoleIds.add(role.id);
  saveManagedRoles(managedRoleIds);
  console.log(`[ROLE CREATED] ${roleName} (ID: ${role.id})`);
  return role;
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

// Full role sync: assigns org-type role (Main Member/Affiliate) + all RSI roles,
// then removes stale managed roles that no longer belong to the member.
async function syncMemberRoles(guild, discordMember, userData) {
  const canManage = guild.members.me?.permissions.has('ManageRoles');
  if (!canManage) {
    console.warn('[roles] Bot is missing Manage Roles permission. Skipping sync.');
    return { added: 0, removed: 0 };
  }

  const { orgType = 'main', roles: rawRoles = [] } = userData;
  const rsiRoles = rawRoles.filter(r => r.toLowerCase() !== 'member');
  const currentRoleIds = new Set(discordMember.roles.cache.keys());

  const mainRole = await ensureRole(guild, 'Main Member');
  const affiliateRole = await ensureRole(guild, 'Affiliate');
  const orgTypeIds = new Set([mainRole.id, affiliateRole.id]);

  // Build the complete set of role IDs this member should have
  const targetRoleIds = new Set();
  targetRoleIds.add(orgType === 'affiliate' ? affiliateRole.id : mainRole.id);

  for (const roleName of rsiRoles) {
    const role = await ensureRole(guild, roleName);
    targetRoleIds.add(role.id);
  }

  let added = 0;
  let removed = 0;

  // Add missing roles
  for (const roleId of targetRoleIds) {
    if (!currentRoleIds.has(roleId)) {
      const role = guild.roles.cache.get(roleId);
      await discordMember.roles.add(roleId);
      console.log(`[ROLE SYNC] Added "${role?.name}" to ${discordMember.user.username}`);
      added++;
    }
  }

  // Remove stale managed roles (bot-tracked or org-type roles no longer applicable)
  for (const role of discordMember.roles.cache.values()) {
    if (role.name === '@everyone') continue;
    if (PROTECTED_ROLES.includes(role.name)) continue;
    if (role.managed) continue; // integration/bot roles — never touch
    if (!isManagedRole(role.id) && !orgTypeIds.has(role.id)) continue;
    if (!targetRoleIds.has(role.id)) {
      await discordMember.roles.remove(role);
      console.log(`[ROLE SYNC] Removed stale "${role.name}" from ${discordMember.user.username}`);
      removed++;
    }
  }

  return { added, removed };
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

module.exports = { syncRoles, ensureRole, assignRoleToMember, syncMemberRoles, cleanupLegacyMemberRole, isManagedRole };
