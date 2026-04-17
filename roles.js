const fs = require('fs');

const ROLE_COLORS = {
  Officer: 0x3498db,
  Affiliate: 0x95a5a6,
  Recruitment: 0xe67e22,
  Branding: 0x9b59b6,
  Member: 0x2ecc71,
};

const DEFAULT_COLOR = 0x99aab5;
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

  // role is the new single-value field; rank is the legacy alias — support both
  const allRoles = new Set();
  for (const member of members) {
    const roleStr = member.role || member.rank || '';
    for (const r of roleStr.split(',').map((s) => s.trim()).filter(Boolean)) {
      allRoles.add(r);
    }
  }

  console.log(`[roles] Syncing ${allRoles.size} role(s): ${[...allRoles].join(', ')}`);

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

module.exports = { syncRoles, ensureRole, assignRoleToMember, isManagedRole };
