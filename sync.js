const cron = require('node-cron');
const { scrapeOrgMembers } = require('./scraper');
const { ensureRole } = require('./roles');
const { load, setUser } = require('./users');
const { findBestMatchRaw } = require('./fuzzy');

// Thresholds for unverified member auto-linking
const AUTO_LINK_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.70;

// All known RSI rank names (used to identify which Discord roles are RSI-managed)
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

    updated++;
  }

  return { updated, rolesAdded, rolesRemoved, unmatched };
}

async function processUnverifiedUsers(guild, freshMembers, verifiedUsers) {
  const orgNames = freshMembers.map((m) => m.name);
  const autoLinked = [];
  const needsReview = [];

  // Fetch all guild members (paginated automatically by discord.js)
  const allMembers = await guild.members.fetch();

  for (const [discordId, discordMember] of allMembers) {
    // Skip bots
    if (discordMember.user.bot) continue;

    // Skip already verified
    if (verifiedUsers[discordId]) continue;

    // Candidates to match against: username and nickname
    const candidates = [
      discordMember.user.username,
      discordMember.displayName,
    ].filter(Boolean);

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
      // Auto-link
      setUser(discordId, match);
      const orgMember = freshMembers.find((m) => m.name === match);
      const rolesAdded = await assignRanks(guild, discordMember, orgMember);

      console.log(
        `[sync] Auto-linked unverified user ${discordMember.user.tag} (via "${bestSource}") → RSI: ${match} (${pct}%) — ${rolesAdded} role(s) assigned`
      );
      autoLinked.push({ discordTag: discordMember.user.tag, rsiHandle: match, score: pct });
    } else if (score >= REVIEW_THRESHOLD) {
      // Log for review — not auto-linked
      console.log(
        `[sync] Review needed: ${discordMember.user.tag} (via "${bestSource}") might be RSI: ${match} (${pct}%)`
      );
      needsReview.push({ discordTag: discordMember.user.tag, rsiHandle: match, score: pct });
    }
  }

  return { autoLinked, needsReview };
}

async function runSync(guild, cachedMembersRef) {
  console.log('[sync] Starting sync...');

  // Fetch fresh org members
  let freshMembers;
  try {
    freshMembers = await scrapeOrgMembers(process.env.ORG_NAME);
    console.log(`[sync] Fetched ${freshMembers.length} org members.`);
  } catch (err) {
    console.error('[sync] Scraping failed, aborting sync:', err.message);
    return { error: err.message };
  }

  cachedMembersRef.members = freshMembers;

  // Ensure all org ranks exist as Discord roles
  await guild.roles.fetch();
  const orgRankNames = new Set();
  for (const m of freshMembers) {
    for (const rank of m.rank.split(',').map((r) => r.trim()).filter(Boolean)) {
      orgRankNames.add(rank);
      RSI_RANK_NAMES.add(rank);
    }
  }
  for (const rank of orgRankNames) {
    await ensureRole(guild, rank);
  }

  // Load current verified users (do NOT mutate this object — setUser handles persistence)
  const verifiedUsers = load();

  // Process verified users
  const { updated, rolesAdded, rolesRemoved, unmatched } =
    await processVerifiedUsers(guild, freshMembers, verifiedUsers);

  // Process unverified users (re-load so auto-links from above are reflected)
  const updatedVerified = load();
  const { autoLinked, needsReview } =
    await processUnverifiedUsers(guild, freshMembers, updatedVerified);

  const summary = {
    usersUpdated: updated,
    rolesAdded,
    rolesRemoved,
    unmatched,
    autoLinked,
    needsReview,
  };

  console.log(
    `[sync] Done. Verified updated: ${updated}, roles added: ${rolesAdded}, roles removed: ${rolesRemoved}, ` +
    `unmatched: ${unmatched.length}, auto-linked: ${autoLinked.length}, needs review: ${needsReview.length}`
  );

  return summary;
}

function scheduleWeeklySync(guild, cachedMembersRef) {
  cron.schedule('0 0 * * 0', async () => {
    console.log('[sync] Weekly sync triggered.');
    await runSync(guild, cachedMembersRef);
  });

  console.log('[sync] Weekly sync scheduled (Sundays at midnight).');
}

module.exports = { runSync, scheduleWeeklySync };
