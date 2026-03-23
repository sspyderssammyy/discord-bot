require(‘dotenv’).config();
const {
Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder,
ButtonStyle, ChannelType, Collection
} = require(‘discord.js’);
const Groq = require(‘groq-sdk’);
const { GoogleGenerativeAI } = require(’@google/generative-ai’);

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

// ─── In-memory storage ───────────────────────────────────────────────────────
const conversationHistory = new Map();
const warnings = new Map(); // userId -> [{reason, date}]
const updateLogs = new Map(); // guildId -> [{version, content, date}]
const spamTracker = new Map(); // userId -> [timestamps]
const mutedUsers = new Map(); // userId -> timeoutId

const SWEAR_WORDS = [‘fuck’, ‘shit’, ‘bitch’, ‘asshole’, ‘nigga’, ‘nigger’, ‘cunt’, ‘fag’];
const SPAM_THRESHOLD = 5; // messages
const SPAM_WINDOW = 4000; // ms

// ─── System Prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a Discord bot assistant with a chill, gen z personality. You’re like that one friend who’s actually really smart but talks super casually.

Personality rules:

- Talk casually, use lowercase mostly, short sentences
- Be helpful but not robotic
- Use occasional gen z slang naturally (no cap, fr, lowkey, ngl, bussin, etc.) but don’t overdo it
- Be funny when it fits but don’t force it
- If someone’s being rude, clap back a little but stay chill
- Don’t use emojis unless it fits naturally

For Roblox/scripting help:

- Only go full dev mode if someone specifically asks about Roblox or scripting
- Use Luau for Roblox code, always explain why something works
- Be like a senior dev helping out a homie, not a textbook

For general chat:

- Just vibe and chat, you’re not just a dev bot
- Give real opinions, don’t be a yes-man
- Keep responses short unless they need detail`;

// ─── AI Chat (Groq primary, Gemini fallback) ──────────────────────────────────
async function askAI(userId, userMessage) {
if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
const history = conversationHistory.get(userId);
history.push({ role: ‘user’, content: userMessage });
if (history.length > 30) history.splice(0, history.length - 30);

let reply = null;

// Try Groq first
try {
const response = await groq.chat.completions.create({
model: ‘llama-3.3-70b-versatile’,
messages: [{ role: ‘system’, content: SYSTEM_PROMPT }, …history],
max_tokens: 1500,
});
reply = response.choices[0].message.content;
console.log(‘✅ Used Groq’);
} catch (groqErr) {
console.warn(‘⚠️ Groq failed, switching to Gemini…’, groqErr.message);

```
// Fallback to Gemini
try {
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: SYSTEM_PROMPT,
  });

  const geminiHistory = history.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const chat = model.startChat({ history: geminiHistory });
  const result = await chat.sendMessage(userMessage);
  reply = result.response.text();
  console.log('✅ Used Gemini (fallback)');
} catch (geminiErr) {
  console.error('❌ Both Groq and Gemini failed', geminiErr.message);
  throw new Error('both AI providers are down rn, try again in a bit');
}
```

}

history.push({ role: ‘assistant’, content: reply });
return reply;
}

function chunkMessage(text, maxLength = 1900) {
if (text.length <= maxLength) return [text];
const chunks = [];
let current = ‘’;
for (const line of text.split(’\n’)) {
if ((current + ‘\n’ + line).length > maxLength) {
if (current) chunks.push(current);
current = line;
} else {
current = current ? current + ‘\n’ + line : line;
}
}
if (current) chunks.push(current);
return chunks;
}

// ─── Weekly Update Log DM ────────────────────────────────────────────────────
async function askOwnerForUpdateLog(guild) {
try {
const owner = await guild.fetchOwner();
const dm = await owner.createDM();
await dm.send(
`yo it's that time again 👋\n\nwhat's the update log for this week? just type it out and i'll post it in the server.\n\nformat it however you want, i'll make it look clean.`
);

```
const filter = m => m.author.id === owner.id;
const collected = await dm.awaitMessages({ filter, max: 1, time: 86400000 });

if (collected.size > 0) {
  const content = collected.first().content;
  const logEntry = { content, date: new Date().toISOString() };

  if (!updateLogs.has(guild.id)) updateLogs.set(guild.id, []);
  updateLogs.get(guild.id).unshift(logEntry);

  // Find a general/announcements channel
  const channel =
    guild.channels.cache.find(c =>
      c.type === ChannelType.GuildText &&
      (c.name.includes('announcement') || c.name.includes('general') || c.name.includes('update'))
    ) || guild.channels.cache.find(c => c.type === ChannelType.GuildText);

  if (channel) {
    const embed = new EmbedBuilder()
      .setTitle('📋 Update Log')
      .setDescription(content)
      .setColor(0x5865F2)
      .setTimestamp()
      .setFooter({ text: `Posted by server owner` });
    await channel.send({ embeds: [embed] });
    await dm.send('posted it ✅');
  }
}
```

} catch (err) {
console.error(‘Update log error:’, err);
}
}

function scheduleWeeklyUpdateLog(guild) {
const oneWeek = 7 * 24 * 60 * 60 * 1000;
setInterval(() => askOwnerForUpdateLog(guild), oneWeek);
}

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
const lower = content.toLowerCase();
return SWEAR_WORDS.some(word => lower.includes(word));
}

// ─── Register Commands ────────────────────────────────────────────────────────
async function registerCommands() {
const commands = [
// AI
new SlashCommandBuilder()
.setName(‘ask’)
.setDescription(‘chat with the AI’)
.addStringOption(o => o.setName(‘message’).setDescription(‘what do you wanna say?’).setRequired(true)),
new SlashCommandBuilder()
.setName(‘roblox’)
.setDescription(‘get roblox / luau scripting help’)
.addStringOption(o => o.setName(‘question’).setDescription(‘your question’).setRequired(true)),
new SlashCommandBuilder()
.setName(‘review’)
.setDescription(‘get your code reviewed or debugged’)
.addStringOption(o => o.setName(‘code’).setDescription(‘paste your code’).setRequired(true))
.addStringOption(o => o.setName(‘issue’).setDescription(‘whats the issue?’).setRequired(false)),
new SlashCommandBuilder()
.setName(‘clear’)
.setDescription(‘reset your chat history with the bot’),

```
// Info
new SlashCommandBuilder()
  .setName('help')
  .setDescription('show all commands'),
new SlashCommandBuilder()
  .setName('serverinfo')
  .setDescription('info about this server'),
new SlashCommandBuilder()
  .setName('userinfo')
  .setDescription('info about a user')
  .addUserOption(o => o.setName('user').setDescription('which user?').setRequired(false)),

// Update log
new SlashCommandBuilder()
  .setName('updatelog')
  .setDescription('see the latest update logs'),
new SlashCommandBuilder()
  .setName('requestupdate')
  .setDescription('(owner only) manually trigger the weekly update log DM')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

// Announcements & Polls
new SlashCommandBuilder()
  .setName('announce')
  .setDescription('send an announcement (admin only)')
  .addStringOption(o => o.setName('message').setDescription('announcement content').setRequired(true))
  .addChannelOption(o => o.setName('channel').setDescription('which channel?').setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
new SlashCommandBuilder()
  .setName('poll')
  .setDescription('create a poll')
  .addStringOption(o => o.setName('question').setDescription('poll question').setRequired(true))
  .addStringOption(o => o.setName('option1').setDescription('option 1').setRequired(true))
  .addStringOption(o => o.setName('option2').setDescription('option 2').setRequired(true))
  .addStringOption(o => o.setName('option3').setDescription('option 3').setRequired(false))
  .addStringOption(o => o.setName('option4').setDescription('option 4').setRequired(false)),

// Moderation
new SlashCommandBuilder()
  .setName('kick')
  .setDescription('kick a member')
  .addUserOption(o => o.setName('user').setDescription('who?').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
new SlashCommandBuilder()
  .setName('ban')
  .setDescription('ban a member')
  .addUserOption(o => o.setName('user').setDescription('who?').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
new SlashCommandBuilder()
  .setName('mute')
  .setDescription('timeout a member')
  .addUserOption(o => o.setName('user').setDescription('who?').setRequired(true))
  .addIntegerOption(o => o.setName('minutes').setDescription('how long? (minutes)').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
new SlashCommandBuilder()
  .setName('unmute')
  .setDescription('remove timeout from a member')
  .addUserOption(o => o.setName('user').setDescription('who?').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
new SlashCommandBuilder()
  .setName('warn')
  .setDescription('warn a member')
  .addUserOption(o => o.setName('user').setDescription('who?').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('reason').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
new SlashCommandBuilder()
  .setName('warnings')
  .setDescription('check warnings for a user')
  .addUserOption(o => o.setName('user').setDescription('who?').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
new SlashCommandBuilder()
  .setName('clearwarnings')
  .setDescription('clear all warnings for a user')
  .addUserOption(o => o.setName('user').setDescription('who?').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
new SlashCommandBuilder()
  .setName('purge')
  .setDescription('delete multiple messages')
  .addIntegerOption(o => o.setName('amount').setDescription('how many? (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
new SlashCommandBuilder()
  .setName('dm')
  .setDescription('DM a member (admin only)')
  .addUserOption(o => o.setName('user').setDescription('who?').setRequired(true))
  .addStringOption(o => o.setName('message').setDescription('message content').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
```

].map(c => c.toJSON());

const rest = new REST({ version: ‘10’ }).setToken(process.env.DISCORD_TOKEN);
await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
console.log(‘✅ Slash commands registered’);
}

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once(‘ready’, async () => {
console.log(`✅ Logged in as ${client.user.tag}`);
await registerCommands();
client.guilds.cache.forEach(guild => scheduleWeeklyUpdateLog(guild));
});

client.on(‘guildCreate’, guild => scheduleWeeklyUpdateLog(guild));

// ─── Auto-mod message handler ─────────────────────────────────────────────────
client.on(‘messageCreate’, async (message) => {
if (message.author.bot || !message.guild) return;

// Swear filter
if (containsSwear(message.content)) {
try {
await message.delete();
const warn = await message.channel.send(`${message.author} watch the language bro 💀`);
setTimeout(() => warn.delete().catch(() => {}), 4000);

```
  if (!warnings.has(message.author.id)) warnings.set(message.author.id, []);
  warnings.get(message.author.id).push({ reason: 'Auto-mod: swear filter', date: new Date().toISOString() });
} catch {}
return;
```

}

// Spam detection
if (checkSpam(message.author.id)) {
try {
await message.delete();
const warn = await message.channel.send(`${message.author} chill with the spam 💀`);
setTimeout(() => warn.delete().catch(() => {}), 4000);
} catch {}
return;
}

// @mention handler
if (!client.user) return;
const isMentioned = message.mentions.has(client.user);
if (!isMentioned) return;

const content = message.content.replace(/<@!?\d+>/g, ‘’).trim();
if (!content) { await message.reply(‘yo?’); return; }

try {
await message.channel.sendTyping();
const reply = await askAI(message.author.id, content);
const chunks = chunkMessage(reply);
await message.reply(chunks[0]);
for (let i = 1; i < chunks.length; i++) await message.channel.send(chunks[i]);
} catch (err) {
console.error(err);
await message.reply(‘something broke, try again’);
}
});

// ─── Slash command handler ────────────────────────────────────────────────────
client.on(‘interactionCreate’, async (interaction) => {
if (!interaction.isChatInputCommand()) return;
await interaction.deferReply();

const { commandName } = interaction;
const userId = interaction.user.id;

try {
// ── AI commands ──
if (commandName === ‘ask’) {
const msg = interaction.options.getString(‘message’);
const reply = await askAI(userId, msg);
const chunks = chunkMessage(reply);
await interaction.editReply(chunks[0]);
for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);

```
} else if (commandName === 'roblox') {
  const q = interaction.options.getString('question');
  const reply = await askAI(userId, `[Roblox/Luau scripting question] ${q}`);
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

// ── Help ──
} else if (commandName === 'help') {
  const embed = new EmbedBuilder()
    .setTitle('commands')
    .setColor(0x5865F2)
    .addFields(
      { name: '🤖 AI', value: '`/ask` `/roblox` `/review` `/clear`' },
      { name: '📋 Updates', value: '`/updatelog` `/requestupdate`' },
      { name: '📢 Server', value: '`/announce` `/poll` `/serverinfo` `/userinfo`' },
      { name: '🔨 Moderation', value: '`/kick` `/ban` `/mute` `/unmute` `/warn` `/warnings` `/clearwarnings` `/purge` `/dm`' },
    )
    .setFooter({ text: 'ping me to chat anytime' });
  await interaction.editReply({ embeds: [embed] });

// ── Server/User info ──
} else if (commandName === 'serverinfo') {
  const guild = interaction.guild;
  const owner = await guild.fetchOwner();
  const embed = new EmbedBuilder()
    .setTitle(guild.name)
    .setThumbnail(guild.iconURL())
    .setColor(0x5865F2)
    .addFields(
      { name: 'owner', value: owner.user.tag, inline: true },
      { name: 'members', value: `${guild.memberCount}`, inline: true },
      { name: 'channels', value: `${guild.channels.cache.size}`, inline: true },
      { name: 'roles', value: `${guild.roles.cache.size}`, inline: true },
      { name: 'created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
    );
  await interaction.editReply({ embeds: [embed] });

} else if (commandName === 'userinfo') {
  const target = interaction.options.getUser('user') || interaction.user;
  const member = await interaction.guild.members.fetch(target.id).catch(() => null);
  const embed = new EmbedBuilder()
    .setTitle(target.tag)
    .setThumbnail(target.displayAvatarURL())
    .setColor(0x5865F2)
    .addFields(
      { name: 'id', value: target.id, inline: true },
      { name: 'account created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:R>`, inline: true },
      { name: 'joined server', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'n/a', inline: true },
      { name: 'roles', value: member ? member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.toString()).join(', ') || 'none' : 'n/a' },
      { name: 'warnings', value: `${(warnings.get(target.id) || []).length}`, inline: true },
    );
  await interaction.editReply({ embeds: [embed] });

// ── Update log ──
} else if (commandName === 'updatelog') {
  const logs = updateLogs.get(interaction.guild.id) || [];
  if (logs.length === 0) {
    await interaction.editReply('no update logs yet. the owner can use `/requestupdate` to post one.');
    return;
  }
  const latest = logs[0];
  const embed = new EmbedBuilder()
    .setTitle('📋 Latest Update Log')
    .setDescription(latest.content)
    .setColor(0x5865F2)
    .setTimestamp(new Date(latest.date))
    .setFooter({ text: `${logs.length} total logs` });
  await interaction.editReply({ embeds: [embed] });

} else if (commandName === 'requestupdate') {
  const guild = interaction.guild;
  const owner = await guild.fetchOwner();
  if (interaction.user.id !== owner.id) {
    await interaction.editReply('only the server owner can use this');
    return;
  }
  await interaction.editReply('sent you a DM, check it 👍');
  await askOwnerForUpdateLog(guild);

// ── Announce ──
} else if (commandName === 'announce') {
  const msg = interaction.options.getString('message');
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  const embed = new EmbedBuilder()
    .setTitle('📢 Announcement')
    .setDescription(msg)
    .setColor(0xF1C40F)
    .setTimestamp()
    .setFooter({ text: `by ${interaction.user.tag}` });
  await channel.send({ embeds: [embed] });
  await interaction.editReply(`announced in ${channel} ✅`);

// ── Poll ──
} else if (commandName === 'poll') {
  const question = interaction.options.getString('question');
  const options = [
    interaction.options.getString('option1'),
    interaction.options.getString('option2'),
    interaction.options.getString('option3'),
    interaction.options.getString('option4'),
  ].filter(Boolean);

  const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
  const desc = options.map((o, i) => `${emojis[i]} ${o}`).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${question}`)
    .setDescription(desc)
    .setColor(0x2ECC71)
    .setFooter({ text: `poll by ${interaction.user.tag}` })
    .setTimestamp();

  const pollMsg = await interaction.editReply({ embeds: [embed], fetchReply: true });
  for (let i = 0; i < options.length; i++) await pollMsg.react(emojis[i]);

// ── Moderation ──
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

  // DM the warned user
  try {
    await target.send(`you got a warning in **${interaction.guild.name}**\nreason: ${reason}\ntotal warnings: ${count}`);
  } catch {}

} else if (commandName === 'warnings') {
  const target = interaction.options.getUser('user');
  const userWarnings = warnings.get(target.id) || [];
  if (userWarnings.length === 0) {
    await interaction.editReply(`${target.tag} has no warnings`);
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle(`warnings for ${target.tag}`)
    .setColor(0xE74C3C)
    .setDescription(userWarnings.map((w, i) => `**${i + 1}.** ${w.reason} — <t:${Math.floor(new Date(w.date).getTime() / 1000)}:R>`).join('\n'));
  await interaction.editReply({ embeds: [embed] });

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
```

} catch (err) {
console.error(err);
await interaction.editReply(‘something went wrong, try again’).catch(() => {});
}
});

client.login(process.env.DISCORD_TOKEN);
