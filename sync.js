const cron = require('node-cron');
const { scrapeOrgMembers } = require('./scraper');
const { ensureRole } = require('./roles');
const { load, setUser } = require('./users');
const { findBestMatchRaw } = require('./fuzzy');
const { updateNickname } = require('./nicknames');

const AUTO_LINK_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.75;

const RSI_RANK_NAMES = new Set([
  'Officer', 'Member', 'Affiliate', 'Recruitment', 'Branding',
]);

async function assignRanks(guild, discordMember, orgMember) {
  const ranks = orgMember.rank.split(',').map((r) => r.trim()).filter(Boolean);
  let added = 0;

  for (const rank of ranks) {
    const role = await ensureRole(guild, rank);
    if (!discordMember.roles.cache.has(role.id)) {
      await discordMember.roles.add(role);
      added++;
    }
  }

  return added;
}

async function processVerifiedUsers(guild, freshMembers, verifiedUsers) {
  let updated = 0;
  let rolesAdded = 0;
  let rolesRemoved = 0;
  const unmatched = [];

  for (const [discordId, rsiHandle] of Object.entries(verifiedUsers)) {
    const orgMember = freshMembers.find(
      (m) => m.name.toLowerCase() === rsiHandle.toLowerCase()
    );

    let discordMember;
    try {
      discordMember = await guild.members.fetch(discordId);
    } catch {
      console.warn(`[sync] Discord user ${discordId} not found in guild.`);
      unmatched.push({ discordId, rsiHandle, reason: 'not in guild' });
      continue;
    }

    if (!orgMember) {
      console.warn(`[sync] RSI handle "${rsiHandle}" not found in org.`);
      unmatched.push({ discordId, rsiHandle, reason: 'not in org' });
      continue;
    }

    const expectedRanks = new Set(
      orgMember.rank.split(',').map((r) => r.trim()).filter(Boolean)
    );

    for (const rank of expectedRanks) {
      const role = guild.roles.cache.find((r) => r.name === rank);
      if (role && !discordMember.roles.cache.has(role.id)) {
        await discordMember.roles.add(role);
        console.log(`[sync] Added role "${rank}" to ${discordMember.user.tag}`);
        rolesAdded++;
      }
    }

    for (const role of discordMember.roles.cache.values()) {
      if (RSI_RANK_NAMES.has(role.name) && !expectedRanks.has(role.name)) {
        await discordMember.roles.remove(role);
        console.log(`[sync] Removed role "${role.name}" from ${discordMember.user.tag}`);
        rolesRemoved++;
      }
    }

    // Update nickname to RSI handle
    await updateNickname(guild, discordMember, orgMember.name);

    updated++;
  }

  return { updated, rolesAdded, rolesRemoved, unmatched };
}

async function processUnverifiedUsers(guild, freshMembers, verifiedUsers, pendingDmConfirmations) {
  const orgNames = freshMembers.map((m) => m.name);
  const autoLinked = [];
  const needsReview = [];

  const allMembers = await guild.members.fetch();

  for (const [discordId, discordMember] of allMembers) {
    if (discordMember.user.bot) continue;
    if (verifiedUsers[discordId]) continue;

    // Check both username and display name; take the highest score
    const candidates = [...new Set([
      discordMember.user.username,
      discordMember.displayName,
    ].filter(Boolean))];

    let bestResult = null;
    let bestSource = null;

    for (const name of candidates) {
      const result = findBestMatchRaw(name, orgNames);
      if (result && (!bestResult || result.score > bestResult.score)) {
        bestResult = result;
        bestSource = name;
      }
    }

    if (!bestResult) continue;

    const { match, score } = bestResult;
    const pct = (score * 100).toFixed(1);

    if (score >= AUTO_LINK_THRESHOLD) {
      // Strong match — auto-link immediately
      setUser(discordId, match);
      const orgMember = freshMembers.find((m) => m.name === match);
      const rolesAdded = await assignRanks(guild, discordMember, orgMember);

      console.log(
        `[sync] Auto-linked ${discordMember.user.tag} (via "${bestSource}") → RSI: ${match} (${pct}%) — ${rolesAdded} role(s) assigned`
      );
      autoLinked.push({ discordTag: discordMember.user.tag, rsiHandle: match, score: pct });

    } else if (score >= REVIEW_THRESHOLD) {
      // Medium match — send DM asking for confirmation
      const orgMember = freshMembers.find((m) => m.name === match);

      try {
        const dmChannel = await discordMember.user.createDM();
        await dmChannel.send(
          `Hi! We found a possible match between your Discord account and the RSI org **${process.env.ORG_NAME}**.\n\n` +
          `Is your RSI handle **${match}**?\n\n` +
          `Reply \`yes\` to link your account and receive your roles, or \`no\` to dismiss.`
        );

        // Store pending confirmation so the DM reply can be handled
        pendingDmConfirmations.set(discordId, { rsiHandle: match, orgMember, guildId: guild.id });

        console.log(
          `[sync] DM sent to ${discordMember.user.tag} for review — possible RSI match: ${match} (${pct}%)`
        );
      } catch (err) {
        // User may have DMs disabled
        console.warn(`[sync] Could not DM ${discordMember.user.tag}: ${err.message}`);
      }

      needsReview.push({ discordTag: discordMember.user.tag, rsiHandle: match, score: pct });
    }
  }

  return { autoLinked, needsReview };
}

async function runSync(guild, cachedMembersRef, pendingDmConfirmations) {
  console.log('[sync] Starting sync...');

  let freshMembers;
  try {
    freshMembers = await scrapeOrgMembers(process.env.ORG_NAME);
    console.log(`[sync] Fetched ${freshMembers.length} org members.`);
  } catch (err) {
    console.error('[sync] Scraping failed, aborting sync:', err.message);
    return { error: err.message };
  }

  cachedMembersRef.members = freshMembers;

  // Ensure all org ranks exist as Discord roles, count newly created ones
  await guild.roles.fetch();
  const orgRankNames = new Set();
  for (const m of freshMembers) {
    for (const rank of m.rank.split(',').map((r) => r.trim()).filter(Boolean)) {
      orgRankNames.add(rank);
      RSI_RANK_NAMES.add(rank);
    }
  }

  let rolesCreated = 0;
  for (const rank of orgRankNames) {
    const exists = guild.roles.cache.find((r) => r.name.toLowerCase() === rank.toLowerCase());
    await ensureRole(guild, rank);
    if (!exists) rolesCreated++;
  }

  const verifiedUsers = load();

  const { updated, rolesAdded, rolesRemoved, unmatched } =
    await processVerifiedUsers(guild, freshMembers, verifiedUsers);

  // Re-load so any in-flight auto-links are reflected
  const updatedVerified = load();
  const { autoLinked, needsReview } =
    await processUnverifiedUsers(guild, freshMembers, updatedVerified, pendingDmConfirmations);

  const summary = {
    usersUpdated: updated,
    rolesAdded,
    rolesRemoved,
    rolesCreated,
    autoLinked,
    needsReview,
    unmatched,
  };

  console.log(
    `[sync] Done — users processed: ${updated}, roles assigned: ${rolesAdded}, roles removed: ${rolesRemoved}, ` +
    `new roles created: ${rolesCreated}, auto-linked: ${autoLinked.length}, ` +
    `DMs sent: ${needsReview.length}, unmatched: ${unmatched.length}`
  );

  return summary;
}

function scheduleWeeklySync(guild, cachedMembersRef, pendingDmConfirmations) {
  cron.schedule('0 0 * * 0', async () => {
    console.log('[sync] Weekly sync triggered.');
    await runSync(guild, cachedMembersRef, pendingDmConfirmations);
  });

  console.log('[sync] Weekly sync scheduled (Sundays at midnight).');
}

module.exports = { runSync, scheduleWeeklySync };
