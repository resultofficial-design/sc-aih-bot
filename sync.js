const cron = require('node-cron');
const { scrapeOrgMembers } = require('./scraper');
const { ensureRole, isManagedRole } = require('./roles');
const { load, setUser, getUser, getUserByHandle } = require('./users');
const { findBestMatchRaw, similarity } = require('./fuzzy');
const { updateNickname } = require('./nicknames');
const { resolveConflicts } = require('./conflicts');

const AUTO_LINK_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.75;

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
      if (isManagedRole(role.id) && !expectedRanks.has(role.name)) {
        console.log(`[sync] Attempting to remove managed role "${role.name}" from ${discordMember.user.tag}`);
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

async function processUnverifiedUsers(guild, freshMembers, verifiedUsers, pendingDmConfirmations, channel = null) {
  const autoLinked = [];
  const needsReview = [];

  const clean = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // Track Discord IDs linked during this run — one Discord user = one RSI identity
  const linkedThisRun = new Set();

  console.log('[DEBUG] RSI MEMBERS COUNT:', freshMembers.length);
  console.log('[DEBUG] RSI MEMBERS:', freshMembers.map((m) => m.name));
  console.log('[SYNC] Using cached Discord members:', guild.members.cache.size);

  for (const orgMember of freshMembers) {
    const rsiName = orgMember.name;
    const rsiClean = clean(rsiName);

    // Skip only if already claimed by a member who is still in the guild
    const existingId = getUserByHandle(rsiName);
    if (existingId && guild.members.cache.has(existingId)) continue;

    // Build candidates using STRICT two-part rule
    const candidates = [];
    guild.members.cache.forEach((member) => {
      if (member.user.bot) return;

      const usernameClean = clean(member.user.username);
      const displayClean = clean(member.displayName || '');
      const usernameScore = similarity(usernameClean, rsiClean);
      const displayScore = similarity(displayClean, rsiClean);

      console.log('[MATCH CHECK]', {
        rsi: rsiName,
        user: member.user.username,
        display: member.displayName,
        usernameScore: usernameScore.toFixed(3),
        displayScore: displayScore.toFixed(3),
      });

      // Hard rejection: both scores too low
      if (displayScore < 0.6 && usernameScore < 0.6) return;

      // Must have string overlap AND strong score
      const hasStringMatch = (
        displayClean === rsiClean ||
        usernameClean === rsiClean ||
        (displayClean.length >= 3 && displayClean.includes(rsiClean)) ||
        (rsiClean.length >= 3 && rsiClean.includes(displayClean))
      );
      const hasStrongScore = displayScore >= 0.75 || usernameScore >= 0.8;

      if (!hasStringMatch || !hasStrongScore) return;

      candidates.push({ discordId: member.id, discordMember: member, usernameScore, displayScore });
      console.log('[CANDIDATE FOUND]', {
        rsi: rsiName,
        user: member.user.username,
        display: member.displayName,
        usernameScore: usernameScore.toFixed(3),
        displayScore: displayScore.toFixed(3),
      });
    });

    if (candidates.length === 0) continue;

    // Sort: displayScore DESC → usernameScore DESC → join date ASC
    const sorted = [...candidates].sort((a, b) => {
      const displayDiff = b.displayScore - a.displayScore;
      if (Math.abs(displayDiff) > 0.01) return displayDiff;
      const usernameDiff = b.usernameScore - a.usernameScore;
      if (Math.abs(usernameDiff) > 0.01) return usernameDiff;
      return (a.discordMember.joinedTimestamp || Infinity) - (b.discordMember.joinedTimestamp || Infinity);
    });

    const winner = sorted[0];
    const losers = sorted.slice(1);
    const bestScore = Math.max(winner.usernameScore, winner.displayScore);

    // Multiple candidates: winner must be clearly stronger than runner-up
    if (losers.length > 0) {
      const runnerUpScore = Math.max(losers[0].usernameScore, losers[0].displayScore);
      if (bestScore - runnerUpScore < 0.05) {
        console.log(`[CONFLICT] Scores too close for RSI: ${rsiName} — skipping auto-link`);
        needsReview.push({ rsiHandle: rsiName, candidates: sorted.map((c) => c.discordMember.user.tag) });
        continue;
      }
    }

    // Strict auto-link threshold — applies to both single and multi-candidate
    if (winner.displayScore < 0.8 && winner.usernameScore < 0.85) {
      console.log(`[SKIP] Match not strong enough for RSI: ${rsiName} — displayScore: ${winner.displayScore.toFixed(2)}, usernameScore: ${winner.usernameScore.toFixed(2)}`);
      continue;
    }

    console.log('[LINK DECISION]', {
      chosen: winner?.discordMember?.user?.username,
      rsi: rsiName,
    });

    // One Discord user = one RSI identity
    const alreadyLinked = getUser(winner.discordId);
    if (alreadyLinked && alreadyLinked.toLowerCase() !== rsiName.toLowerCase()) {
      console.log(`[BLOCKED] ${winner.discordMember.user.tag} already linked to "${alreadyLinked}", skipping RSI: ${rsiName}`);
      continue;
    }

    if (linkedThisRun.has(winner.discordId)) {
      console.log(`[BLOCKED] ${winner.discordMember.user.tag} already linked this sync run, skipping RSI: ${rsiName}`);
      continue;
    }

    setUser(winner.discordId, rsiName);
    linkedThisRun.add(winner.discordId);
    const rolesAdded = await assignRanks(guild, winner.discordMember, orgMember);
    await updateNickname(guild, winner.discordMember, rsiName);
    console.log(`[AUTO-LINK] Verified: ${winner.discordMember.user.tag} → RSI: ${rsiName} — ${rolesAdded} role(s) assigned`);
    autoLinked.push({
      discordTag: winner.discordMember.user.tag,
      rsiHandle: rsiName,
      score: (Math.max(winner.usernameScore, winner.displayScore) * 100).toFixed(1),
    });

    // Handle impostors
    for (const loser of losers) {
      const loserMember = loser.discordMember;

      for (const role of loserMember.roles.cache.values()) {
        if (isManagedRole(role.id)) {
          try {
            await loserMember.roles.remove(role);
          } catch (err) {
            console.warn(`[UNVERIFIED] Could not remove role "${role.name}" from ${loserMember.user.tag}: ${err.message}`);
          }
        }
      }

      try {
        await loserMember.setNickname('⚠️ Unverified', 'Conflict resolution — impostor detected');
      } catch (err) {
        console.warn(`[UNVERIFIED] Could not rename ${loserMember.user.tag}: ${err.message}`);
      }

      try {
        const dm = await loserMember.user.createDM();
        await dm.send(
          `⚠️ You were linked to an RSI identity that belongs to another user.\n` +
          `Your roles have been removed. Contact an admin if this is incorrect.`
        );
      } catch (e) {
        console.warn(`[DM FAILED] Could not DM impostor: ${loserMember.user.tag}`);
      }

      if (channel) {
        try {
          await channel.send(`⚠️ ${loserMember} removed from incorrect RSI identity (**${rsiName}**)`);
        } catch (e) {
          console.warn(`[CHANNEL WARN] Could not post warning for ${loserMember.user.tag}`);
        }
      }

      console.log(`[UNVERIFIED] Impostor handled: ${loserMember.user.tag}`);
    }
  }

  return { autoLinked, needsReview };
}

async function runSync(guild, cachedMembersRef, pendingDmConfirmations, channel = null) {
  console.log('[sync] Starting sync...');

  let freshMembers;
  try {
    freshMembers = await scrapeOrgMembers(process.env.ORG_NAME);
    console.log(`[sync] Fetched ${freshMembers.length} org members.`);
    cachedMembersRef.members = freshMembers;
  } catch (err) {
    if (cachedMembersRef.members.length > 0) {
      console.warn(`[sync] Scraping failed (${err.message}) — falling back to ${cachedMembersRef.members.length} cached members.`);
      freshMembers = cachedMembersRef.members;
    } else {
      console.error('[sync] Scraping failed and no cached members available:', err.message);
      return { error: err.message };
    }
  }

  console.log('[SYNC] Members received:', freshMembers.length);

  if (!freshMembers || freshMembers.length === 0) {
    console.warn('[SYNC] No members found — aborting sync');
    return { error: 'No members found', usersUpdated: 0, rolesAdded: 0, rolesRemoved: 0, rolesCreated: 0, autoLinked: [], needsReview: [], unmatched: [] };
  }

  console.log('[SYNC] Proceeding with sync using', freshMembers.length, 'members');

  // Ensure all org ranks exist as Discord roles, count newly created ones
  await guild.roles.fetch();
  const orgRankNames = new Set();
  for (const m of freshMembers) {
    for (const rank of m.rank.split(',').map((r) => r.trim()).filter(Boolean)) {
      orgRankNames.add(rank);
    }
  }

  let rolesCreated = 0;
  for (const rank of orgRankNames) {
    const exists = guild.roles.cache.find((r) => r.name.toLowerCase() === rank.toLowerCase());
    await ensureRole(guild, rank);
    if (!exists) rolesCreated++;
  }

  // Fetch ALL guild members so the cache is complete before any matching
  console.log('[SYNC] Fetching all guild members...');
  try {
    await guild.members.fetch({ time: 60000 });
  } catch (err) {
    console.warn('[SYNC] Could not fetch all members:', err.message);
  }
  console.log('[SYNC] Total Discord members:', guild.members.cache.size);

  if (guild.members.cache.size < 10) {
    console.warn('[WARNING] Low Discord member count:', guild.members.cache.size);
  }

  const verifiedUsers = load();

  const { updated, rolesAdded, rolesRemoved, unmatched } =
    await processVerifiedUsers(guild, freshMembers, verifiedUsers);

  // Resolve identity conflicts after verified users are processed
  const latestVerified = load();
  const { resolved: conflictsResolved, unresolved: conflictsUnresolved } =
    await resolveConflicts(guild, freshMembers, latestVerified, { assignRanks, channel });

  // Re-load so any in-flight auto-links are reflected
  const updatedVerified = load();
  const { autoLinked, needsReview } =
    await processUnverifiedUsers(guild, freshMembers, updatedVerified, pendingDmConfirmations, channel);

  const summary = {
    usersUpdated: updated,
    rolesAdded,
    rolesRemoved,
    rolesCreated,
    autoLinked,
    needsReview,
    unmatched,
    conflictsResolved,
    conflictsUnresolved,
  };

  console.log(
    `[sync] Done — users processed: ${updated}, roles assigned: ${rolesAdded}, roles removed: ${rolesRemoved}, ` +
    `new roles created: ${rolesCreated}, auto-linked: ${autoLinked.length}, ` +
    `DMs sent: ${needsReview.length}, unmatched: ${unmatched.length}, ` +
    `conflicts resolved: ${conflictsResolved}, conflicts pending: ${conflictsUnresolved}`
  );
  console.log('[SYNC] Sync completed successfully');

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
