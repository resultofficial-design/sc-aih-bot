const ROLE_COLORS = {
  Officer: 0x3498db,
  Affiliate: 0x95a5a6,
  Recruitment: 0xe67e22,
  Branding: 0x9b59b6,
  Member: 0x2ecc71,
};

const DEFAULT_COLOR = 0x99aab5;

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

  console.log(`[roles] Created role: ${roleName}`);
  return role;
}

async function syncRoles(guild, members) {
  const canManage = guild.members.me?.permissions.has('ManageRoles');
  if (!canManage) {
    console.warn('[roles] Bot is missing Manage Roles permission. Skipping sync.');
    return;
  }

  const allRanks = new Set();
  for (const member of members) {
    for (const rank of member.rank.split(',').map((r) => r.trim()).filter(Boolean)) {
      allRanks.add(rank);
    }
  }

  console.log(`[roles] Syncing ${allRanks.size} rank(s): ${[...allRanks].join(', ')}`);

  for (const rank of allRanks) {
    await ensureRole(guild, rank);
  }
}

async function assignRoleToMember(guild, discordMember, roleName) {
  const role = await ensureRole(guild, roleName);
  if (!discordMember.roles.cache.has(role.id)) {
    await discordMember.roles.add(role);
    console.log(`[roles] Assigned role "${roleName}" to ${discordMember.user.tag}`);
  }
}

module.exports = { syncRoles, ensureRole, assignRoleToMember };
