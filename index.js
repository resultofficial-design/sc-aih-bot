console.log("=== THIS IS THE NEW BOT VERSION ===");
const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
} = require('discord.js');
const config = require('./config');
const { scrapeOrgMembers } = require('./scraper');
const { load, setUser, getUser, getUserByHandle, removeUser } = require('./users');
const { lockUser, unlockUser, isLocked } = require('./locked');
const { blockUser, unblockUser, isBlocked, incrementAttempts } = require('./blocked');
const { syncRoles, assignRoleToMember } = require('./roles');
const { findBestMatchRaw, similarity } = require('./fuzzy');
const { runSync, scheduleWeeklySync } = require('./sync');
const { updateNickname, addOptOut, removeOptOut } = require('./nicknames');
const { unresolvedConflicts } = require('./conflicts');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // REQUIRED to fetch all server members
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// Shared reference so sync.js can update the cache
const membersRef = { members: [] };

// Pending channel confirmations (!verify fuzzy): discordId → { suggestedName, orgMember }
const pendingConfirmations = new Map();

// Pending DM confirmations (auto-match from sync): discordId → { rsiHandle, orgMember, guildId }
const pendingDmConfirmations = new Map();

// Pending onboarding flow: discordId → { state: 'awaiting_handle'|'awaiting_confirm', guildId, handle?, orgMember? }
const pendingOnboarding = new Map();

// Prevent concurrent !sync runs
let isSyncing = false;

// --- Helper: find an admin/log channel in a guild ---
function findAdminChannel(guild) {
  const names = ['admin-log', 'bot-log', 'admin-logs', 'bot-logs', 'admin', 'bot-commands'];
  for (const name of names) {
    const ch = guild.channels.cache.find(
      (c) => c.name === name && c.isTextBased()
    );
    if (ch) return ch;
  }
  return null;
}

// --- Helper: clean string for similarity comparison ---
const clean = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// --- Start onboarding DM flow for a new guild member ---
async function startOnboarding(member) {
  if (isBlocked(member.id)) {
    console.log(`[JOIN FLOW] ${member.user.tag} is blocked — skipping onboarding`);
    return;
  }
  if (isLocked(member.id)) {
    console.log(`[JOIN FLOW] ${member.user.tag} is locked — skipping onboarding`);
    return;
  }

  try {
    const dm = await member.user.createDM();
    await dm.send(
      `👋 Welcome to the server!\n\n` +
      `To receive your org roles, please type your **RSI handle** (your Star Citizen username).\n\n` +
      `Example: if your profile URL is \`robertsspaceindustries.com/citizens/CitizenKane\`, type \`CitizenKane\``
    );
    pendingOnboarding.set(member.id, { state: 'awaiting_handle', guildId: member.guild.id });
    console.log(`[JOIN FLOW] Onboarding DM sent to ${member.user.tag}`);
  } catch (err) {
    console.warn(`[JOIN FLOW] Could not DM ${member.user.tag}: ${err.message}`);
  }
}

// --- Handle handle input during onboarding ---
async function handleOnboardingInput(message, handle) {
  const discordId = message.author.id;
  const session = pendingOnboarding.get(discordId);
  if (!session) return;

  const { guildId } = session;
  console.log(`[USER INPUT] ${message.author.tag} typed handle: "${handle}"`);

  // Find org member by handle (case-insensitive, check both handle and name fields)
  const orgMember = membersRef.members.find(
    (m) => (m.handle || m.name).toLowerCase() === handle.toLowerCase()
  );

  if (!orgMember) {
    console.log(`[HANDLE INVALID] "${handle}" not found in org`);
    return message.reply(
      `❌ Handle \`${handle}\` was not found in the org roster.\n` +
      `Please check your spelling and try again. Use your RSI handle (not your display name).`
    );
  }

  console.log(`[HANDLE VALID] "${handle}" found in org (rank: ${orgMember.rank})`);

  // Anti-impostor check: Discord username similarity to claimed handle
  const score = similarity(clean(message.author.username), clean(handle));
  console.log(`[IMPOSTOR CHECK] ${message.author.username} vs handle "${handle}": score ${score.toFixed(2)}`);

  if (score < 0.4) {
    const attempts = incrementAttempts(discordId);
    console.log(`[IMPOSTOR WARNING] ${message.author.tag} claimed "${handle}" (score: ${score.toFixed(2)}) — attempt ${attempts}`);

    if (attempts >= 3) {
      blockUser(discordId);
      pendingOnboarding.delete(discordId);
      console.log(`[USER BLOCKED] ${message.author.tag} blocked after ${attempts} suspicious attempts`);

      try {
        await message.reply(
          `🚫 You have been blocked from verification due to repeated suspicious attempts.\n` +
          `Please contact a server admin if you believe this is an error.`
        );
      } catch (e) { /* silent */ }

      // Alert admin channel
      try {
        const guild = await client.guilds.fetch(guildId);
        const adminCh = findAdminChannel(guild);
        if (adminCh) {
          await adminCh.send(
            `🚨 **User blocked from verification**\n` +
            `User: <@${discordId}> (${message.author.tag})\n` +
            `Claimed handle: \`${handle}\`\n` +
            `Similarity score: ${score.toFixed(2)} after **${attempts}** attempts`
          );
        }
      } catch (e) {
        console.warn(`[JOIN FLOW] Could not send admin alert: ${e.message}`);
      }

      return;
    }

    return message.reply(
      `⚠️ Your Discord username doesn't look similar to the handle \`${handle}\`.\n` +
      `If this is genuinely your RSI handle, please contact a server admin.\n` +
      `Attempts before block: **${3 - attempts}** remaining`
    );
  }

  // Check if handle is already claimed by someone else
  const resolvedHandle = orgMember.handle || orgMember.name;
  const existingOwner = getUserByHandle(resolvedHandle);
  if (existingOwner && existingOwner !== discordId) {
    return message.reply(
      `❌ That RSI handle is already linked to another Discord account.\n` +
      `Please contact a server admin if you believe this is an error.`
    );
  }

  // Ask for confirmation with YES/NO buttons
  pendingOnboarding.set(discordId, { state: 'awaiting_confirm', guildId, handle: resolvedHandle, orgMember });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`onboard_yes_${discordId}`)
      .setLabel("Yes, that's me!")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`onboard_no_${discordId}`)
      .setLabel('No, different handle')
      .setStyle(ButtonStyle.Danger)
  );

  await message.reply({
    content:
      `✅ Found **${resolvedHandle}** in the org (rank: **${orgMember.rank}**).\n\n` +
      `Is this your RSI account?`,
    components: [row],
  });
}

async function completeVerification(message, rsiHandle, orgMember) {
  // Block if this RSI handle is already claimed by a different Discord user
  const existingOwner = getUserByHandle(rsiHandle);
  if (existingOwner && existingOwner !== message.author.id) {
    console.log(`[verify] Handle "${rsiHandle}" already claimed by Discord ID ${existingOwner} — blocking ${message.author.tag}`);
    return message.reply(`That RSI handle is already linked to another account. Please contact a server admin.`);
  }

  setUser(message.author.id, rsiHandle);

  if (orgMember && message.guild) {
    try {
      const discordMember = await message.guild.members.fetch(message.author.id);
      const ranks = orgMember.rank.split(',').map((r) => r.trim()).filter(Boolean);

      for (const rank of ranks) {
        await assignRoleToMember(message.guild, discordMember, rank);
      }

      await updateNickname(message.guild, discordMember, rsiHandle);

      return message.reply(
        `Verified! RSI handle \`${rsiHandle}\` linked and role(s) **${ranks.join(', ')}** assigned.`
      );
    } catch (err) {
      console.error('[verify] Role assignment failed:', err.message);
    }
  }

  return message.reply(`Verified! Your RSI handle \`${rsiHandle}\` has been linked to your Discord account.`);
}

// ─── ClientReady ────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  const users = load();
  console.log(`[users] Loaded ${Object.keys(users).length} verified user(s).`);

  try {
    console.log('[scraper] Fetching org members...');
    membersRef.members = await scrapeOrgMembers(config.orgName);
    console.log(`[scraper] Found ${membersRef.members.length} members.`);

    const guild = await readyClient.guilds.fetch(config.guildId);
    await guild.roles.fetch();
    await syncRoles(guild, membersRef.members);

    scheduleWeeklySync(guild, membersRef, pendingDmConfirmations);
  } catch (err) {
    console.error('[startup] Failed:', err.message);
  }
});

// ─── GuildMemberAdd ──────────────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  console.log(`[JOIN FLOW START] ${member.user.tag} joined the server`);

  if (member.user.bot) return;

  if (isBlocked(member.id)) {
    console.log(`[JOIN FLOW] ${member.user.tag} is blocked — skipping`);
    return;
  }

  if (isLocked(member.id)) {
    console.log(`[JOIN FLOW] ${member.user.tag} is locked — skipping`);
    return;
  }

  // Already verified
  const existing = getUser(member.id);
  if (existing) {
    console.log(`[JOIN FLOW] ${member.user.tag} already linked to "${existing}" — skipping onboarding`);
    return;
  }

  if (membersRef.members.length === 0) {
    console.warn('[JOIN FLOW] No org members cached yet — cannot auto-match');
    return startOnboarding(member);
  }

  // Try auto-match: compare Discord username against RSI handles
  const usernameClean = clean(member.user.username);
  const displayClean = clean(member.displayName || '');

  let bestMatch = null;
  let bestScore = 0;

  for (const orgMember of membersRef.members) {
    const handleClean = clean(orgMember.handle || orgMember.name);
    const userSim = similarity(usernameClean, handleClean);
    const displaySim = similarity(displayClean, handleClean);
    const score = Math.max(userSim, displaySim);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = orgMember;
    }
  }

  if (bestScore >= 0.8 && bestMatch) {
    const handle = bestMatch.handle || bestMatch.name;
    console.log(`[AUTO MATCH FOUND] ${member.user.tag} → RSI: ${handle} (score: ${bestScore.toFixed(2)})`);

    // Check handle isn't already claimed by another Discord user
    const claimed = getUserByHandle(handle);
    if (claimed && claimed !== member.id) {
      console.log(`[JOIN FLOW] Handle "${handle}" already claimed by ${claimed} — starting manual onboarding`);
      return startOnboarding(member);
    }

    setUser(member.id, handle);

    try {
      const ranks = bestMatch.rank.split(',').map((r) => r.trim()).filter(Boolean);
      for (const rank of ranks) {
        await assignRoleToMember(member.guild, member, rank);
      }
      await updateNickname(member.guild, member, handle);
    } catch (err) {
      console.error('[JOIN FLOW] Role/nickname update failed:', err.message);
    }

    try {
      const dm = await member.user.createDM();
      await dm.send(
        `✅ Welcome! You've been automatically verified as **${handle}** and your org roles have been assigned.`
      );
    } catch (e) { /* silent */ }

    return;
  }

  // No strong auto-match — start interactive onboarding
  console.log(`[JOIN FLOW] No auto-match for ${member.user.tag} (best score: ${bestScore.toFixed(2)}) — starting onboarding`);
  await startOnboarding(member);
});

// ─── InteractionCreate (button presses) ─────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const { customId } = interaction;
  if (!customId.startsWith('onboard_yes_') && !customId.startsWith('onboard_no_')) return;

  const targetId = customId.split('_')[2];

  if (interaction.user.id !== targetId) {
    return interaction.reply({ content: 'This button is not for you.', ephemeral: true });
  }

  const session = pendingOnboarding.get(targetId);
  if (!session || session.state !== 'awaiting_confirm') {
    return interaction.reply({ content: 'This confirmation has expired. Please re-type your RSI handle.', ephemeral: true });
  }

  if (customId.startsWith('onboard_no_')) {
    // Reset to awaiting_handle so they can try again
    pendingOnboarding.set(targetId, { state: 'awaiting_handle', guildId: session.guildId });
    return interaction.update({
      content: `No problem! Please type your correct RSI handle in this DM.`,
      components: [],
    });
  }

  // YES — complete verification
  const { handle, orgMember, guildId } = session;
  pendingOnboarding.delete(targetId);
  console.log(`[VERIFIED SUCCESS] ${interaction.user.tag} confirmed RSI handle: ${handle}`);

  setUser(targetId, handle);

  try {
    const guild = await client.guilds.fetch(guildId);
    const discordMember = await guild.members.fetch(targetId);
    const ranks = orgMember.rank.split(',').map((r) => r.trim()).filter(Boolean);
    for (const rank of ranks) {
      await assignRoleToMember(guild, discordMember, rank);
    }
    await updateNickname(guild, discordMember, handle);
  } catch (err) {
    console.error('[onboard] Role/nickname update failed:', err.message);
  }

  return interaction.update({
    content: `✅ You've been verified as **${handle}**! Welcome to the org — your roles have been assigned.`,
    components: [],
  });
});

// ─── MessageCreate ───────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  console.log('[DEBUG] messageCreate triggered:', message.content);

  const content = message.content.trim();
  const cmd = content.toLowerCase();
  const isDM = message.channel.type === ChannelType.DM;

  // ── Handle DM messages BEFORE the ! check ──────────────────────────────────

  if (isDM) {
    // Onboarding flow: user is expected to type their RSI handle (or maybe !verify)
    if (pendingOnboarding.has(message.author.id)) {
      const session = pendingOnboarding.get(message.author.id);
      if (session.state === 'awaiting_handle') {
        // Accept whatever they typed as a candidate handle (non-empty, non-command)
        if (content && !content.startsWith('!')) {
          return handleOnboardingInput(message, content.trim());
        }
      }
      // state === 'awaiting_confirm' — buttons handle it via InteractionCreate
    }

    // Sync auto-match confirmation: yes / no
    if (pendingDmConfirmations.has(message.author.id)) {
      const answer = content.toLowerCase();
      const { rsiHandle, orgMember, guildId } = pendingDmConfirmations.get(message.author.id);

      if (answer === 'yes' || answer === 'y') {
        pendingDmConfirmations.delete(message.author.id);
        setUser(message.author.id, rsiHandle);

        try {
          const guild = await client.guilds.fetch(guildId);
          const discordMember = await guild.members.fetch(message.author.id);
          const ranks = orgMember.rank.split(',').map((r) => r.trim()).filter(Boolean);

          for (const rank of ranks) {
            await assignRoleToMember(guild, discordMember, rank);
          }

          console.log(`[dm-confirm] Confirmed: ${message.author.tag} → RSI: ${rsiHandle}`);
          return message.reply(
            `Verified! RSI handle \`${rsiHandle}\` linked and role(s) **${ranks.join(', ')}** assigned in the server.`
          );
        } catch (err) {
          console.error('[dm-confirm] Role assignment failed:', err.message);
          return message.reply(`Linked as \`${rsiHandle}\`, but role assignment failed. Please contact an admin.`);
        }
      }

      if (answer === 'no' || answer === 'n') {
        pendingDmConfirmations.delete(message.author.id);
        console.log(`[dm-confirm] Rejected by ${message.author.tag} for RSI: ${rsiHandle}`);
        return message.reply('No problem! Use `!verify <RSI_HANDLE>` in the server if you want to link your account manually.');
      }

      return message.reply('Please reply with `yes` or `no`.');
    }

    // Ignore other DMs that aren't commands
    if (!content.startsWith('!')) return;

    // Fall through to handle !commands sent in DM (e.g. !verify)
  }

  // ── Guild-only: ignore non-commands ────────────────────────────────────────

  if (!isDM && !content.startsWith('!')) return;

  // ── Guild commands ──────────────────────────────────────────────────────────

  // !ping
  if (cmd === '!ping') {
    return message.reply('pong');
  }

  // !sync — manual sync trigger
  if (cmd === '!sync') {
    console.log('[DEBUG] Sync command detected');

    if (isDM) return message.reply('Use `!sync` in a server channel.');

    if (isSyncing) {
      return message.reply('⏳ Sync is already running. Please wait for it to finish.');
    }

    isSyncing = true;
    let startMessage = await message.reply('SYNC FROM NEW VERSION');
    let progressMessage = null;
    let syncDone = false;

    console.log('[SYNC] Timer started');
    const progressTimer = setTimeout(async () => {
      console.log('[SYNC] Timer fired');
      if (!syncDone) {
        try {
          progressMessage = await message.channel.send('Still running...');
        } catch (err) {
          console.log('Failed to send progress message:', err.message);
        }
      }
    }, 3000);

    const safeDelete = async (msg) => {
      if (!msg) return;
      try { await msg.delete(); } catch { /* already deleted or no permission */ }
    };

    const buildSummary = (summary, elapsedSec) => {
      const hasChanges =
        summary.usersUpdated > 0 ||
        summary.rolesAdded > 0 ||
        summary.rolesRemoved > 0 ||
        summary.rolesCreated > 0 ||
        summary.autoLinked.length > 0 ||
        summary.conflictsResolved > 0;

      const footer = `\n⏱ Completed in **${elapsedSec}s**`;

      if (!hasChanges) return `✅ Sync complete. No changes were needed.${footer}`;

      const lines = [
        '✅ **Sync complete**',
        '',
        `👥 Users processed: **${summary.usersUpdated}**`,
        `➕ Roles assigned:  **${summary.rolesAdded}**`,
        `➖ Roles removed:   **${summary.rolesRemoved}**`,
        `🆕 Roles created:   **${summary.rolesCreated}**`,
        `🔗 Auto-linked:     **${summary.autoLinked.length}**`,
      ];

      if (summary.needsReview.length > 0) {
        lines.push(`📨 DMs sent:        **${summary.needsReview.length}**`);
      }
      if (summary.unmatched.length > 0) {
        lines.push(`⚠️ Unmatched:       **${summary.unmatched.length}** — ${summary.unmatched.map((u) => `\`${u.rsiHandle}\` (${u.reason})`).join(', ')}`);
      }
      if (summary.conflictsResolved > 0) {
        lines.push(`🛡️ Conflicts fixed:  **${summary.conflictsResolved}**`);
      }
      if (summary.conflictsUnresolved > 0) {
        lines.push(`🔍 Needs review:    **${summary.conflictsUnresolved}** — use \`!conflicts\` for details`);
      }
      if (summary.suspiciousCount > 0) {
        lines.push(`🚨 Suspicious IDs:  **${summary.suspiciousCount}** — alerts sent above`);
      }

      lines.push(footer);
      return lines.join('\n');
    };

    try {
      console.log('Running sync function...');
      const syncStart = Date.now();
      const summary = await runSync(message.guild, membersRef, pendingDmConfirmations, message.channel);
      const elapsedSec = ((Date.now() - syncStart) / 1000).toFixed(1);

      syncDone = true;
      clearTimeout(progressTimer);

      await safeDelete(startMessage);
      await safeDelete(progressMessage);

      if (summary.error) {
        console.error(`[sync] Failed: ${summary.error}`);
        return message.reply(`❌ Sync failed: ${summary.error}`);
      }

      const reply = buildSummary(summary, elapsedSec);
      console.log(`[sync] ${reply.replace(/\*\*/g, '').replace(/[✅➕➖🆕🔗📨⚠️⏱👥]/g, '').trim()}`);
      return message.reply(reply);

    } catch (err) {
      syncDone = true;
      clearTimeout(progressTimer);

      await safeDelete(startMessage);
      await safeDelete(progressMessage);

      console.error('Sync error:', err);
      return message.reply(`Sync failed: ${err.message}`);
    } finally {
      isSyncing = false;
    }
  }

  // Handle pending fuzzy confirmation from !verify (yes/no in guild channel)
  if (pendingConfirmations.has(message.author.id)) {
    const answer = cmd;

    if (answer === 'yes' || answer === 'y') {
      const { suggestedName, orgMember } = pendingConfirmations.get(message.author.id);
      pendingConfirmations.delete(message.author.id);
      return completeVerification(message, suggestedName, orgMember);
    }

    if (answer === 'no' || answer === 'n') {
      pendingConfirmations.delete(message.author.id);
      return message.reply('Verification cancelled. Please try `!verify <RSI_HANDLE>` again with the correct name.');
    }

    // User issued a new !verify — clear old pending and let it proceed
    if (cmd.startsWith('!verify ')) {
      pendingConfirmations.delete(message.author.id);
    } else {
      return message.reply('Please reply with `yes` or `no`.');
    }
  }

  // !verify <RSI_HANDLE>
  if (cmd.startsWith('!verify ')) {
    const rsiHandle = content.slice('!verify '.length).trim();

    if (!rsiHandle) {
      return message.reply('Usage: `!verify <RSI_HANDLE>`');
    }

    // Exact match (check handle field first, then name)
    const exactMatch = membersRef.members.find(
      (m) => (m.handle || m.name).toLowerCase() === rsiHandle.toLowerCase()
    );

    if (exactMatch) {
      return completeVerification(message, exactMatch.handle || exactMatch.name, exactMatch);
    }

    // Fuzzy match against handles
    const handles = membersRef.members.map((m) => m.handle || m.name);
    const fuzzy = findBestMatchRaw(rsiHandle, handles);

    console.log(`[VERIFY] Best match: ${fuzzy?.match} Score: ${fuzzy?.score?.toFixed(3)}`);

    if (fuzzy && fuzzy.score >= 0.85) {
      const orgMember = membersRef.members.find((m) => (m.handle || m.name) === fuzzy.match);
      return completeVerification(message, fuzzy.match, orgMember);
    }

    if (fuzzy && fuzzy.score >= 0.7) {
      const orgMember = membersRef.members.find((m) => (m.handle || m.name) === fuzzy.match);
      pendingConfirmations.set(message.author.id, { suggestedName: fuzzy.match, orgMember });
      return message.reply(
        `No exact match found for \`${rsiHandle}\`. Did you mean **${fuzzy.match}**? Reply \`yes\` or \`no\`.`
      );
    }

    return message.reply(`RSI handle not found. Please check your spelling and try again.`);
  }

  // !conflicts — show unresolved identity conflicts
  if (cmd === '!conflicts') {
    if (isDM) return message.reply('Use `!conflicts` in a server channel.');
    if (unresolvedConflicts.size === 0) {
      return message.reply('✅ No unresolved identity conflicts.');
    }

    const lines = ['🔍 **Unresolved identity conflicts** (no clear winner — manual review needed):', ''];
    for (const [rsiName, candidates] of unresolvedConflicts) {
      lines.push(`**RSI: ${rsiName}**`);
      for (const c of candidates) {
        lines.push(
          `  • \`${c.discordId}\` ${c.discordTag} — ` +
          `verified: ${c.signals.verified} | sim: ${c.signals.usernameSim} | ` +
          `joined: ${c.signals.joinedAt} | role: ${c.signals.hasRole}`
        );
      }
    }
    return message.reply(lines.join('\n'));
  }

  // !help — list all commands
  if (cmd === '!help') {
    return message.reply([
      '🤖 **Bot Commands**',
      '',
      '🔹 `!sync` → Run full verification sync',
      '🔹 `!verify <RSI_HANDLE>` → Link your Discord to an RSI identity',
      '🔹 `!whoami` → Show your linked RSI handle',
      '🔹 `!lock @user` → Lock user (prevents future changes by the system)',
      '🔹 `!unlock @user` → Unlock user',
      '🔹 `!unblock @user` → Unblock user from verification (anti-impostor block)',
      '🔹 `!force @user RSI_NAME` → Manually assign RSI identity',
      '🔹 `!unlink @user` → Remove verification',
      '🔹 `!conflicts` → Show unresolved identity conflicts',
      '🔹 `!nonick` → Opt out of nickname sync',
      '🔹 `!yesnick` → Opt back in to nickname sync',
      '🔹 `!help` → Show this message',
    ].join('\n'));
  }

  // !lock @user — prevent system from touching this user
  if (cmd.startsWith('!lock ')) {
    const mentioned = message.mentions.members?.first();
    if (!mentioned) return message.reply('Usage: `!lock @user`');
    lockUser(mentioned.id);
    console.log(`[LOCK] ${message.author.tag} locked ${mentioned.user.tag}`);
    return message.reply(`🔒 ${mentioned} has been locked. The system will not auto-change their identity.`);
  }

  // !unlock @user — re-enable system management for this user
  if (cmd.startsWith('!unlock ')) {
    const mentioned = message.mentions.members?.first();
    if (!mentioned) return message.reply('Usage: `!unlock @user`');
    unlockUser(mentioned.id);
    console.log(`[UNLOCK] ${message.author.tag} unlocked ${mentioned.user.tag}`);
    return message.reply(`🔓 ${mentioned} has been unlocked.`);
  }

  // !unblock @user — clear anti-impostor block
  if (cmd.startsWith('!unblock ')) {
    const mentioned = message.mentions.members?.first();
    if (!mentioned) return message.reply('Usage: `!unblock @user`');
    unblockUser(mentioned.id);
    console.log(`[UNBLOCK] ${message.author.tag} unblocked ${mentioned.user.tag}`);
    return message.reply(`✅ ${mentioned} has been unblocked and can now verify again.`);
  }

  // !force @user RSI_NAME — admin manually assigns RSI identity
  if (cmd.startsWith('!force ')) {
    const mentioned = message.mentions.members?.first();
    if (!mentioned) return message.reply('Usage: `!force @user RSI_NAME`');
    const rsiName = content.slice('!force '.length).replace(/<@!?\d+>/g, '').trim();
    if (!rsiName) return message.reply('Usage: `!force @user RSI_NAME`');

    const orgMember = membersRef.members.find(
      (m) => (m.handle || m.name).toLowerCase() === rsiName.toLowerCase()
    );
    if (!orgMember) return message.reply(`RSI handle \`${rsiName}\` not found in org.`);

    const resolvedHandle = orgMember.handle || orgMember.name;
    setUser(mentioned.id, resolvedHandle);
    try {
      const discordMember = await message.guild.members.fetch(mentioned.id);
      const ranks = orgMember.rank.split(',').map((r) => r.trim()).filter(Boolean);
      for (const rank of ranks) {
        await assignRoleToMember(message.guild, discordMember, rank);
      }
      await updateNickname(message.guild, discordMember, resolvedHandle);
    } catch (err) {
      console.error('[force] Role/nickname update failed:', err.message);
    }
    console.log(`[FORCE] ${message.author.tag} linked ${mentioned.user.tag} → ${resolvedHandle}`);
    return message.reply(`✅ ${mentioned} has been forcefully linked to **${resolvedHandle}**.`);
  }

  // !unlink @user — remove RSI link from a user
  if (cmd.startsWith('!unlink ')) {
    const mentioned = message.mentions.members?.first();
    if (!mentioned) return message.reply('Usage: `!unlink @user`');
    const existing = getUser(mentioned.id);
    if (!existing) return message.reply(`${mentioned} is not currently linked to any RSI identity.`);
    removeUser(mentioned.id);
    console.log(`[UNLINK] ${message.author.tag} unlinked ${mentioned.user.tag} from ${existing}`);
    return message.reply(`✅ ${mentioned} has been unlinked from **${existing}**.`);
  }

  // !nonick — opt out of nickname sync
  if (cmd === '!nonick') {
    addOptOut(message.author.id);
    return message.reply('You have opted out of automatic nickname updates. Use `!yesnick` to re-enable.');
  }

  // !yesnick — opt back in
  if (cmd === '!yesnick') {
    removeOptOut(message.author.id);
    return message.reply('You have opted back in to automatic nickname updates.');
  }

  // !whoami
  if (cmd === '!whoami') {
    const rsiHandle = getUser(message.author.id);

    if (!rsiHandle) {
      return message.reply('You have not verified yet. Use `!verify <RSI_HANDLE>` to link your account.');
    }

    return message.reply(`Your linked RSI handle is: \`${rsiHandle}\``);
  }
});

client.login(config.token);
