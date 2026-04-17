const { similarity } = require('./fuzzy');
const { removeUser, setUser } = require('./users');
const { isManagedRole } = require('./roles');
const { updateNickname } = require('./nicknames');

// Persists across sync runs so !conflicts can display them
// Map: rsiName → [{ discordId, discordTag, signals }]
const unresolvedConflicts = new Map();

function hasCorrectRole(discordMember, rsiName, freshMembers, guild) {
  const orgMember = freshMembers.find(
    (m) => m.name.toLowerCase() === rsiName.toLowerCase()
  );
  if (!orgMember) return false;
  const ranks = orgMember.rank.split(',').map((r) => r.trim()).filter(Boolean);
  return ranks.some((rankName) => {
    const role = guild.roles.cache.find((r) => r.name === rankName);
    return role && discordMember.roles.cache.has(role.id);
  });
}

const clean = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Build a signals object for a candidate — used for sorting and logging
function getSignals(discordMember, rsiName, verifiedUsers, freshMembers, guild) {
  const rsiClean = clean(rsiName);
  console.log('[CLEAN TEST]', { original: rsiName, cleaned: rsiClean });
  const usernameSim = similarity(clean(discordMember?.user?.username), rsiClean);
  const displaySim = similarity(clean(discordMember?.displayName), rsiClean);
  return {
    discordId: discordMember.id,
    discordTag: discordMember.user.tag,
    isVerified: verifiedUsers[discordMember.id]?.toLowerCase() === rsiName.toLowerCase(),
    usernameSim: Math.max(usernameSim, displaySim),
    joinedAt: discordMember.joinedTimestamp || Infinity,
    hasCorrectRole: hasCorrectRole(discordMember, rsiName, freshMembers, guild),
  };
}

// Priority-based comparator (lower return value = higher priority = more likely real user)
function compareByPriority(a, b) {
  // P1: already verified in users.json
  if (a.isVerified !== b.isVerified) return a.isVerified ? -1 : 1;

  // P2: username (not nickname) similarity to RSI name
  const simDiff = b.usernameSim - a.usernameSim;
  if (Math.abs(simDiff) > 0.05) return simDiff > 0 ? 1 : -1;

  // P3: joined server earlier
  if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;

  // P4: already has the correct RSI role
  if (a.hasCorrectRole !== b.hasCorrectRole) return a.hasCorrectRole ? -1 : 1;

  return 0; // true tie — cannot determine winner
}

// A clear winner exists only if the top candidate beats the second on at least P1 or P2
function hasClearWinner(ranked) {
  const [top, second] = ranked;
  if (top.isVerified !== second.isVerified) return true;
  if (Math.abs(top.usernameSim - second.usernameSim) > 0.05) return true;
  return false;
}

async function handleImposter(guild, discordMember, rsiName) {
  // A) Remove from users.json by ID
  removeUser(discordMember.id);

  // B) Remove all bot-managed roles
  for (const role of discordMember.roles.cache.values()) {
    if (isManagedRole(role.id)) {
      try {
        await discordMember.roles.remove(role);
      } catch (err) {
        console.warn(`[SECURITY] Could not remove role "${role.name}" from ${discordMember.user.tag}: ${err.message}`);
      }
    }
  }

  // C) Rename nickname to ⚠️ Unverified (regardless of current nickname)
  try {
    await discordMember.setNickname('⚠️ Unverified', 'Conflict resolution — imposter detected');
  } catch (err) {
    console.warn(`[SECURITY] Could not rename ${discordMember.user.tag}: ${err.message}`);
  }

  // D) Send warning DM
  try {
    const dm = await discordMember.user.createDM();
    await dm.send(
      `⚠️ Your account was linked to an RSI identity that belongs to another user.\n` +
      `Your roles have been removed.\n\n` +
      `If this is incorrect, please contact an admin.\n` +
      `Repeated conflicts may result in removal from the server and organization.`
    );
  } catch (err) {
    console.warn(`[SECURITY] Could not DM ${discordMember.user.tag}: ${err.message}`);
  }
}

async function resolveConflicts(guild, freshMembers, verifiedUsers, options = {}) {
  const { assignRanks = null, channel = null } = options;
  console.log('[REVALIDATION] Checking existing verified users...');
  unresolvedConflicts.clear();

  // Build RSI handle → [discordId, ...] map from ALL verified users
  const rsiToIds = {};
  for (const [discordId, rsiHandle] of Object.entries(verifiedUsers)) {
    const key = rsiHandle.toLowerCase();
    if (!rsiToIds[key]) rsiToIds[key] = [];
    rsiToIds[key].push(discordId);
  }

  let resolved = 0;
  let unresolved = 0;

  for (const [rsiNameLower, verifiedIds] of Object.entries(rsiToIds)) {
    const rsiName =
      freshMembers.find((m) => m.name.toLowerCase() === rsiNameLower)?.name ||
      rsiNameLower;

    console.log(`[REVALIDATION] Re-evaluating users for RSI: ${rsiName}`);

    // Start with all currently verified claimants
    const candidateMap = new Map();

    for (const discordId of verifiedIds) {
      const discordMember = guild.members.cache.get(discordId);
      if (!discordMember) continue;
      candidateMap.set(discordId, discordMember);
    }

    if (candidateMap.size === 0) continue;

    // Debug: log ALL candidates above 0.4 similarity for this RSI name
    const rsiClean = clean(rsiName);
    guild.members.cache.forEach((member) => {
      const username = member.user.username;
      const displayName = member.displayName || '';
      console.log('[SCAN]', username, displayName);
      const usernameScore = similarity(clean(username), rsiClean);
      const nicknameScore = similarity(clean(displayName), rsiClean);
      if (usernameScore > 0.4 || nicknameScore > 0.4) {
        console.log('[CANDIDATE FOUND]');
        console.log('RSI:', rsiName);
        console.log('User:', username);
        console.log('DisplayName:', displayName);
        console.log('Scores:', { usernameScore: usernameScore.toFixed(3), nicknameScore: nicknameScore.toFixed(3) });
      }
    });

    // Scan all guild members for unverified challengers via normalized similarity
    const lowestVerifiedSim = Math.min(
      ...Array.from(candidateMap.values()).map((m) =>
        similarity(clean(m?.user?.username), rsiClean)
      )
    );

    for (const [discordId, discordMember] of guild.members.cache) {
      if (discordMember.user.bot) continue;
      if (candidateMap.has(discordId)) continue;

      const usernameClean = clean(discordMember.user.username);
      const displayClean = clean(discordMember.displayName || '');
      const usernameSim = similarity(usernameClean, rsiClean);
      const displaySim = similarity(displayClean, rsiClean);
      const bestSim = Math.max(usernameSim, displaySim);

      // Only flag as a challenger if very close AND beats the weakest claimant
      if (bestSim >= 0.85 && bestSim > lowestVerifiedSim) {
        candidateMap.set(discordId, discordMember);
      }
    }

    // No challengers — verified user unchallenged, move on
    if (candidateMap.size < 2) continue;

    // Build signals for each candidate
    const ranked = Array.from(candidateMap.values())
      .map((discordMember) => getSignals(discordMember, rsiName, verifiedUsers, freshMembers, guild))
      .sort(compareByPriority);

    console.log(`[ID CHECK] Comparing users for RSI: ${rsiName}`);
    for (const s of ranked) {
      console.log(
        `  - ID: ${s.discordId} (${s.discordTag}) | verified: ${s.isVerified} | ` +
        `usernameSim: ${s.usernameSim.toFixed(2)} | joined: ${new Date(s.joinedAt).toISOString().slice(0, 10)} | ` +
        `hasRole: ${s.hasCorrectRole}`
      );
    }

    if (!hasClearWinner(ranked)) {
      console.log(`[ID CHECK] No clear winner for "${rsiName}" — flagging for manual review`);
      unresolvedConflicts.set(rsiName, ranked.map((s) => ({
        discordId: s.discordId,
        discordTag: s.discordTag,
        signals: {
          verified: s.isVerified,
          usernameSim: s.usernameSim.toFixed(2),
          joinedAt: new Date(s.joinedAt).toISOString().slice(0, 10),
          hasRole: s.hasCorrectRole,
        },
      })));
      unresolved++;
      continue;
    }

    const [real, ...imposters] = ranked;

    console.log(`[FINAL] Winner: ${real.discordTag}`);
    console.log(`[FINAL] Impostors: ${imposters.map((i) => i.discordTag).join(', ') || 'none'}`);

    // --- Auto-link and verify the real user ---
    const realMember = guild.members.cache.get(real.discordId);
    if (realMember) {
      setUser(real.discordId, rsiName);
      const orgMember = freshMembers.find((m) => m.name.toLowerCase() === rsiNameLower);
      if (orgMember && assignRanks) {
        await assignRanks(guild, realMember, orgMember);
      }
      await updateNickname(guild, realMember, rsiName);
      console.log(`[AUTO-LINK] Real user verified: ${realMember.user.tag}`);

      // Notify winner via DM
      try {
        const dm = await realMember.user.createDM();
        await dm.send(
          `✅ You have been automatically verified as **${rsiName}** and your roles have been assigned.`
        );
      } catch (e) {
        console.warn(`[DM FAILED] Could not DM winner ${realMember.user.tag}`);
      }
    }

    // --- Handle each impostor ---
    for (const imposter of imposters) {
      const discordMember = guild.members.cache.get(imposter.discordId);
      if (!discordMember) continue;
      console.log(`[ID CHECK] Imposter: ${imposter.discordId} (${imposter.discordTag})`);
      await handleImposter(guild, discordMember, rsiName);

      // Public channel warning
      if (channel) {
        try {
          await channel.send(
            `⚠️ ${discordMember} was removed from an incorrect RSI identity (**${rsiName}**).`
          );
        } catch (e) {
          console.warn(`[CHANNEL WARN] Could not send public warning for ${discordMember.user.tag}`);
        }
      }
    }

    resolved++;
  }

  return { resolved, unresolved };
}

module.exports = { resolveConflicts, unresolvedConflicts };
