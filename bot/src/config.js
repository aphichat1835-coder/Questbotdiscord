import 'dotenv/config';

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
