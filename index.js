console.log("=== THIS IS THE NEW BOT VERSION ===");
const { Client, GatewayIntentBits, Events, ChannelType } = require('discord.js');
const config = require('./config');
const { scrapeOrgMembers } = require('./scraper');
const { load, setUser, getUser, getUserByHandle } = require('./users');
const { syncRoles, assignRoleToMember } = require('./roles');
const { findBestMatchRaw } = require('./fuzzy');
const { runSync, scheduleWeeklySync } = require('./sync');
const { updateNickname, addOptOut, removeOptOut } = require('./nicknames');
const { unresolvedConflicts } = require('./conflicts');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
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

// Prevent concurrent !sync runs
let isSyncing = false;

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

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  console.log('[DEBUG] messageCreate triggered:', message.content);

  const content = message.content.trim();
  const cmd = content.toLowerCase();

  // Ignore messages that aren't commands
  if (!content.startsWith('!')) return;
  const isDM = message.channel.type === ChannelType.DM;

  // --- DM reply handler (auto-match confirmation from sync) ---
  if (isDM && pendingDmConfirmations.has(message.author.id)) {
    const answer = content.toLowerCase();
    const { rsiHandle, orgMember, guildId } = pendingDmConfirmations.get(message.author.id);

    if (answer === 'yes' || answer === 'y') {
      pendingDmConfirmations.delete(message.author.id);
      setUser(message.author.id, rsiHandle);

      // Assign roles in the guild
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

    // Unrecognised reply — re-prompt
    return message.reply('Please reply with `yes` or `no`.');
  }

  // Ignore DMs that aren't pending confirmations
  if (isDM) return;

  // --- Guild commands ---

  // !ping
  if (cmd === '!ping') {
    return message.reply('pong');
  }

  // !sync — manual sync trigger
  if (cmd === '!sync') {
    console.log('[DEBUG] Sync command detected');

    if (isSyncing) {
      return message.reply('⏳ Sync is already running. Please wait for it to finish.');
    }

    isSyncing = true;
    let startMessage = await message.reply('SYNC FROM NEW VERSION');
    let progressMessage = null;
    let syncDone = false;

    // Send "Still running..." only if sync takes longer than 3 seconds
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

      lines.push(footer);
      return lines.join('\n');
    };

    try {
      console.log('Running sync function...');
      const syncStart = Date.now();
      const summary = await runSync(message.guild, membersRef, pendingDmConfirmations);
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
      // Any other input while a confirmation is pending — re-prompt, do not fall through
      return message.reply('Please reply with `yes` or `no`.');
    }
  }

  // !verify <RSI_HANDLE>
  if (cmd.startsWith('!verify ')) {
    const rsiHandle = content.slice('!verify '.length).trim();

    if (!rsiHandle) {
      return message.reply('Usage: `!verify <RSI_HANDLE>`');
    }

    // Exact match
    const exactMatch = membersRef.members.find(
      (m) => m.name.toLowerCase() === rsiHandle.toLowerCase()
    );

    if (exactMatch) {
      return completeVerification(message, exactMatch.name, exactMatch);
    }

    // Fuzzy match
    const names = membersRef.members.map((m) => m.name);
    const fuzzy = findBestMatchRaw(rsiHandle, names);

    console.log(`[VERIFY] Best match: ${fuzzy?.match} Score: ${fuzzy?.score?.toFixed(3)}`);

    if (fuzzy && fuzzy.score >= 0.85) {
      // High confidence — auto-accept
      const orgMember = membersRef.members.find((m) => m.name === fuzzy.match);
      return completeVerification(message, fuzzy.match, orgMember);
    }

    if (fuzzy && fuzzy.score >= 0.7) {
      // Medium confidence — ask for confirmation
      const orgMember = membersRef.members.find((m) => m.name === fuzzy.match);
      pendingConfirmations.set(message.author.id, { suggestedName: fuzzy.match, orgMember });
      return message.reply(
        `No exact match found for \`${rsiHandle}\`. Did you mean **${fuzzy.match}**? Reply \`yes\` or \`no\`.`
      );
    }

    // No match
    return message.reply(`RSI handle not found. Please check your spelling and try again.`);
  }

  // !conflicts — show unresolved identity conflicts
  if (cmd === '!conflicts') {
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
