const { Client, GatewayIntentBits, Events } = require('discord.js');
const config = require('./config');
const { scrapeOrgMembers } = require('./scraper');
const { load, setUser, getUser } = require('./users');
const { syncRoles, assignRoleToMember } = require('./roles');
const { findBestMatch } = require('./fuzzy');
const { runSync, scheduleWeeklySync } = require('./sync');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Shared reference so sync.js can update the cache
const membersRef = { members: [] };

// Pending fuzzy confirmations: discordId → { suggestedName, orgMember }
const pendingConfirmations = new Map();

async function completeVerification(message, rsiHandle, orgMember) {
  setUser(message.author.id, rsiHandle);

  if (orgMember && message.guild) {
    try {
      const discordMember = await message.guild.members.fetch(message.author.id);
      const ranks = orgMember.rank.split(',').map((r) => r.trim()).filter(Boolean);

      for (const rank of ranks) {
        await assignRoleToMember(message.guild, discordMember, rank);
      }

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

    scheduleWeeklySync(guild, membersRef);
  } catch (err) {
    console.error('[startup] Failed:', err.message);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  // !ping
  if (content === '!ping') {
    return message.reply('pong');
  }

  // !sync — manual sync trigger
  if (content === '!sync') {
    if (!message.guild) return message.reply('This command must be used in a server.');

    await message.reply('Syncing org members and roles, please wait...');

    try {
      const summary = await runSync(message.guild, membersRef);

      if (summary.error) {
        return message.reply(`Sync failed: ${summary.error}`);
      }

      const unmatchedList = summary.unmatched.length
        ? `\n**Unmatched:** ${summary.unmatched.map((u) => `\`${u.rsiHandle}\` (${u.reason})`).join(', ')}`
        : '';

      const reviewList = summary.needsReview.length
        ? `\n**Needs review:** ${summary.needsReview.map((u) => `\`${u.discordTag}\` → \`${u.rsiHandle}\` (${u.score}%)`).join(', ')}`
        : '';

      return message.reply(
        `Sync complete!\n` +
        `**Users updated:** ${summary.usersUpdated}\n` +
        `**Roles added:** ${summary.rolesAdded}\n` +
        `**Roles removed:** ${summary.rolesRemoved}\n` +
        `**Auto-linked:** ${summary.autoLinked.length}\n` +
        `**Needs review:** ${summary.needsReview.length}` +
        unmatchedList +
        reviewList
      );
    } catch (err) {
      console.error('[sync] Unexpected error:', err.message);
      return message.reply('Sync failed due to an unexpected error. Check the logs.');
    }
  }

  // Handle pending fuzzy confirmation (yes/no)
  if (pendingConfirmations.has(message.author.id)) {
    const answer = content.toLowerCase();

    if (answer === 'yes' || answer === 'y') {
      const { suggestedName, orgMember } = pendingConfirmations.get(message.author.id);
      pendingConfirmations.delete(message.author.id);
      return completeVerification(message, suggestedName, orgMember);
    }

    if (answer === 'no' || answer === 'n') {
      pendingConfirmations.delete(message.author.id);
      return message.reply('Verification cancelled. Please try `!verify <RSI_HANDLE>` again with the correct name.');
    }
  }

  // !verify <RSI_HANDLE>
  if (content.startsWith('!verify ')) {
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
    const fuzzy = findBestMatch(rsiHandle, names);

    if (fuzzy) {
      const orgMember = membersRef.members.find((m) => m.name === fuzzy.match);
      pendingConfirmations.set(message.author.id, { suggestedName: fuzzy.match, orgMember });
      return message.reply(
        `No exact match found for \`${rsiHandle}\`. Did you mean **${fuzzy.match}**? Reply \`yes\` or \`no\`.`
      );
    }

    // No match — still save the handle without role
    return completeVerification(message, rsiHandle, null);
  }

  // !whoami
  if (content === '!whoami') {
    const rsiHandle = getUser(message.author.id);

    if (!rsiHandle) {
      return message.reply('You have not verified yet. Use `!verify <RSI_HANDLE>` to link your account.');
    }

    return message.reply(`Your linked RSI handle is: \`${rsiHandle}\``);
  }
});

client.login(config.token);
