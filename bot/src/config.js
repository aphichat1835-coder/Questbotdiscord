import 'dotenv/config';

export const config = {
  token:      process.env.DISCORD_BOT_TOKEN,
  clientId:   process.env.DISCORD_CLIENT_ID,
  guildId:    process.env.DISCORD_GUILD_ID,
  ownerId:    process.env.OWNER_ID,
  timezone:   process.env.TIMEZONE ?? 'Asia/Bangkok',
  apiUrl:     process.env.API_URL ?? 'http://localhost:3000',
  apiSecret:  process.env.API_SECRET ?? '',
};
