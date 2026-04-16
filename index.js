const { Client, GatewayIntentBits, Events } = require('discord.js');
const config = require('./config');
const { scrapeOrgMembers } = require('./scraper');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

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

  // Add command handling here
});

client.login(config.token);
