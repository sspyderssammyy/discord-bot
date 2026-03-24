require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, Collection
} = require('discord.js');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── Keep Render happy ────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
http.createServer(app).listen(process.env.PORT || 3000, () => console.log('✅ Web server running'));

// ─── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Storage ──────────────────────────────────────────────────────────────────
const conversationHistory = new Map();
const warnings = new Map();
const updateLogs = new Map();
const spamTracker = new Map();
const xpData = new Map();
const xpCooldown = new Map();
const welcomeSettings = new Map();
const leaveSettings = new Map();
const autoResponses = new Map();
const ticketSettings = new Map();
const openTickets = new Map();
const giveaways = new Map();
const roleButtons = new Map();
const statsChannels = new Map();

const SWEAR_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'fag'];
const SPAM_THRESHOLD = 5;
const SPAM_WINDOW = 4000;
const XP_COOLDOWN = 60000;

// ─── System Prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a Discord bot assistant with a chill, gen z personality. You're like that one friend who's actually really smart but talks super casually.

Personality rules:
- Talk casually, use lowercase mostly, short sentences
- Be helpful but not robotic
- Use occasional gen z slang naturally (no cap, fr, lowkey, ngl, bussin, etc.) but don't overdo it
- Be funny when it fits but don't force it
- If someone's being rude, clap back a little but stay chill
- Don't use emojis unless it fits naturally

For Roblox/scripting help:
- Only go full dev mode if someone specifically asks about Roblox or scripting
- Use Luau for Roblox code, always explain why something works
- Be like a senior dev helping out a homie, not a textbook

For general chat:
- Just vibe and chat, you're not just a dev bot
- Give real opinions, don't be a yes-man
- Keep responses short unless they need detail`;

// ─── AI routing ───────────────────────────────────────────────────────────────
const CODE_KEYWORDS = [
  'script', 'code', 'bug', 'error', 'fix', 'function', 'luau', 'lua', 'roblox',
  'studio', 'module', 'remote', 'event', 'datastore', 'tween', 'raycast', 'loop',
  'table', 'array', 'string', 'variable', 'debug', 'review', 'optimize', 'class',
  'oop', 'bindable', 'javascript', 'python', 'typescript', 'java', 'rust', 'api',
  'server', 'client', 'exploit', 'anti', 'gui', 'frame', 'button', 'part', 'model'
];

function isTechnical(message) {
  const lower = message.toLowerCase();
  return CODE_KEYWORDS.some(k => lower.includes(k)) || /```/.test(message);
}

async function askGroqDirect(history) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
    max_tokens: 1500,
  });
  return response.choices[0].message.content;
}

async function askGeminiDirect(userMessage, history) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash', systemInstruction: SYSTEM_PROMPT });
  const geminiHistory = history.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const chat = model.startChat({ history: geminiHistory });
  const result = await chat.sendMessage(userMessage);
  return result.response.text();
}

async function askAI(userId, userMessage) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  const history = conversationHistory.get(userId);
  history.push({ role: 'user', content: userMessage });
  if (history.length > 30) history.splice(0, history.length - 30);
  let reply = null;
  if (isTechnical(userMessage)) {
    try { reply = await askGroqDirect(history); }
    catch { try { reply = await askGeminiDirect(userMessage, history); } catch { throw new Error('both ai providers are down rn'); } }
  } else {
    try { reply = await askGeminiDirect(userMessage, history); }
    catch { try { reply = await askGroqDirect(history); } catch { throw new Error('both ai providers are down rn'); } }
  }
  history.push({ role: 'assistant', content: reply });
  return reply;
}

function chunkMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > maxLength) { if (current) chunks.push(current); current = line; }
    else { current = current ? current + '\n' + line : line; }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ─── XP System ────────────────────────────────────────────────────────────────
function getXPForLevel(level) { return level * 100 * level; }

async function addXP(member, guild) {
  const userId = member.id;
  const now = Date.now();
  if (xpCooldown.has(userId) && now - xpCooldown.get(userId) < XP_COOLDOWN) return;
  xpCooldown.set(userId, now);
  if (!xpData.has(userId)) xpData.set(userId, { xp: 0, level: 1 });
  const data = xpData.get(userId);
  data.xp += 15 + Math.floor(Math.random() * 10);
  if (data.xp >= getXPForLevel(data.level)) {
    data.xp -= getXPForLevel(data.level);
    data.level++;
    const channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name.includes('general')) || guild.channels.cache.find(c => c.type === ChannelType.GuildText);
    if (channel) {
      const embed = new EmbedBuilder().setTitle('level up! 🎉').setDescription(`${member} just hit **level ${data.level}** no cap 🔥`).setColor(0xF1C40F).setThumbnail(member.user.displayAvatarURL());
      await channel.send({ embeds: [embed] });
    }
  }
}

// ─── Giveaway checker ────────────────────────────────────────────────────────
setInterval(async () => {
  const now = Date.now();
  for (const [msgId, giveaway] of giveaways.entries()) {
    if (now >= giveaway.endTime) {
      try {
        const guild = client.guilds.cache.get(giveaway.guildId);
        const channel = guild?.channels.cache.get(giveaway.channelId);
        const entries = [...giveaway.entries];
        if (entries.length === 0) {
          await channel?.send(`giveaway for **${giveaway.prize}** ended with no entries 😭`);
        } else {
          const winner = guild.members.cache.get(entries[Math.floor(Math.random() * entries.length)]);
          const embed = new EmbedBuilder().setTitle('🎉 Giveaway Ended!').setDescription(`**Prize:** ${giveaway.prize}\n**Winner:** ${winner}\ncongrats fr 🔥`).setColor(0xF1C40F);
          await channel?.send({ embeds: [embed] });
        }
      } catch (err) { console.error(err); }
      giveaways.delete(msgId);
    }
  }
}, 10000);

// ─── Stats updater ────────────────────────────────────────────────────────────
setInterval(async () => {
  for (const [guildId, stats] of statsChannels.entries()) {
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      if (stats.memberChannelId) await guild.channels.cache.get(stats.memberChannelId)?.setName(`👥 Members: ${guild.memberCount}`);
      if (stats.botChannelId) await guild.channels.cache.get(stats.botChannelId)?.setName(`🤖 Bots: ${guild.members.cache.filter(m => m.user.bot).size}`);
      if (stats.roleChannelId) await guild.channels.cache.get(stats.roleChannelId)?.setName(`🎭 Roles: ${guild.roles.cache.size}`);
    } catch (err) { console.error(err); }
  }
}, 300000);

// ─── Auto-mod ────────────────────────────────────────────────────────────────
function checkSpam(userId) {
  const now = Date.now();
  if (!spamTracker.has(userId)) spamTracker.set(userId, []);
  const timestamps = spamTracker.get(userId).filter(t => now - t < SPAM_WINDOW);
  timestamps.push(now);
  spamTracker.set(userId, timestamps);
  return timestamps.length >= SPAM_THRESHOLD;
}

function containsSwear(content) {
  return SWEAR_WORDS.some(word => content.toLowerCase().includes(word));
}

// ─── Update log ───────────────────────────────────────────────────────────────
async function askOwnerForUpdateLog(guild) {
  try {
    const owner = await guild.fetchOwner();
    const dm = await owner.createDM();
    await dm.send(`yo it's that time again 👋\n\nwhat's the update log for this week? just type it out and i'll post it in the server.`);
    const collected = await dm.awaitMessages({ filter: m => m.author.id === owner.id, max: 1, time: 86400000 });
    if (collected.size > 0) {
      const content = collected.first().content;
      if (!updateLogs.has(guild.id)) updateLogs.set(guild.id, []);
      updateLogs.get(guild.id).unshift({ content, date: new Date().toISOString() });
      const channel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && (c.name.includes('announcement') || c.name.includes('general') || c.name.includes('update'))) || guild.channels.cache.find(c => c.type === ChannelType.GuildText);
      if (channel) {
        await channel.send({ embeds: [new EmbedBuilder().setTitle('📋 Update Log').setDescription(content).setColor(0x5865F2).setTimestamp()] });
        await dm.send('posted it ✅');
      }
    }
  } catch (err) { console.error('Update log error:', err); }
}

function scheduleWeeklyUpdateLog(guild) {
  setInterval(() => askOwnerForUpdateLog(guild), 7 * 24 * 60 * 60 * 1000);
}

// ─── Register Commands ────────────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('ask').setDescription('chat with the AI').addStringOption(o => o.setName('message').setDescription('what do you wanna say?').setRequired(true)),
    new SlashCommandBuilder().setName('roblox').setDescription('get roblox / luau scripting help').addStringOption(o => o.setName('question').setDescription('your question').setRequired(true)),
    new SlashCommandBuilder().setName('review').setDescription('get your code reviewed or debugged').addStringOption(o => o.setName('code').setDescription('paste your code').setRequired(true)).addStringOption(o => o.setName('issue').setDescription('whats the issue?').setRequired(false)),
    new SlashCommandBuilder().setName('clear').setDescription('reset your chat history with the bot'),
    new SlashCommandBuilder().setName('help').setDescription('show all commands'),
    new SlashCommandBuilder().setName('serverinfo').setDescription('info about this server'),
    new SlashCommandBuilder().setName('userinfo').setDescription('info about a user').addUserOption(o => o.setName('user').setDescription('which user?').setRequired(false)),
    new SlashCommandBuilder().setName('rank').setDescription('check your rank').addUserOption(o => o.setName('user').setDescription('which user?').setRequired(false)),
    new SlashCommandBuilder().setName('leaderboard').setDescription('show the xp leaderboard'),
    new SlashCommandBuilder().setName('updatelog').setDescription('see the latest update logs'),
    new SlashCommandBuilder().setName('requestupdate').setDescription('(owner only) manually trigger the weekly update log DM').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('announce').setDescription('send an announcement').addStringOption(o => o.setName('message').setDescription('announcement content').setRequired(true)).addChannelOption(o => o.setName('channel').setDescription('which channel?').setRequired(false)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('poll').setDescription('create a poll').addStringOption(o => o.setName('question').setDescription('poll question').setRequired(true)).addStringOption(o => o.setName('option1').setDescription('option 1').setRequired(true)).addStringOption(o => o.setName('option2').setDescription('option 2').setRequired(true)).addStringOption(o => o.setName('option3').setDescription('option 3').setRequired(false)).addStringOption(o => o.setName('option4').setDescription('option 4').setRequired(false)),
    new SlashCommandBuilder().setName('setwelcome').setDescription('set the welcome channel and message').addChannelOption(o => o.setName('channel').setDescription('welcome channel').setRequired(true)).addStringOption(o => o.setName('message').setDescription('welcome message (use {user} and {server})').setRequired(false)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('setleave').setDescription('set the leave channel and message').addChannelOption(o => o.setName('channel').setDescription('leave channel').setRequired(true)).addStringOption(o => o.setName('message').setDescription('leave message (use {user} and {server})').setRequired(false)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('addresponse').setDescription('add an auto response').addStringOption(o => o.setName('trigger').setDescription('trigger word/phrase').setRequired(true)).addStringOption(o => o.setName('response').setDescription('what to respond with').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('removeresponse').setDescription('remove an auto response').addStringOption(o => o.setName('trigger').setDescription('trigger to remove').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('listresponses').setDescription('list all auto responses').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('setuptickets').setDescription('set up the ticket system').addChannelOption(o => o.setName('channel').setDescription('channel to send ticket panel to').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('closeticket').setDescription('close the current ticket'),
    new SlashCommandBuilder().setName('addrolebutton').setDescription('add a role to the button panel').addRoleOption(o => o.setName('role').setDescription('the role').setRequired(true)).addStringOption(o => o.setName('label').setDescription('button label').setRequired(true)).addStringOption(o => o.setName('emoji').setDescription('button emoji').setRequired(false)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('setuproles').setDescription('set up role assignment buttons').addChannelOption(o => o.setName('channel').setDescription('channel to send role panel to').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('setupstats').setDescription('create server stats channels').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('giveaway').setDescription('start a giveaway').addStringOption(o => o.setName('prize').setDescription('what are you giving away?').setRequired(true)).addIntegerOption(o => o.setName('minutes').setDescription('how long in minutes?').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('kick').setDescription('kick a member').addUserOption(o => o.setName('user').setDescription('who?').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)).setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    new SlashCommandBuilder().setName('ban').setDescription('ban a member').addUserOption(o => o.setName('user').setDescription('who?').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)).setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    new SlashCommandBuilder().setName('mute').setDescription('timeout a member').addUserOption(o => o.setName('user').setDescription('who?').setRequired(true)).addIntegerOption(o => o.setName('minutes').setDescription('how long?').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName('unmute').setDescription('remove timeout').addUserOption(o => o.setName('user').setDescription('who?').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName('warn').setDescription('warn a member').addUserOption(o => o.setName('user').setDescription('who?').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('reason').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName('warnings').setDescription('check warnings').addUserOption(o => o.setName('user').setDescription('who?').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName('clearwarnings').setDescription('clear warnings').addUserOption(o => o.setName('user').setDescription('who?').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('purge').setDescription('delete messages').addIntegerOption(o => o.setName('amount').setDescription('how many? (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder().setName('dm').setDescription('DM a member').addUserOption(o => o.setName('user').setDescription('who?').setRequired(true)).addStringOption(o => o.setName('message').setDescription('message').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log('✅ Slash commands registered');
}

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  client.guilds.cache.forEach(guild => scheduleWeeklyUpdateLog(guild));
});

client.on('guildCreate', guild => scheduleWeeklyUpdateLog(guild));

// ─── Member join/leave ────────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  const settings = welcomeSettings.get(member.guild.id);
  if (!settings) return;
  const channel = member.guild.channels.cache.get(settings.channelId);
  if (!channel) return;
  const msg = (settings.message || 'welcome {user} to **{server}**! 🎉').replace('{user}', member.toString()).replace('{server}', member.guild.name);
  await channel.send({ embeds: [new EmbedBuilder().setDescription(msg).setColor(0x2ECC71).setThumbnail(member.user.displayAvatarURL()).setTimestamp()] });
});

client.on('guildMemberRemove', async (member) => {
  const settings = leaveSettings.get(member.guild.id);
  if (!settings) return;
  const channel = member.guild.channels.cache.get(settings.channelId);
  if (!channel) return;
  const msg = (settings.message || '{user} just left **{server}** 💀').replace('{user}', member.user.tag).replace('{server}', member.guild.name);
  await channel.send({ embeds: [new EmbedBuilder().setDescription(msg).setColor(0xE74C3C).setTimestamp()] });
});

// ─── Message handler ──────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const member = message.guild.members.cache.get(message.author.id);
  if (member) addXP(member, message.guild);

  if (containsSwear(message.content)) {
    try {
      await message.delete();
      const warn = await message.channel.send(`${message.author} watch the language bro 💀`);
      setTimeout(() => warn.delete().catch(() => {}), 4000);
      if (!warnings.has(message.author.id)) warnings.set(message.author.id, []);
      warnings.get(message.author.id).push({ reason: 'Auto-mod: swear filter', date: new Date().toISOString() });
    } catch {}
    return;
  }

  if (checkSpam(message.author.id)) {
    try {
      await message.delete();
      const warn = await message.channel.send(`${message.author} chill with the spam 💀`);
      setTimeout(() => warn.delete().catch(() => {}), 4000);
    } catch {}
    return;
  }

  const responses = autoResponses.get(message.guild.id) || [];
  for (const ar of responses) {
    if (message.content.toLowerCase().includes(ar.trigger.toLowerCase())) {
      await message.channel.send(ar.response);
      break;
    }
  }

  if (!client.user || !message.mentions.has(client.user)) return;
  const content = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!content) { await message.reply('yo?'); return; }
  try {
    await message.channel.sendTyping();
    const reply = await askAI(message.author.id, content);
    const chunks = chunkMessage(reply);
    await message.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
  } catch (err) { await message.reply('something broke, try again'); }
});

// ─── Reaction handler ─────────────────────────────────────────────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name === '🎉' && giveaways.has(reaction.message.id)) giveaways.get(reaction.message.id).entries.add(user.id);
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name === '🎉' && giveaways.has(reaction.message.id)) giveaways.get(reaction.message.id).entries.delete(user.id);
});

// ─── Button handler ───────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('role_')) {
      const roleId = interaction.customId.replace('role_', '');
      const member = interaction.member;
      try {
        if (member.roles.cache.has(roleId)) { await member.roles.remove(roleId); await interaction.reply({ content: 'removed the role ✅', ephemeral: true }); }
        else { await member.roles.add(roleId); await interaction.reply({ content: 'gave you the role ✅', ephemeral: true }); }
      } catch { await interaction.reply({ content: 'something went wrong, make sure i have manage roles permission', ephemeral: true }); }
      return;
    }

    if (interaction.customId === 'open_ticket') {
      const existing = interaction.guild.channels.cache.find(c => c.name === `ticket-${interaction.user.username.toLowerCase()}`);
      if (existing) { await interaction.reply({ content: `you already have a ticket: ${existing}`, ephemeral: true }); return; }
      const ticketChannel = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.username.toLowerCase()}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ],
      });
      openTickets.set(ticketChannel.id, interaction.user.id);
      const closeBtn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket_btn').setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒'));
      await ticketChannel.send({ embeds: [new EmbedBuilder().setTitle('ticket opened').setDescription(`yo ${interaction.user}, support will be with you shortly\n\nuse \`/closeticket\` when you're done`).setColor(0x5865F2)], components: [closeBtn] });
      await interaction.reply({ content: `ticket created: ${ticketChannel}`, ephemeral: true });
      return;
    }

    if (interaction.customId === 'close_ticket_btn') {
      if (!openTickets.has(interaction.channel.id)) { await interaction.reply({ content: 'this is not a ticket channel', ephemeral: true }); return; }
      await interaction.reply('closing ticket in 5 seconds...');
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
      openTickets.delete(interaction.channel.id);
      return;
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();
  const { commandName } = interaction;
  const userId = interaction.user.id;

  try {
    if (commandName === 'ask') {
      const reply = await askAI(userId, interaction.options.getString('message'));
      const chunks = chunkMessage(reply);
      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);

    } else if (commandName === 'roblox') {
      const reply = await askAI(userId, `[Roblox/Luau scripting question] ${interaction.options.getString('question')}`);
      const chunks = chunkMessage(reply);
      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);

    } else if (commandName === 'review') {
      const code = interaction.options.getString('code');
      const issue = interaction.options.getString('issue') || 'general review';
      const reply = await askAI(userId, `review/debug this code. issue: ${issue}\n\`\`\`\n${code}\n\`\`\``);
      const chunks = chunkMessage(reply);
      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);

    } else if (commandName === 'clear') {
      conversationHistory.delete(userId);
      await interaction.editReply('chat history cleared ✅');

    } else if (commandName === 'help') {
      const embed = new EmbedBuilder().setTitle('commands').setColor(0x5865F2)
        .addFields(
          { name: '🤖 AI', value: '`/ask` `/roblox` `/review` `/clear`' },
          { name: '⭐ Levels', value: '`/rank` `/leaderboard`' },
          { name: '🎫 Tickets', value: '`/setuptickets` `/closeticket`' },
          { name: '🎉 Giveaways', value: '`/giveaway`' },
          { name: '📋 Updates', value: '`/updatelog` `/requestupdate`' },
          { name: '📢 Server', value: '`/announce` `/poll` `/serverinfo` `/userinfo`' },
          { name: '⚙️ Setup', value: '`/setwelcome` `/setleave` `/addresponse` `/removeresponse` `/setuproles` `/addrolebutton` `/setupstats`' },
          { name: '🔨 Mod', value: '`/kick` `/ban` `/mute` `/unmute` `/warn` `/warnings` `/clearwarnings` `/purge` `/dm`' },
        ).setFooter({ text: 'ping me to chat anytime' });
      await interaction.editReply({ embeds: [embed] });

    } else if (commandName === 'rank') {
      const target = interaction.options.getUser('user') || interaction.user;
      const data = xpData.get(target.id) || { xp: 0, level: 1 };
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`${target.username}'s rank`).setThumbnail(target.displayAvatarURL()).setColor(0xF1C40F).addFields({ name: 'level', value: `${data.level}`, inline: true }, { name: 'xp', value: `${data.xp} / ${getXPForLevel(data.level)}`, inline: true })] });

    } else if (commandName === 'leaderboard') {
      const sorted = [...xpData.entries()].sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp).slice(0, 10);
      const desc = sorted.map(([id, d], i) => `**${i + 1}.** <@${id}> — Level ${d.level} (${d.xp} xp)`).join('\n') || 'no one has xp yet';
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🏆 leaderboard').setDescription(desc).setColor(0xF1C40F)] });

    } else if (commandName === 'setwelcome') {
      const channel = interaction.options.getChannel('channel');
      welcomeSettings.set(interaction.guild.id, { channelId: channel.id, message: interaction.options.getString('message') || 'welcome {user} to **{server}**! 🎉' });
      await interaction.editReply(`welcome messages set to ${channel} ✅`);

    } else if (commandName === 'setleave') {
      const channel = interaction.options.getChannel('channel');
      leaveSettings.set(interaction.guild.id, { channelId: channel.id, message: interaction.options.getString('message') || '{user} just left **{server}** 💀' });
      await interaction.editReply(`leave messages set to ${channel} ✅`);

    } else if (commandName === 'addresponse') {
      const trigger = interaction.options.getString('trigger');
      const response = interaction.options.getString('response');
      if (!autoResponses.has(interaction.guild.id)) autoResponses.set(interaction.guild.id, []);
      autoResponses.get(interaction.guild.id).push({ trigger, response });
      await interaction.editReply(`auto response added ✅`);

    } else if (commandName === 'removeresponse') {
      const trigger = interaction.options.getString('trigger');
      autoResponses.set(interaction.guild.id, (autoResponses.get(interaction.guild.id) || []).filter(r => r.trigger.toLowerCase() !== trigger.toLowerCase()));
      await interaction.editReply(`removed auto response for "${trigger}" ✅`);

    } else if (commandName === 'listresponses') {
      const responses = autoResponses.get(interaction.guild.id) || [];
      if (responses.length === 0) { await interaction.editReply('no auto responses set'); return; }
      await interaction.editReply(responses.map((r, i) => `**${i + 1}.** "${r.trigger}" → "${r.response}"`).join('\n'));

    } else if (commandName === 'setuptickets') {
      const channel = interaction.options.getChannel('channel');
      ticketSettings.set(interaction.guild.id, { channelId: channel.id });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('Open Ticket').setStyle(ButtonStyle.Primary).setEmoji('🎫'));
      await channel.send({ embeds: [new EmbedBuilder().setTitle('🎫 Support Tickets').setDescription('need help? click the button below to open a ticket').setColor(0x5865F2)], components: [row] });
      await interaction.editReply(`ticket panel sent to ${channel} ✅`);

    } else if (commandName === 'closeticket') {
      if (!openTickets.has(interaction.channel.id)) { await interaction.editReply('this is not a ticket channel'); return; }
      await interaction.editReply('closing ticket in 5 seconds...');
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
      openTickets.delete(interaction.channel.id);

    } else if (commandName === 'addrolebutton') {
      const role = interaction.options.getRole('role');
      const label = interaction.options.getString('label');
      const emoji = interaction.options.getString('emoji') || null;
      if (!roleButtons.has(interaction.guild.id)) roleButtons.set(interaction.guild.id, []);
      roleButtons.get(interaction.guild.id).push({ roleId: role.id, label, emoji });
      await interaction.editReply(`added role button for ${role} ✅\nuse \`/setuproles\` to post the panel`);

    } else if (commandName === 'setuproles') {
      const channel = interaction.options.getChannel('channel');
      const buttons = roleButtons.get(interaction.guild.id) || [];
      if (buttons.length === 0) { await interaction.editReply('no role buttons added yet, use `/addrolebutton` first'); return; }
      const rows = [];
      let currentRow = new ActionRowBuilder();
      let count = 0;
      for (const btn of buttons) {
        if (count === 5) { rows.push(currentRow); currentRow = new ActionRowBuilder(); count = 0; }
        const b = new ButtonBuilder().setCustomId(`role_${btn.roleId}`).setLabel(btn.label).setStyle(ButtonStyle.Secondary);
        if (btn.emoji) b.setEmoji(btn.emoji);
        currentRow.addComponents(b);
        count++;
      }
      if (count > 0) rows.push(currentRow);
      await channel.send({ embeds: [new EmbedBuilder().setTitle('🎭 Role Selection').setDescription('click a button to get or remove a role').setColor(0x5865F2)], components: rows });
      await interaction.editReply(`role panel sent to ${channel} ✅`);

    } else if (commandName === 'setupstats') {
      const guild = interaction.guild;
      const category = await guild.channels.create({ name: '📊 Server Stats', type: ChannelType.GuildCategory });
      const noConnect = [{ id: guild.id, deny: [PermissionFlagsBits.Connect] }];
      const memberCh = await guild.channels.create({ name: `👥 Members: ${guild.memberCount}`, type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: noConnect });
      const botCh = await guild.channels.create({ name: `🤖 Bots: ${guild.members.cache.filter(m => m.user.bot).size}`, type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: noConnect });
      const roleCh = await guild.channels.create({ name: `🎭 Roles: ${guild.roles.cache.size}`, type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: noConnect });
      statsChannels.set(guild.id, { memberChannelId: memberCh.id, botChannelId: botCh.id, roleChannelId: roleCh.id });
      await interaction.editReply('stats channels created ✅ updates every 5 mins');

    } else if (commandName === 'giveaway') {
      const prize = interaction.options.getString('prize');
      const minutes = interaction.options.getInteger('minutes');
      const endTime = Date.now() + minutes * 60 * 1000;
      const embed = new EmbedBuilder().setTitle('🎉 GIVEAWAY!').setDescription(`**Prize:** ${prize}\n**Ends:** <t:${Math.floor(endTime / 1000)}:R>\n\nreact with 🎉 to enter!`).setColor(0xF1C40F).setFooter({ text: `hosted by ${interaction.user.tag}` });
      const msg = await interaction.editReply({ embeds: [embed], fetchReply: true });
      await msg.react('🎉');
      giveaways.set(msg.id, { prize, endTime, guildId: interaction.guild.id, channelId: interaction.channel.id, entries: new Set() });

    } else if (commandName === 'updatelog') {
      const logs = updateLogs.get(interaction.guild.id) || [];
      if (logs.length === 0) { await interaction.editReply('no update logs yet, owner can use `/requestupdate`'); return; }
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('📋 Latest Update Log').setDescription(logs[0].content).setColor(0x5865F2).setTimestamp(new Date(logs[0].date)).setFooter({ text: `${logs.length} total logs` })] });

    } else if (commandName === 'requestupdate') {
      const owner = await interaction.guild.fetchOwner();
      if (interaction.user.id !== owner.id) { await interaction.editReply('only the server owner can use this'); return; }
      await interaction.editReply('sent you a DM 👍');
      await askOwnerForUpdateLog(interaction.guild);

    } else if (commandName === 'announce') {
      const msg = interaction.options.getString('message');
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      await channel.send({ embeds: [new EmbedBuilder().setTitle('📢 Announcement').setDescription(msg).setColor(0xF1C40F).setTimestamp().setFooter({ text: `by ${interaction.user.tag}` })] });
      await interaction.editReply(`announced in ${channel} ✅`);

    } else if (commandName === 'poll') {
      const question = interaction.options.getString('question');
      const options = [interaction.options.getString('option1'), interaction.options.getString('option2'), interaction.options.getString('option3'), interaction.options.getString('option4')].filter(Boolean);
      const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
      const pollMsg = await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`📊 ${question}`).setDescription(options.map((o, i) => `${emojis[i]} ${o}`).join('\n')).setColor(0x2ECC71).setFooter({ text: `poll by ${interaction.user.tag}` }).setTimestamp()], fetchReply: true });
      for (let i = 0; i < options.length; i++) await pollMsg.react(emojis[i]);

    } else if (commandName === 'serverinfo') {
      const guild = interaction.guild;
      const owner = await guild.fetchOwner();
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(guild.name).setThumbnail(guild.iconURL()).setColor(0x5865F2).addFields({ name: 'owner', value: owner.user.tag, inline: true }, { name: 'members', value: `${guild.memberCount}`, inline: true }, { name: 'channels', value: `${guild.channels.cache.size}`, inline: true }, { name: 'roles', value: `${guild.roles.cache.size}`, inline: true }, { name: 'created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true })] });

    } else if (commandName === 'userinfo') {
      const target = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      const data = xpData.get(target.id) || { xp: 0, level: 1 };
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(target.tag).setThumbnail(target.displayAvatarURL()).setColor(0x5865F2).addFields({ name: 'id', value: target.id, inline: true }, { name: 'level', value: `${data.level}`, inline: true }, { name: 'account created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:R>`, inline: true }, { name: 'joined server', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'n/a', inline: true }, { name: 'warnings', value: `${(warnings.get(target.id) || []).length}`, inline: true })] });

    } else if (commandName === 'kick') {
      const target = interaction.options.getMember('user');
      const reason = interaction.options.getString('reason') || 'no reason given';
      await target.kick(reason);
      await interaction.editReply(`kicked ${target.user.tag} — ${reason}`);

    } else if (commandName === 'ban') {
      const target = interaction.options.getMember('user');
      const reason = interaction.options.getString('reason') || 'no reason given';
      await target.ban({ reason });
      await interaction.editReply(`banned ${target.user.tag} — ${reason}`);

    } else if (commandName === 'mute') {
      const target = interaction.options.getMember('user');
      const minutes = interaction.options.getInteger('minutes');
      const reason = interaction.options.getString('reason') || 'no reason given';
      await target.timeout(minutes * 60 * 1000, reason);
      await interaction.editReply(`muted ${target.user.tag} for ${minutes}m — ${reason}`);

    } else if (commandName === 'unmute') {
      const target = interaction.options.getMember('user');
      await target.timeout(null);
      await interaction.editReply(`unmuted ${target.user.tag} ✅`);

    } else if (commandName === 'warn') {
      const target = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      if (!warnings.has(target.id)) warnings.set(target.id, []);
      warnings.get(target.id).push({ reason, date: new Date().toISOString() });
      const count = warnings.get(target.id).length;
      await interaction.editReply(`warned ${target.tag} — ${reason} (${count} total warning${count > 1 ? 's' : ''})`);
      try { await target.send(`you got a warning in **${interaction.guild.name}**\nreason: ${reason}\ntotal warnings: ${count}`); } catch {}

    } else if (commandName === 'warnings') {
      const target = interaction.options.getUser('user');
      const userWarnings = warnings.get(target.id) || [];
      if (userWarnings.length === 0) { await interaction.editReply(`${target.tag} has no warnings`); return; }
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`warnings for ${target.tag}`).setColor(0xE74C3C).setDescription(userWarnings.map((w, i) => `**${i + 1}.** ${w.reason} — <t:${Math.floor(new Date(w.date).getTime() / 1000)}:R>`).join('\n'))] });

    } else if (commandName === 'clearwarnings') {
      const target = interaction.options.getUser('user');
      warnings.delete(target.id);
      await interaction.editReply(`cleared all warnings for ${target.tag} ✅`);

    } else if (commandName === 'purge') {
      const amount = interaction.options.getInteger('amount');
      await interaction.channel.bulkDelete(amount, true);
      const msg = await interaction.editReply(`deleted ${amount} messages ✅`);
      setTimeout(() => msg.delete().catch(() => {}), 3000);

    } else if (commandName === 'dm') {
      const target = interaction.options.getUser('user');
      const msg = interaction.options.getString('message');
      await target.send(`**message from ${interaction.guild.name}:**\n${msg}`);
      await interaction.editReply(`sent DM to ${target.tag} ✅`);
    }

  } catch (err) {
    console.error(err);
    await interaction.editReply('something went wrong, try again').catch(() => {});
  }
});

// ─── Dashboard API ────────────────────────────────────────────────────────────
const API_SECRET = process.env.DASHBOARD_SECRET || 'secretkey11';

app.use((req, res, next) => {
  if (req.headers['x-secret'] !== API_SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
});

const getGuild = () => client.guilds.cache.first();

app.get('/stats', async (req, res) => {
  const guild = getGuild();
  if (!guild) return res.json({ members: 0, online: 0, warnings: 0, giveaways: 0 });
  const totalWarnings = [...warnings.values()].reduce((a, b) => a + b.length, 0);
  res.json({ members: guild.memberCount, online: guild.members.cache.filter(m => !m.user.bot).size, warnings: totalWarnings, giveaways: giveaways.size });
});

app.get('/members', async (req, res) => {
  const guild = getGuild();
  if (!guild) return res.json([]);
  await guild.members.fetch();
  res.json(guild.members.cache.filter(m => !m.user.bot).map(m => ({ id: m.id, username: m.user.username, joined: m.joinedAt?.toLocaleDateString(), level: xpData.get(m.id)?.level || 1, warnings: (warnings.get(m.id) || []).length })));
});

app.get('/leaderboard', (req, res) => {
  res.json([...xpData.entries()].sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp).slice(0, 20).map(([id, d]) => ({ id, ...d, username: client.users.cache.get(id)?.username || id })));
});

app.post('/warn', (req, res) => {
  const { userId, reason } = req.body;
  if (!warnings.has(userId)) warnings.set(userId, []);
  warnings.get(userId).push({ reason, date: new Date().toISOString() });
  res.json({ success: true });
});

app.post('/ban', async (req, res) => {
  try { await getGuild()?.members.ban(req.body.userId, { reason: req.body.reason }); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/unban', async (req, res) => {
  try { await getGuild()?.members.unban(req.body.userId); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/announce', async (req, res) => {
  const { channel: channelId, title, message } = req.body;
  const channel = getGuild()?.channels.cache.get(channelId);
  if (!channel) return res.status(400).json({ error: 'channel not found' });
  await channel.send({ embeds: [new EmbedBuilder().setTitle(title || '📢 Announcement').setDescription(message).setColor(0xF1C40F).setTimestamp()] });
  res.json({ success: true });
});

app.post('/updatelog', async (req, res) => {
  const { channel: channelId, version, content } = req.body;
  const guild = getGuild();
  const channel = guild?.channels.cache.get(channelId);
  if (!channel) return res.status(400).json({ error: 'channel not found' });
  await channel.send({ embeds: [new EmbedBuilder().setTitle(`📋 ${version || 'Update Log'}`).setDescription(content).setColor(0x5865F2).setTimestamp()] });
  if (!updateLogs.has(guild.id)) updateLogs.set(guild.id, []);
  updateLogs.get(guild.id).unshift({ content, date: new Date().toISOString() });
  res.json({ success: true });
});

app.post('/giveaway', async (req, res) => {
  const { channel: channelId, prize, minutes } = req.body;
  const guild = getGuild();
  const channel = guild?.channels.cache.get(channelId);
  if (!channel) return res.status(400).json({ error: 'channel not found' });
  const endTime = Date.now() + minutes * 60 * 1000;
  const msg = await channel.send({ embeds: [new EmbedBuilder().setTitle('🎉 GIVEAWAY!').setDescription(`**Prize:** ${prize}\n**Ends:** <t:${Math.floor(endTime / 1000)}:R>\n\nreact with 🎉 to enter!`).setColor(0xF1C40F)] });
  await msg.react('🎉');
  giveaways.set(msg.id, { prize, endTime, guildId: guild.id, channelId, entries: new Set() });
  res.json({ success: true });
});

app.post('/setwelcome', (req, res) => {
  welcomeSettings.set(getGuild()?.id, { channelId: req.body.channel, message: req.body.message });
  res.json({ success: true });
});

app.post('/setleave', (req, res) => {
  leaveSettings.set(getGuild()?.id, { channelId: req.body.channel, message: req.body.message });
  res.json({ success: true });
});

app.post('/addresponse', (req, res) => {
  const guild = getGuild();
  if (!autoResponses.has(guild.id)) autoResponses.set(guild.id, []);
  autoResponses.get(guild.id).push({ trigger: req.body.trigger, response: req.body.response });
  res.json({ success: true });
});

app.post('/removeresponse', (req, res) => {
  const guild = getGuild();
  autoResponses.set(guild.id, (autoResponses.get(guild.id) || []).filter(r => r.trigger.toLowerCase() !== req.body.trigger.toLowerCase()));
  res.json({ success: true });
});

app.get('/responses', (req, res) => {
  res.json(autoResponses.get(getGuild()?.id) || []);
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);