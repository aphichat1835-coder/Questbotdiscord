import 'dotenv/config';

export const config = {
  token: process.env.DISCORD_BOT_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  ownerId: process.env.OWNER_ID,
  databasePath: process.env.DATABASE_PATH ?? './data/quests.json',
  timezone: process.env.TIMEZONE ?? 'Asia/Bangkok',
};
