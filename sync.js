const cron = require('node-cron');
const { scrapeOrgMembers } = require('./scraper');
const { ensureRole, isManagedRole } = require('./roles');
const { load, setUser, getUserByHandle } = require('./users');
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

async function processUnverifiedUsers(guild, freshMembers, verifiedUsers, pendingDmConfirmations) {
  const autoLinked = [];
  const needsReview = [];

  console.log('[SYNC] Using cached Discord members:', guild.members.cache.size);

  for (const orgMember of freshMembers) {
    const rsiName = orgMember.name;

    // Skip if this RSI handle is already claimed — handled by processVerifiedUsers + resolveConflicts
    if (getUserByHandle(rsiName)) continue;

    // Collect all unverified Discord candidates with any meaningful similarity
    const candidates = [];
    guild.members.cache.forEach((member) => {
      if (member.user.bot) return;
      if (verifiedUsers[member.id]) return;

      const usernameScore = similarity(member.user.username, rsiName);
      const nicknameScore = similarity(member.nickname || '', rsiName);
      const bestScore = Math.max(usernameScore, nicknameScore);

      if (bestScore > 0.4) {
        candidates.push({ discordId: member.id, discordMember: member, usernameScore, nicknameScore, bestScore });
      }
    });

    if (candidates.length === 0) continue;

    console.log(
      `[UNVERIFIED] RSI: ${rsiName} — ${candidates.length} candidate(s): ` +
      candidates.map((c) => `${c.discordMember.user.tag} (${c.bestScore.toFixed(2)})`).join(', ')
    );

    let winner = null;

    if (candidates.length === 1) {
      winner = candidates[0];
    } else {
      // Multiple candidates — resolve conflict before any assignment

      // Step 1: One is already verified (edge case guard)
      const verifiedCandidate = candidates.find((c) => verifiedUsers[c.discordId]);
      if (verifiedCandidate) {
        winner = verifiedCandidate;
        console.log(`[UNVERIFIED] Conflict resolved (verified): ${winner.discordMember.user.tag} wins for RSI: ${rsiName}`);
      }

      // Step 2: Nickname exactly matches RSI name
      if (!winner) {
        const exactNick = candidates.find(
          (c) => (c.discordMember.nickname || '').toLowerCase() === rsiName.toLowerCase()
        );
        if (exactNick) {
          winner = exactNick;
          console.log(`[UNVERIFIED] Conflict resolved (exact nickname): ${winner.discordMember.user.tag} wins for RSI: ${rsiName}`);
        }
      }

      // Step 3: Earliest joinedAt (only if unambiguous)
      if (!winner) {
        const sorted = [...candidates].sort(
          (a, b) => (a.discordMember.joinedTimestamp || Infinity) - (b.discordMember.joinedTimestamp || Infinity)
        );
        if (sorted[0].discordMember.joinedTimestamp !== sorted[1].discordMember.joinedTimestamp) {
          winner = sorted[0];
          console.log(`[UNVERIFIED] Conflict resolved (join date): ${winner.discordMember.user.tag} wins for RSI: ${rsiName}`);
        }
      }

      // Step 4: No clear winner — flag for manual review
      if (!winner) {
        console.log(
          `[UNVERIFIED] [CONFLICT] Manual review required for RSI: ${rsiName} — ` +
          candidates.map((c) => c.discordMember.user.tag).join(', ')
        );
        continue;
      }
    }

    if (!winner) continue;

    const pct = (winner.bestScore * 100).toFixed(1);

    if (winner.bestScore >= AUTO_LINK_THRESHOLD) {
      // Strong match — auto-link
      setUser(winner.discordId, rsiName);
      const rolesAdded = await assignRanks(guild, winner.discordMember, orgMember);
      await updateNickname(guild, winner.discordMember, rsiName);

      console.log(
        `[UNVERIFIED] Auto-linked ${winner.discordMember.user.tag} → RSI: ${rsiName} (${pct}%) — ${rolesAdded} role(s) assigned`
      );
      autoLinked.push({ discordTag: winner.discordMember.user.tag, rsiHandle: rsiName, score: pct });

    } else if (winner.bestScore >= REVIEW_THRESHOLD) {
      // Medium match — send DM confirmation
      try {
        const dmChannel = await winner.discordMember.user.createDM();
        await dmChannel.send(
          `Hi! We found a possible match between your Discord account and the RSI org **${process.env.ORG_NAME}**.\n\n` +
          `Is your RSI handle **${rsiName}**?\n\n` +
          `Reply \`yes\` to link your account and receive your roles, or \`no\` to dismiss.`
        );
        pendingDmConfirmations.set(winner.discordId, { rsiHandle: rsiName, orgMember, guildId: guild.id });
        console.log(`[UNVERIFIED] DM sent to ${winner.discordMember.user.tag} — possible RSI match: ${rsiName} (${pct}%)`);
      } catch (err) {
        console.warn(`[UNVERIFIED] Could not DM ${winner.discordMember.user.tag}: ${err.message}`);
      }
      needsReview.push({ discordTag: winner.discordMember.user.tag, rsiHandle: rsiName, score: pct });
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

  const verifiedUsers = load();

  const { updated, rolesAdded, rolesRemoved, unmatched } =
    await processVerifiedUsers(guild, freshMembers, verifiedUsers);

  // Resolve identity conflicts after verified users are processed
  const latestVerified = load();
  const { resolved: conflictsResolved, unresolved: conflictsUnresolved } =
    await resolveConflicts(guild, freshMembers, latestVerified);

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
