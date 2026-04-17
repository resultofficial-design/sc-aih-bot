const cron = require('node-cron');
const { scrapeOrgMembers } = require('./scraper');
const { ensureRole, isManagedRole } = require('./roles');
const { load, setUser, getUser, getUserByHandle, removeUser } = require('./users');
const { findBestMatchRaw, similarity } = require('./fuzzy');
const { updateNickname } = require('./nicknames');
const { resolveConflicts } = require('./conflicts');
const { isLocked } = require('./locked');

const AUTO_LINK_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.75;

async function assignRanks(guild, discordMember, orgMember) {
  // Use role (new single-value field) with rank as legacy fallback
  const roleStr = orgMember.role || orgMember.rank || '';
  const roles = roleStr.split(',').map((r) => r.trim()).filter(Boolean);
  let added = 0;

  for (const roleName of roles) {
    const role = await ensureRole(guild, roleName);
    if (!discordMember.roles.cache.has(role.id)) {
      await discordMember.roles.add(role);
      console.log(`[ROLE SYNC]`, { user: discordMember.user.username, role: roleName });
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
    // Match by name (displayName) first — primary identity, same as old system.
    // Also try handle as fallback in case old data stored a handle instead.
    let orgMember = freshMembers.find(
      (m) => m.name.toLowerCase() === rsiHandle.toLowerCase()
    );
    if (!orgMember) {
      orgMember = freshMembers.find(
        (m) => (m.handle || '').toLowerCase() === rsiHandle.toLowerCase()
      );
      if (orgMember) {
        console.log(`[NAME MIGRATION] ${discordId}: stored "${rsiHandle}" matched handle → display name is "${orgMember.name}"`);
      }
    }

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

    // correctName = org display name — primary identity (nickname target)
    const correctName = orgMember.name;

    // Determine what needs updating
    const handleMismatch = rsiHandle !== correctName;
    const nicknameMismatch = discordMember.displayName !== correctName;

    const expectedRanks = new Set(
      orgMember.rank.split(',').map((r) => r.trim()).filter(Boolean)
    );

    let rolesMissing = false;
    let rolesExtra = false;
    for (const rank of expectedRanks) {
      const role = guild.roles.cache.find((r) => r.name === rank);
      if (role && !discordMember.roles.cache.has(role.id)) { rolesMissing = true; break; }
    }
    if (!rolesMissing) {
      for (const role of discordMember.roles.cache.values()) {
        if (isManagedRole(role.id) && !expectedRanks.has(role.name)) { rolesExtra = true; break; }
      }
    }

    // Skip only when everything is already in the correct state
    if (!handleMismatch && !nicknameMismatch && !rolesMissing && !rolesExtra) {
      console.log(`[SKIP - ALREADY CORRECT] ${discordMember.user.tag} (${correctName})`);
      continue;
    }

    // Fix stored handle if it differs from the authoritative org handle
    if (handleMismatch) {
      console.log(`[UPDATED HANDLE] ${discordMember.user.tag}: old="${rsiHandle}" → new="${correctName}"`);
      setUser(discordId, correctName);
    }

    // Add missing roles
    for (const rank of expectedRanks) {
      const role = guild.roles.cache.find((r) => r.name === rank);
      if (role && !discordMember.roles.cache.has(role.id)) {
        await discordMember.roles.add(role);
        console.log(`[sync] Added role "${rank}" to ${discordMember.user.tag}`);
        rolesAdded++;
      }
    }

    // Remove stale managed roles
    for (const role of discordMember.roles.cache.values()) {
      if (isManagedRole(role.id) && !expectedRanks.has(role.name)) {
        console.log(`[sync] Removing stale role "${role.name}" from ${discordMember.user.tag}`);
        await discordMember.roles.remove(role);
        console.log(`[sync] Removed role "${role.name}" from ${discordMember.user.tag}`);
        rolesRemoved++;
      }
    }

    // Always ensure nickname matches the correct handle
    if (nicknameMismatch) {
      await updateNickname(guild, discordMember, correctName);
    }

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

    // If already claimed and member is in guild, ensure nickname is correct then skip.
    // (Role updates are handled by processVerifiedUsers — this only catches stale nicknames.)
    const existingId = getUserByHandle(rsiName);
    if (existingId && guild.members.cache.has(existingId)) {
      const existingMember = guild.members.cache.get(existingId);
      if (existingMember && existingMember.displayName !== rsiName) {
        console.log(`[NICKNAME FIX] ${existingMember.user.tag}: nickname "${existingMember.displayName}" → "${rsiName}"`);
        await updateNickname(guild, existingMember, rsiName);
      } else {
        console.log(`[SKIP - ALREADY CORRECT] ${existingMember?.user.tag} → ${rsiName}`);
      }
      continue;
    }

    // Build candidates using STRICT two-part rule + fallback tier
    const candidates = [];
    guild.members.cache.forEach((member) => {
      if (member.user.bot) return;

      console.log('[SCAN MEMBER]', { username: member.user.username, display: member.displayName });

      // Skip locked users — admin has confirmed their identity
      if (isLocked(member.id)) {
        console.log(`[LOCKED USER - SKIPPED] ${member.user.username}`);
        return;
      }

      // Froxie-specific detection
      if (
        member.user.username.toLowerCase().includes('froxie') ||
        (member.displayName || '').toLowerCase().includes('froxie')
      ) {
        console.log('[FROXIE FOUND IN DISCORD]', { username: member.user.username, display: member.displayName });
      }

      // Exclude members already linked to a different RSI identity
      const existingLink = getUser(member.id);
      if (existingLink && existingLink.toLowerCase() !== rsiName.toLowerCase()) {
        console.log('[SKIP REASON]', { user: member.user.username, reason: 'already linked', linkedTo: existingLink });
        return;
      }

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
      if (displayScore < 0.6 && usernameScore < 0.6) {
        console.log(`[REJECTED - LOW MATCH] ${member.user.username} vs RSI: ${rsiName}`);
        return;
      }

      // Strict match: string overlap AND strong score
      const hasStringMatch = (
        displayClean === rsiClean ||
        usernameClean === rsiClean ||
        (displayClean.length >= 3 && displayClean.includes(rsiClean)) ||
        (rsiClean.length >= 3 && rsiClean.includes(displayClean))
      );
      const hasStrongScore = displayScore >= 0.75 || usernameScore >= 0.8;

      if (hasStringMatch && hasStrongScore) {
        candidates.push({ discordId: member.id, discordMember: member, usernameScore, displayScore, isFallback: false });
        console.log('[CANDIDATE FOUND]', {
          rsi: rsiName,
          user: member.user.username,
          display: member.displayName,
          usernameScore: usernameScore.toFixed(3),
          displayScore: displayScore.toFixed(3),
        });
        console.log('[CANDIDATE ADDED]', { rsi: rsiName, user: member.user.username });
        return;
      }

      // Fallback match: weaker score, no string overlap required — won't auto-link but stays in pool
      if (displayScore >= 0.65 || usernameScore >= 0.7) {
        candidates.push({ discordId: member.id, discordMember: member, usernameScore, displayScore, isFallback: true });
        console.log('[FALLBACK MATCH]', {
          rsi: rsiName,
          user: member.user.username,
          display: member.displayName,
          usernameScore: usernameScore.toFixed(3),
          displayScore: displayScore.toFixed(3),
        });
        console.log('[CANDIDATE ADDED]', { rsi: rsiName, user: member.user.username, fallback: true });
      }
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
      console.log(`[SKIP LINK - NOT STRONG ENOUGH] RSI: ${rsiName} — displayScore: ${winner.displayScore.toFixed(2)}, usernameScore: ${winner.usernameScore.toFixed(2)}`);
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

async function detectSuspiciousIdentities(guild, freshMembers, verifiedUsers, channel) {
  const clean = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const suspicious = [];

  for (const [discordId, currentRsi] of Object.entries(verifiedUsers)) {
    const discordMember = guild.members.cache.get(discordId);
    if (!discordMember) continue;

    // Never touch locked users
    if (isLocked(discordId)) {
      console.log(`[LOCKED USER - SKIPPED] ${discordMember.user.tag} — suspicious detection skipped`);
      continue;
    }

    const usernameClean = clean(discordMember.user.username);
    const displayClean = clean(discordMember.displayName || '');

    for (const orgMember of freshMembers) {
      const otherRsi = orgMember.name;
      if (otherRsi.toLowerCase() === currentRsi.toLowerCase()) continue;

      const otherRsiClean = clean(otherRsi);
      const usernameScore = similarity(usernameClean, otherRsiClean);
      const displayScore = similarity(displayClean, otherRsiClean);
      const bestScore = Math.max(usernameScore, displayScore);

      if (bestScore < 0.8) continue;

      console.log('[SUSPICIOUS MATCH]', {
        user: discordMember.user.username,
        currentRSI: currentRsi,
        suspectedRSI: otherRsi,
        score: bestScore.toFixed(3),
      });

      if (bestScore >= 0.9) {
        // AUTO-CORRECT — score is very strong
        console.log(`[AUTO-CORRECT] ${discordMember.user.tag}: "${currentRsi}" → "${otherRsi}" (score: ${bestScore.toFixed(3)})`);

        removeUser(discordId);
        setUser(discordId, otherRsi);

        const orgMemberData = freshMembers.find((m) => m.name.toLowerCase() === otherRsi.toLowerCase());
        if (orgMemberData) await assignRanks(guild, discordMember, orgMemberData);
        await updateNickname(guild, discordMember, otherRsi);

        try {
          const dm = await discordMember.user.createDM();
          await dm.send(
            `✅ Your account has been automatically corrected to **${otherRsi}** because it strongly matches your Discord name.\n` +
            `If this is incorrect, please contact an admin.`
          );
        } catch (e) { /* silent */ }

        if (channel) {
          try {
            await channel.send(`⚠️ ${discordMember} was automatically corrected from **${currentRsi}** → **${otherRsi}**`);
          } catch (e) {}
        }

        suspicious.push({ discordMember, currentRsi, suspectedRsi: otherRsi, score: bestScore, autoCorrected: true });
      } else {
        // 0.8–0.9 — alert only, no auto-fix
        suspicious.push({ discordMember, currentRsi, suspectedRsi: otherRsi, score: bestScore, autoCorrected: false });

        if (channel) {
          try {
            await channel.send(
              `⚠️ Suspicious identity detected:\n` +
              `User: ${discordMember}\n` +
              `Currently linked as: **${currentRsi}**\n` +
              `But strongly matches: **${otherRsi}**\n` +
              `Manual review required.`
            );
          } catch (e) {
            console.warn(`[SUSPICIOUS] Could not send channel alert for ${discordMember.user.tag}`);
          }
        }

        try {
          const dm = await discordMember.user.createDM();
          await dm.send(`⚠️ You may be linked incorrectly. If your RSI name is **${otherRsi}**, please contact an admin.`);
        } catch (e) { /* silent */ }
      }

      break; // One action per user
    }
  }

  return suspicious;
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

  // Fetch ALL guild members — force: true bypasses cache and pulls fresh from Discord
  console.log('[SYNC] Fetching all guild members...');
  let members;
  try {
    members = await guild.members.fetch({ force: true });
  } catch (err) {
    console.error('[SYNC] Failed to fetch members:', err.message);
    return { error: `Failed to fetch Discord members: ${err.message}`, usersUpdated: 0, rolesAdded: 0, rolesRemoved: 0, rolesCreated: 0, autoLinked: [], needsReview: [], unmatched: [], conflictsResolved: 0, conflictsUnresolved: 0, suspiciousCount: 0 };
  }

  if (!members || members.size === 0) {
    throw new Error('Failed to fetch Discord members');
  }

  console.log('[SYNC] Total Discord members fetched:', members.size);
  console.log('[MEMBERS LIST]', members.filter(m => !m.user.bot).map(m => m.user.username).join(', '));

  if (members.size <= 3) {
    console.error('[CRITICAL] Only a few members loaded — check intents or bot permissions');
  } else if (members.size < 10) {
    console.warn('[WARNING] Low Discord member count:', members.size);
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

  // Scan verified users for suspicious identity matches
  const finalVerified = load();
  const suspicious = await detectSuspiciousIdentities(guild, freshMembers, finalVerified, channel);

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
    suspiciousCount: suspicious.length,
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
