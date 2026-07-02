import 'dotenv/config';

const required = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'OWNER_ID'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

export const config = {
  token:          process.env.DISCORD_BOT_TOKEN,
  clientId:       process.env.DISCORD_CLIENT_ID,
  guildId:        process.env.DISCORD_GUILD_ID,
  ownerId:        process.env.OWNER_ID,
  timezone:       process.env.TIMEZONE ?? 'Asia/Bangkok',
  logChannelId:   process.env.LOG_CHANNEL_ID ?? '',
  managerRoleId:  process.env.MANAGER_ROLE_ID ?? '',
  databasePath:   process.env.DATABASE_PATH ?? './data/quests.db',
};
