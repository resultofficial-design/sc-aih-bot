const { Client, GatewayIntentBits, Events } = require('discord.js');
const config = require('./config');
const { scrapeOrgMembers } = require('./scraper');
const { load, setUser, getUser } = require('./users');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  const users = load();
  console.log(`[users] Loaded ${Object.keys(users).length} verified user(s).`);

  // Temporary scraper test
  try {
    console.log('[test] Running scraper...');
    const members = await scrapeOrgMembers(config.orgName);
    console.log('[test] Members:', members);
  } catch (err) {
    console.error('[test] Scraper failed:', err.message);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  // !ping
  if (content === '!ping') {
    return message.reply('pong');
  }

  // !verify <RSI_HANDLE>
  if (content.startsWith('!verify ')) {
    const rsiHandle = content.slice('!verify '.length).trim();

    if (!rsiHandle) {
      return message.reply('Usage: `!verify <RSI_HANDLE>`');
    }

    setUser(message.author.id, rsiHandle);
    return message.reply(`Verified! Your RSI handle \`${rsiHandle}\` has been linked to your Discord account.`);
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
