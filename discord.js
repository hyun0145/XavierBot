require('dotenv').config();

// Instructions for installing dependencies:
// 1. Initialize your project: `npm init -y`
// 2. Install discord.js: `npm install discord.js`
// 3. Install voice package: `npm install @discordjs/voice`
// 4. Install FFmpeg (required by @discordjs/voice for audio processing):
//    `npm install ffmpeg-static` (or `npm install opusscript` if you prefer)
// 5. Install yt-dlp-wrap for YouTube audio: `npm install yt-dlp-wrap`
//    IMPORTANT: yt-dlp-wrap requires the standalone yt-dlp executable.
//    If you installed yt-dlp via `pip`, that's the Python package, not the standalone executable.
//    You need to manually download the correct yt-dlp executable for your OS
//    from https://github.com/yt-dlp/yt-dlp/releases and place it in your bot's directory.
//    For Windows, download 'yt-dlp.exe'. For Linux/macOS, download 'yt-dlp'.
// 6. (Optional) Uninstall ytdl-core if you no longer need it: `npm uninstall ytdl-core`

// Import necessary Discord.js classes
const { Client, GatewayIntentBits, REST, Routes, ApplicationCommandOptionType, ActivityType } = require('discord.js'); // ADDED: ActivityType
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const YTDLPPromise = require('yt-dlp-wrap').default;
const fs = require('fs');
const path = require('path'); // ADDED: For path manipulation
const ffmpegStatic = require('ffmpeg-static');
const fetch = require('node-fetch');
const { exec } = require('child_process'); // ADDED: For !runpy command

// ADDED: Plugin management
const plugins = new Map(); // Map<pluginName, pluginModule>
const PLUGIN_DIR = path.join(__dirname, 'plugins');

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // Required to read message content
        GatewayIntentBits.GuildVoiceStates, // Required for voice channel interactions
        GatewayIntentBits.GuildMembers, // ADDED: Required for moderation commands (kick, ban, timeout, roles)
    ]
});

// Bot prefix for commands
const prefix = '!';

// Store active voice connections and audio players
const connections = new Map(); // Map<guildId, VoiceConnection>
const players = new Map(); // Map<guildId, AudioPlayer>
const audioQueues = new Map(); // Map<guildId, { resource: AudioResource, type: 'yt' | 'stream' | 'file' }[]> // ADDED: For queue management

// Initialize yt-dlp-wrap
const YTDLP_PATH = './yt-dlp.exe'; // Path where yt-dlp executable will be stored
const ytDlp = new YTDLPPromise(YTDLP_PATH);

// ADDED: Define directories for local files
const SOUNDBOARD_DIR = path.join(__dirname, 'soundboard_clips');
const VIDEOS_DIR = path.join(__dirname, 'videos'); // Renamed from videoDir for consistency
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

// ADDED: Ensure necessary directories exist
[SOUNDBOARD_DIR, VIDEOS_DIR, DOWNLOADS_DIR, PLUGIN_DIR].forEach(dir => { // MODIFIED: Added PLUGIN_DIR
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
    }
});

// ADDED: Critical startup check for yt-dlp executable
if (!fs.existsSync(YTDLP_PATH)) {
    console.error(`CRITICAL ERROR: yt-dlp executable not found at ${YTDLP_PATH}`);
    console.error(`Please download the correct executable for your OS from https://github.com/yt-dlp/yt-dlp/releases`);
    console.error(`Rename it to "yt-dlp.exe" and place it in the bot's directory: ${__dirname}`);
    process.exit(1); // Exit the bot if yt-dlp is not found
} else {
    console.log(`yt-dlp executable found at: ${YTDLP_PATH}`);
}

// ADDED: Critical startup check for FFmpeg executable
if (!ffmpegStatic || !fs.existsSync(ffmpegStatic)) {
    console.error(`CRITICAL ERROR: FFmpeg executable not found.`);
    console.error(`Please ensure 'ffmpeg-static' is correctly installed via 'npm install ffmpeg-static'.`);
    console.error(`If it's installed, check if the executable exists at: ${ffmpegStatic}`);
    process.exit(1); // Exit the bot if FFmpeg is not found
} else {
    console.log(`FFmpeg executable found at: ${ffmpegStatic}`);
}

// ADDED: Slash command registration setup
// IMPORTANT: Replace with your bot's client ID and the ID of the guild you want to register commands in.
// For global commands, remove GUILD_ID from Routes.applicationGuildCommands.
const CLIENT_ID = '1424495596923916288'; // Replace with your bot's client ID

const commands = [
    {
        name: 'say',
        description: 'Makes the bot say a message.',
        options: [
            {
                name: 'message',
                type: ApplicationCommandOptionType.String,
                description: 'The message for the bot to say.',
                required: true,
            },
        ],
    },
    {
        name: 'call',
        description: 'Makes the bot join your current voice channel.',
    },
    {
        name: 'badge',
        description: 'Assigns the Developer badge to a user (placeholder).',
        options: [
            {
                name: 'user',
                type: ApplicationCommandOptionType.User,
                description: 'The user to assign the badge to.',
                required: true,
            },
        ],
    },
    {
        name: 'sharescreen',
        description: 'Explains screen sharing limitations.',
    },
    {
        name: 'speakerphone',
        description: 'Explains speakerphone limitations.',
        options: [
            {
                name: 'user',
                type: ApplicationCommandOptionType.User,
                description: 'An optional user to mention.',
                required: false,
            },
        ],
    },
    {
        name: 'sound',
        description: 'Plays a soundboard clip or lists available clips.',
        options: [
            {
                name: 'clip',
                type: ApplicationCommandOptionType.String,
                description: 'The name of the soundboard clip to play.',
                required: false,
            },
        ],
    },
    {
        name: 'ytplay',
        description: 'Plays audio from a YouTube video in your voice channel.',
        options: [
            {
                name: 'url',
                type: ApplicationCommandOptionType.String,
                description: 'The YouTube URL.',
                required: true,
            },
        ],
    },
    {
        name: 'livestream',
        description: 'Plays a live audio stream from a URL in your voice channel.',
        options: [
            {
                name: 'url',
                type: ApplicationCommandOptionType.String,
                description: 'The URL of the audio stream.',
                required: true,
            },
        ],
    },
    {
        name: 'playvideo',
        description: 'Plays a video file\'s audio from the "videos" directory.',
        options: [
            {
                name: 'filename',
                type: ApplicationCommandOptionType.String,
                description: 'The filename of the video (e.g., video.mp4).',
                required: true,
            },
        ],
    },
    { // ADDED: Slash command for /sendmessage
        name: 'sendmessage',
        description: 'Sends a direct message to a user.',
        options: [
            {
                name: 'user',
                type: ApplicationCommandOptionType.User,
                description: 'The user to send the message to.',
                required: true,
            },
            {
                name: 'message',
                type: ApplicationCommandOptionType.String,
                description: 'The message to send.',
                required: true,
            },
        ],
    },
    { // ADDED: Slash command for /dm (alias for /sendmessage)
        name: 'dm',
        description: 'Sends a direct message to a user.',
        options: [
            {
                name: 'user',
                type: ApplicationCommandOptionType.User,
                description: 'The user to send the message to.',
                required: true,
            },
            {
                name: 'message',
                type: ApplicationCommandOptionType.String,
                description: 'The message to send.',
                required: true,
            },
        ],
    },
    {
        name: 'plugin',
        description: 'Manages bot plugins (load, unload, list).',
        options: [
            {
                name: 'load',
                type: ApplicationCommandOptionType.Subcommand,
                description: 'Loads a plugin.',
                options: [
                    {
                        name: 'name',
                        type: ApplicationCommandOptionType.String,
                        description: 'The name of the plugin to load (e.g., "example").',
                        required: true,
                    },
                ],
            },
            {
                name: 'unload',
                type: ApplicationCommandOptionType.Subcommand,
                description: 'Loads a plugin (Note: This command now performs a load action).',
                options: [
                    {
                        name: 'name',
                        type: ApplicationCommandOptionType.String,
                        description: 'The name of the plugin to unload (e.g., "example").',
                        required: true,
                    },
                ],
            },
            {
                name: 'list',
                type: ApplicationCommandOptionType.Subcommand,
                description: 'Lists all available and loaded plugins.',
            },
        ],
    },
    { // ADDED: Slash command for /phone
        name: 'phone',
        description: 'Initiates or ends a simulated voice call.',
        options: [
            {
                name: 'call',
                type: ApplicationCommandOptionType.Subcommand,
                description: 'Calls another user to your voice channel.',
                options: [
                    {
                        name: 'user',
                        type: ApplicationCommandOptionType.User,
                        description: 'The user to call.',
                        required: true,
                    },
                ],
            },
            {
                name: 'hangup',
                type: ApplicationCommandOptionType.Subcommand,
                description: 'Ends the current call and leaves the voice channel.',
            },
        ],
    },
    {
        name: 'control',
        description: 'Manages bot\'s online status and activity.',
        options: [
            {
                name: 'status',
                type: ApplicationCommandOptionType.String,
                description: 'Sets the bot\'s status.',
                required: false,
            },
            {
                name: 'activity',
                type: ApplicationCommandOptionType.String,
                description: 'Sets the bot\'s activity (e.g., playing, streaming).',
                required: false,
            },
            {
                name: 'name',
                type: ApplicationCommandOptionType.String,
                description: 'The name of the activity.',
                required: false,
            },
            {
                name: 'url',
                type: ApplicationCommandOptionType.String,
                description: 'The URL for the activity (e.g., Twitch stream URL).',
                required: false,
            },
        ],
    },
    {
        name: 'youtubeupload',
        description: 'Uploads a local video file to YouTube (complex, placeholder).',
        options: [
            {
                name: 'file_path',
                type: ApplicationCommandOptionType.String,
                description: 'The local file path of the video to upload.',
                required: true,
            },
            {
                name: 'title',
                type: ApplicationCommandOptionType.String,
                description: 'The title of the video.',
                required: true,
            },
            {
                name: 'description',
                type: ApplicationCommandOptionType.String,
                description: 'The description of the video.',
                required: false,
            },
            {
                name: 'tags',
                type: ApplicationCommandOptionType.String,
                description: 'Comma-separated list of tags for the video.',
                required: false,
            },
        ],
    },
    { // ADDED: Slash command for /fakemessage
        name: 'fakemessage',
        description: 'Sends a message as another user (Administrator only).',
        options: [
            {
                name: 'user',
                type: ApplicationCommandOptionType.User,
                description: 'The user to impersonate.',
                required: true,
            },
            {
                name: 'message',
                type: ApplicationCommandOptionType.String, // FIX: Corrected typo from ApplicationCommandCommandOptionType
                description: 'The message to send.',
                required: true,
            },
            {
                name: 'username',
                type: ApplicationCommandOptionType.String,
                description: 'Optional: Override the username for the message.',
                required: false,
            },
        ],
    },
    { // ADDED: Slash command for /setavatar
        name: 'setavatar',
        description: 'Sets the bot\'s profile picture (Administrator only).',
        options: [
            {
                name: 'url',
                type: ApplicationCommandOptionType.String,
                description: 'The URL of the image to set as the avatar.',
                required: false, // MODIFIED: Made optional
            },
            { // ADDED: Option to use a user's avatar
                name: 'user',
                type: ApplicationCommandOptionType.User,
                description: 'Use the avatar of this user.',
                required: false,
            },
        ],
    },
];

const TOKEN = process.env.DISCORD_BOT_TOKEN;

// ADDED: YouTube PO_TOKEN for bypassing certain restrictions (e.g., age-restricted videos)
// IMPORTANT: You need to obtain your own PO_TOKEN from YouTube.
// How to get your PO_TOKEN:
// 1. Go to a YouTube video in your browser.
// 2. Open your browser's developer tools (usually F12).
// 3. Go to the "Network" tab.
// 4. Filter for "player" requests (e.g., `youtubei/v1/player`).
// 5. In the request payload of such a request, find the `po_token` value (e.g., `web.gvs+<long_alphanumeric_string>`).
// 6. Replace 'YOUR_PO_TOKEN_HERE' below with your copied token.
const PO_TOKEN = 'YOUR_PO_TOKEN_HERE'; // <<< REPLACE THIS WITH YOUR ACTUAL PO_TOKEN

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function deployCommands() {
    try {
        console.log('Started refreshing application (/) commands.');

        // For guild-specific commands (faster updates during development)
        // await rest.put(
        //     Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        //     { body: commands },
        // );

        // For global commands (takes up to an hour to update)
        // Uncomment the line below and comment the above line if you want global commands
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error refreshing application (/) commands:', error);
    }
}

// When the client is ready, run this code (only once)
client.once('clientReady', async () => { // MODIFIED: Made async to await deployCommands
    console.log(`Logged in as ${client.user.tag}!`);
    // client.user.setActivity('with commands!'); // REMOVED: Replaced with setPresence for more control
    // Set the bot's presence to appear online with a mobile-like activity
    client.user.setPresence({
        activities: [{ name: 'me tgc :cmds yu', type: ActivityType.Playing }], // You can change 'a mobile game' to anything you like
        status: 'online', // Can be 'online', 'idle', 'dnd' (do not disturb)
    });
    await deployCommands(); // ADDED: Deploy slash commands on startup
});

// ADDED: Helper function to parse duration strings (e.g., "10s", "5m", "1h", "2d")
function parseDuration(durationStr) {
    const match = durationStr.match(/^(\d+)([smhd])$/);
    if (!match) return null;

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
        case 's': return value * 1000; // seconds to milliseconds
        case 'm': return value * 1000 * 60; // minutes to milliseconds
        case 'h': return value * 1000 * 60 * 60; // hours to milliseconds
        case 'd': return value * 1000 * 60 * 60 * 24; // days to milliseconds
        default: return null;
    }
}

// ADDED: Plugin management functions
async function loadPlugin(pluginName, guildId, channel) {
    const pluginPath = path.join(PLUGIN_DIR, `${pluginName}.js`);

    if (!fs.existsSync(pluginPath)) {
        return `Plugin \`${pluginName}\` not found.`;
    }

    if (plugins.has(pluginName)) {
        return `Plugin \`${pluginName}\` is already loaded.`;
    }

    try {
        // Clear module cache to allow hot-reloading
        delete require.cache[require.resolve(pluginPath)];
        const pluginModule = require(pluginPath);
        plugins.set(pluginName, pluginModule);

        if (typeof pluginModule.load === 'function') {
            await pluginModule.load(client, guildId, channel); // Pass client, guildId, channel
        }
        return `Plugin \`${pluginName}\` loaded successfully.`;
    } catch (error) {
        console.error(`Error loading plugin ${pluginName}:`, error);
        return `Failed to load plugin \`${pluginName}\`: ${error.message}`;
    }
}

async function unloadPlugin(pluginName, guildId, channel) {
    if (!plugins.has(pluginName)) {
        return `Plugin \`${pluginName}\` is not loaded.`;
    }

    try {
        const pluginModule = plugins.get(pluginName);
        if (typeof pluginModule.unload === 'function') {
            await pluginModule.unload(client, guildId, channel); // Pass client, guildId, channel
        }
        plugins.delete(pluginName);
        // Optionally clear module cache, but it's usually done before loading for hot-reloading
        delete require.cache[require.resolve(path.join(PLUGIN_DIR, `${pluginName}.js`))]; // ADDED: Clear module cache on unload
        return `Plugin \`${pluginName}\` unloaded successfully.`;
    } catch (error) {
        console.error(`Error unloading plugin ${pluginName}:`, error);
        return `Failed to unload plugin \`${pluginName}\`: ${error.message}`;
    }
}

function listPlugins() {
    try {
        const availablePlugins = fs.readdirSync(PLUGIN_DIR)
            .filter(file => file.endsWith('.js'))
            .map(file => path.basename(file, '.js'));

        let response = '**Available Plugins:**\n';
        if (availablePlugins.length === 0) {
            response += 'No plugins found in the `plugins` directory.\n';
        } else {
            response += availablePlugins.map(p => {
                const status = plugins.has(p) ? ' (Loaded)' : ' (Unloaded)';
                return `\`${p}\`${status}`;
            }).join('\n');
        }
        return response;
    } catch (error) {
        console.error('Error listing plugins:', error);
        return 'Failed to list plugins.';
    }
}

// ADDED: Function to reload all currently loaded plugins
async function reloadAllPlugins(client, guildId, channel) {
    const loadedPluginNames = Array.from(plugins.keys());
    let results = [];

    // Unload all currently loaded plugins
    for (const pluginName of loadedPluginNames) {
        const unloadResult = await unloadPlugin(pluginName, guildId, channel);
        results.push(`- ${unloadResult}`);
    }

    // Then load them back
    for (const pluginName of loadedPluginNames) {
        const loadResult = await loadPlugin(pluginName, guildId, channel);
        results.push(`- ${loadResult}`);
    }
    return results.join('\n');
}

// Listen for messages
client.on('messageCreate', async message => {
    // Ignore messages from bots and messages that don't start with the prefix
    if (!message.content.startsWith(prefix) || message.author.bot) return;

    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // --- General Commands ---
    if (command === 'help') {
        const helpMessage = `
**Available Commands:**
\`!help\` - Displays this help message.
\`!changelog\` - Shows recent changes to the bot.
\`!test\` - Bot responds with "Test successful!".
\`!nsfw\` - Bot responds with a warning.
\`!roll <XdY>\` - Rolls X dice with Y sides (e.g., !roll 2d6).

**Moderation (Requires Permissions):**
\`!kick @user [reason]\` - Kicks a member. (Kick Members)
\`!ban @user [reason]\` - Bans a member. (Ban Members)
\`!timeout @user <duration> [reason]\` - Times out a member (e.g., 10s, 5m, 1h, 2d). (Moderate Members)
\`!untimeout @user [reason]\` - Removes timeout from a member. (Moderate Members)
\`!create <count>\` - Creates multiple messages in the current channel (max 100). (Administrator)
\`!createchannels <count>\` - Creates multiple text channels (max 50). (Manage Channels)
\`!nukechannel\` - Deletes and recreates the current channel. (Administrator)
\`!nuke\` - Alias for !nukechannel. (Administrator)
\`!deletebot\` - Deletes up to 1000 bot messages/polls. (Manage Messages)
\`!say <message>\` - Bot says a message. (Administrator)
\`!role @user <role name>\` - Adds/removes a role from a user. (Administrator)
\`!rank @user <role1> [role2]...\` - Assigns multiple roles to a user (e.g., admin, mod, vip, creator). (Manage Roles)
\`!mutevoice @user [reason]\` - Voice mutes a member. (Mute Members)
\`!unmutevoice @user [reason]\` - Voice unmutes a member. (Mute Members)
\`!messagecall @user <message>\` - Sends a direct message to a mentioned user. (Administrator)
\`!fakemessage @user|bot <message>\` - Sends a message as another user or the bot using webhooks. (Administrator)

**Voice & Soundboard (Requires Speak Permission):**
\`!call\` - Makes the bot join your current voice channel. (Administrator)
\`!callvoice #channel <filename.mp4>\` - Plays video audio in a specified voice channel from the 'videos' directory. (Administrator)
\`!playsound [clipname.mp3]\` - Plays a soundboard clip from 'soundboard_clips'.
\`!listsounds\` - Lists available soundboard clips.
\`!ytplay <YouTube URL>\` - Plays audio from a YouTube video in your voice channel.
\`!livestream <URL>\` - Plays a live audio stream from a URL in your voice channel.
\`!playvideo <filename.mp4>\` - Plays video audio from the 'videos' directory in your voice channel.
\`!stop\` - Stops any playing audio/video and leaves the voice channel.
\`!stopvideo\` - (Alias for !stop) Stops any playing audio/video and leaves the voice channel.
\`!leave\` - Stops any playing audio/video and leaves the voice channel.
\`!sharescreen\` - Explains screen sharing limitations.
\`!speakerphone [@[user]]\` - Explains speakerphone limitations.
\`!phone call @user\` - Initiates a simulated voice call to a user.
\`!phone hangup\` - Ends the current simulated voice call.
\`!onlinephone call @user\` - (Alias for !phone) Initiates a simulated voice call to a user.
\`!onlinephone hangup\` - (Alias for !phone) Ends the current simulated voice call.
\`!phonecommand call @user\` - (Alias for !phone) Initiates a simulated voice call to a user.
\`!phonecommand hangup\` - (Alias for !phone) Ends the current simulated voice call.

**Plugins & Development (Requires Administrator):**
\`!plugin load <pluginName>\` - Loads an installed plugin.
\`!plugin unload <pluginName>\` - Unloads a plugin. // MODIFIED: Corrected description
\`!plugin list\` - Lists installed plugins and their status.
\`!download <url> [filename]\` - Downloads a file from a URL to the 'downloads' directory.
\`!npmdownload <package-name>\` - Downloads an npm package tarball to the 'downloads' directory.
\`!downloadvideo <youtube_url> [filename]\` - Downloads a video from a URL to the 'videos' directory.
\`!downloadsound <youtube_url> [filename]\` - Downloads audio from a URL to the 'soundboard_clips' directory.
\`!listvideos\` - Lists available video files.
\`!update\` - Pulls latest code from Git and reloads all loaded plugins. // MODIFIED: Updated description
\`!runpy <python_code>\` - Executes Python code. (Administrator)
\`!setavatar <image_url>\` - Sets bot's profile picture.
\`!avatar @user\` - Displays user's avatar.
\`!chat <message>\` - Interacts with AI chatbot (placeholder).
\`!control [status|activity|clear] <args>\` - Manages bot's online status and activity. (Administrator)
\`!youtubeupload <file_path> <title> [description] [tags]\` - Uploads a local video file to YouTube (complex, placeholder). (Administrator)
\`!addyoutubeupload <file_path> <title> [description] [tags]\` - Alias for \`!youtubeupload\`. (Administrator)

**Utility:**
\`!alert [#channel] <message>\` - Sends an alert message.
\`!sendmessage @user <message>\` - Sends a direct message to a user.
\`!snedmessage @user <message>\` - Sends a direct message to a user (typo version).
\`!nuksendemessage @user <message>\` - Sends a direct message to a user (typo version).
\`!nukesendmessage @user <message>\` - Sends a direct message to a user (typo version).
\`!dm @user <message>\` - Sends a direct message to a user (alias for !sendmessage).
\`!hackedaccount\` - Provides steps to take if your Discord account is compromised.
\`!hackedmessage @user\` - Sends security alert to potentially compromised account.

**Nuke Commands (Administrator):**
\`!nuke\` - Nukes (deletes and recreates) the current channel.
\`!n\` - Alias for !nuke.
\`!nukeflood <messageCount> [notify]\` - Nukes channel and sends multiple messages.
\`!nf <messageCount>\` - Alias for !nukeflood.
\`!nukeclean\` - Nukes channel and prevents message history.
\`!nc\` - Alias for !nukeclean.
\`!stop\` - Stops ongoing nuke operations.
        `;
        // Split the help message into chunks if it's too long
        const helpChunks = helpMessage.match(/[\s\S]{1,1900}/g); // Split into chunks of ~1900 characters
        for (const chunk of helpChunks) {
            await message.channel.send(chunk);
        }
    }

    // --- !cmds command (NEW) ---
    else if (command === 'cmds') {
        const cmdsMessage = `
**Available Commands (Prefix: \`!\`):**
\`help\`, \`changelog\`, \`test\`, \`nsfw\`, \`roll\`,
\`kick\`, \`ban\`, \`timeout\`, \`untimeout\`, \`create\`, \`createchannels\`, \`nuke\`, \`n\`, \`nukeflood\`, \`nf\`, \`nukeclean\`, \`nc\`, \`deletebot\`, \`say\`, \`role\`, \`rank\`, \`mutevoice\`, \`unmutevoice\`, \`messagecall\`,
\`call\`, \`callvoice\`, \`playsound\`, \`listsounds\`, \`ytplay\`, \`livestream\`, \`playvideo\`, \`stop\`, \`stopvideo\`, \`leave\`, \`sharescreen\`, \`speakerphone\`, \`phone\`, \`onlinephone\`, \`phonecommand\`,
\`plugin\`, \`download\`, \`npmdownload\`, \`downloadvideo\`, \`downloadsound\`, \`listvideos\`, \`update\`, \`setavatar\`, \`avatar\`, \`chat\`, \`control\`, \`youtubeupload\`, \`addyoutubeupload\`,
\`alert\`, \`sendmessage\`, \`snedmessage\`, \`nuksendemessage\`, \`nukesendmessage\`, \`hackedaccount\`, \`addsupport\`, \`addrules\`, \`runpy\`, \`devbadgedeveloperdiscord\`, \`dm\`, \`fakemessage\`
        `;
        // Split the message into chunks if it's too long
        const cmdsChunks = cmdsMessage.match(/[\s\S]{1,1900}/g);
        for (const chunk of cmdsChunks) {
            await message.channel.send(chunk);
        }
    }

    // --- !changelog command ---
    else if (command === 'changelog') {
        const changelogMessage = `
**Bot Changelog:**
- **v1.0.0 (2025-11-07):**
    - Initial release with \`help\`, \`changelog\`, \`call\`, \`playsound\`, \`playvideo\` commands.
    - Basic voice channel functionality implemented.
- **v1.1.0 (2025-11-08):**
    - Added moderation commands: \`kick\`, \`ban\`, \`timeout\`, \`untimeout\`, \`mutevoice\`, \`unmutevoice\`.
    - Added utility commands: \`create\`, \`createchannels\`, \`nukechannel\`, \`role\`, \`download\`.
    - Enhanced voice commands: \`callvoice\`, modified \`playvideo\` for local files, improved \`playsound\` with soundboard clips.
    - Added communication commands: \`alert\`, \`sendmessage\`, \`snedmessage\`.
- **v1.2.0 (2025-11-09):**
    - Added \`downloadvideo\` and \`downloadsound\` commands using yt-dlp.
- **v1.3.0 (2025-11-10):** // ADDED: New changelog entry
    - Implemented new general commands: \`test\`, \`nsfw\`, \`roll\`.
    - Added moderation commands: \`deletebot\`, \`say\`.
    - Enhanced voice commands: \`listsounds\`, \`ytplay\`, \`livestream\`, \`stop\`, \`stopvideo\`, \`sharescreen\`, \`speakerphone\`.
    - Added plugin/dev commands: \`plugin\`, \`listvideos\`, \`update\`, \`setavatar\`, \`avatar\`, \`chat\`.
    - Added utility commands: \`hackedaccount\`, \`addsupport\`, \`addrules\`, \`runpy\`.
    - Integrated Discord Slash Commands for various functionalities.
    - **FIX:** Corrected \`plugin unload\` to actually unload plugins.
    - **NEW:** Implemented \`update\` command to pull latest code from Git and hot-reload plugins.
    - **NEW:** Added \`phone call @user\` and \`phone hangup\` for simulated voice calls.
    - **NEW:** Added \`onlinephone\` as an alias for the \`phone\` command.
    - **NEW:** Added \`phonecommand\` as an alias for the \`phone\` command.
    - **NEW:** Added \`rank @user <role1> [role2]...\` command for assigning multiple roles.
    - **ENHANCEMENT:** \`download\`, \`downloadvideo\`, \`downloadsound\` now support both YouTube URLs and direct file links.
    - **NEW:** Added \`control\` command to manage bot's online status and activity.
    - **NEW:** Added \`youtubeupload\` (placeholder) command.
    - **NEW:** Added \`addyoutubeupload\` as an alias for \`youtubeupload\`.
    - **NEW:** Added \`nuksendemessage\` as another typo variant for \`sendmessage\`.
    - **NEW:** Added \`dm\` as an alias for \`sendmessage\`.
    - **NEW:** Added \`fakemessage @user <message>\` command to send messages as another user via webhooks.
    - **ENHANCEMENT:** \`fakemessage\` can now use the bot's identity via the \`bot\` keyword. \`/fakemessage\` now supports overriding the display name.
    - **FIX:** Reworked \`yt-dlp\` download commands (\`!download\`, \`!downloadvideo\`, \`!downloadsound\`) for better progress reporting and error handling. Made \`!download\` a generic file downloader.
    - **NEW:** Added \`nuke\` as an alias for \`nukechannel\`.
    - **NEW:** Added nuke interface with aliases (!n, !nf, !nc) and clean options.
    - **NEW:** Added \`!npmdownload <package-name>\` to download package tarballs from npm.
        `;
        // Split the changelog message into chunks if it's too long
        const changelogChunks = changelogMessage.match(/[\s\S]{1,1900}/g); // Split into chunks of ~1900 characters
        for (const chunk of changelogChunks) {
            await message.channel.send(chunk);
        }
    }

    // --- Add the new nukeflood command ---
    else if (command === 'nukeflood') {
        // Require Administrator permission
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You need Administrator permission to use this command.');
        }

        const messageCount = parseInt(args[0]);
        const shouldNotify = args[0.1]?.toLowerCase() === 'notify';

        // Validate message count
        if (isNaN(messageCount) || messageCount < 1 || messageCount > 1000) {
            return message.reply('Please provide a valid number of messages (1-1000).');
        }

        const currentChannel = message.channel;
        if (!currentChannel.deletable) {
            return message.reply('I cannot delete this channel. It might be a system channel or I lack permissions.');
        }

        try {
            const channelName = currentChannel.name;
            const channelTopic = currentChannel.topic;
            const channelParent = currentChannel.parent;
            const channelPosition = currentChannel.position;
            const channelPermissions = currentChannel.permissionOverwrites.cache;

            // Delete the current channel
            await currentChannel.delete();
            
            // Create new channel with same settings
            const newChannel = await message.guild.channels.create({
                name: channelName,
                type: currentChannel.type,
                topic: channelTopic,
                parent: channelParent,
                position: channelPosition,
            });

            // Restore permissions
            channelPermissions.forEach(perm => {
                newChannel.permissionOverwrites.create(perm.id, perm.toJSON());
            });

            // Send initial message
            await newChannel.send(`Channel nuked by ${message.author}! Starting flood...`);

            // Send messages with rate limiting
            let sent = 0;
            const batchSize = 5; // Send messages in batches of 5
            const delay = 1000; // 1 second delay between batches

            while (sent < messageCount) {
                const batch = Math.min(batchSize, messageCount - sent);
                const promises = [];

                for (let i = 0; i < batch; i++) {
                    const messageContent = shouldNotify ? 
                        `@everyone Message ${sent + i + 1}/${messageCount}` :
                        `Message ${sent + i + 1}/${messageCount}`;
                    promises.push(newChannel.send(messageContent));
                }

                await Promise.all(promises);
                sent += batch;

                if (sent < messageCount) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            await newChannel.send('✅ Nuke flood complete!');

        } catch (error) {
            console.error('Error in nukeflood command:', error);
            message.author.send(`Failed to complete nukeflood: ${error.message}`).catch(() => {});
        }
    }

    // --- Nuke Interface Commands ---
    else if (['nuke', 'n', 'nukechannel'].includes(command)) {
        if (!message.member.permissions.has('ManageChannels')) {
            return message.reply('You need Administrator permission to use nuke commands.');
        }

        const currentChannel = message.channel;
        if (!currentChannel.deletable) {
            return message.reply('I cannot delete this channel. It might be a system channel or I lack permissions.');
        }

        try {
            const channelName = currentChannel.name;
            const channelTopic = currentChannel.topic;
            const channelParent = currentChannel.parent;
            const channelPosition = currentChannel.position;
            const channelPermissions = currentChannel.permissionOverwrites.cache;

            await currentChannel.delete();
            const newChannel = await message.guild.channels.create({
                name: channelName,
                type: currentChannel.type,
                topic: channelTopic,
                parent: channelParent,
                position: channelPosition,
            });

            channelPermissions.forEach(perm => {
                newChannel.permissionOverwrites.create(perm.id, perm.toJSON());
            });

            newChannel.send(`🌋 Channel nuked by ${message.author}!`);
        } catch (error) {
            console.error('Error in nuke command:', error);
            message.reply('Failed to nuke channel.');
        }
    }

    else if (['nukeclean', 'nc'].includes(command)) {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You need Administrator permission to use nuke commands.');
        }

        const currentChannel = message.channel;
        if (!currentChannel.deletable) {
            return message.reply('I cannot delete this channel. It might be a system channel or I lack permissions.');
        }

        try {
            const channelName = currentChannel.name;
            const channelTopic = currentChannel.topic;
            const channelParent = currentChannel.parent;
            const channelPosition = currentChannel.position;
            const channelPermissions = currentChannel.permissionOverwrites.cache;

            await currentChannel.delete();
            
            const newChannel = await message.guild.channels.create({
                name: channelName,
                type: currentChannel.type,
                topic: channelTopic,
                parent: channelParent,
                position: channelPosition,
            });

            channelPermissions.forEach(perm => {
                newChannel.permissionOverwrites.create(perm.id, perm.toJSON());
            });

            const cleanupMessage = await newChannel.send(`🧹 Channel cleaned by ${message.author}!`);
            setTimeout(() => cleanupMessage.delete().catch(() => {}), 5000);

        } catch (error) {
            console.error('Error in nukeclean command:', error);
            message.author.send(`Failed to clean channel: ${error.message}`).catch(() => {});
        }
    }

    // --- General Commands ---
    else if (command === 'test') { // ADDED: !test command
        message.channel.send('Test successful!');
    }

    else if (command === 'nsfw') { // ADDED: !nsfw command
        message.channel.send('⚠️ This channel is not marked as NSFW. Please use NSFW commands in appropriate channels.');
    }

    else if (command === 'roll') { // ADDED: !roll command
        const rollInput = args[0]; // e.g., 2d6
        if (!rollInput) {
            return message.reply('Please provide a dice roll in the format XdY (e.g., `!roll 2d6`).');
        }

        const match = rollInput.match(/^(\d+)d(\d+)$/i);
        if (!match) {
            return message.reply('Invalid dice roll format. Use XdY (e.g., `!roll 2d6`).');
        }

        const numDice = parseInt(match[1]);
        const numSides = parseInt(match[2]);

        if (isNaN(numDice) || isNaN(numSides) || numDice <= 0 || numSides <= 0) {
            return message.reply('Number of dice and sides must be positive integers.');
        }
        if (numDice > 100 || numSides > 1000) {
            return message.reply('Please keep the number of dice (max 100) and sides (max 1000) reasonable.');
        }

        let results = [];
        let total = 0;
        for (let i = 0; i < numDice; i++) {
            const roll = Math.floor(Math.random() * numSides) + 1;
            results.push(roll);
            total += roll;
        }

        message.channel.send(`🎲 Rolling ${numDice}d${numSides}: [${results.join(', ')}] Total: **${total}**`);
    }

    // --- Moderation Commands ---
    else if (command === 'kick') {
        if (!message.member.permissions.has('KickMembers')) {
            return message.reply('You do not have permission to kick members.');
        }
        const member = message.mentions.members.first();
        if (!member) {
            return message.reply('Please mention the member you want to kick.');
        }
        if (!member.kickable) {
            return message.reply('I cannot kick this member. They might have a higher role or I lack permissions.');
        }
        const reason = args.slice(1).join(' ') || 'No reason provided.';
        try {
            await member.kick(reason);
            message.channel.send(`${member.user.tag} has been kicked. Reason: ${reason}`);
        } catch (error) {
            console.error('Error kicking member:', error);
            message.reply('Failed to kick the member.');
        }
    }

    else if (command === 'ban') {
        if (!message.member.permissions.has('BanMembers')) {
            return message.reply('You do not have permission to ban members.');
        }
        const member = message.mentions.members.first();
        if (!member) {
            return message.reply('Please mention the member you want to ban.');
        }
        if (!member.bannable) {
            return message.reply('I cannot ban this member. They might have a higher role or I lack permissions.');
        }
        const reason = args.slice(1).join(' ') || 'No reason provided.';
        try {
            await member.ban({ reason });
            message.channel.send(`${member.user.tag} has been banned. Reason: ${reason}`);
        } catch (error) {
            console.error('Error banning member:', error);
            message.reply('Failed to ban the member.');
        }
    }

    else if (command === 'timeout') {
        if (!message.member.permissions.has('ModerateMembers')) {
            return message.reply('You do not have permission to timeout members.');
        }
        const member = message.mentions.members.first();
        if (!member) {
            return message.reply('Please mention the member you want to timeout.');
        }
        const durationStr = args[1];
        if (!durationStr) {
            return message.reply('Please provide a duration for the timeout (e.g., 10s, 5m, 1h, 2d).');
        }
        const durationMs = parseDuration(durationStr);
        if (durationMs === null || durationMs <= 0) {
            return message.reply('Invalid duration format. Use (e.g., 10s, 5m, 1h, 2d).');
        }
        if (!member.moderatable) {
            return message.reply('I cannot timeout this member. They might have a higher role or I lack permissions.');
        }
        const reason = args.slice(2).join(' ') || 'No reason provided.';
        try {
            await member.timeout(durationMs, reason);
            message.channel.send(`${member.user.tag} has been timed out for ${durationStr}. Reason: ${reason}`);
        } catch (error) {
            console.error('Error timing out member:', error);
            message.reply('Failed to timeout the member.');
        }
    }

    else if (command === 'untimeout') {
        if (!message.member.permissions.has('ModerateMembers')) {
            return message.reply('You do not have permission to remove timeouts.');
        }
        const member = message.mentions.members.first();
        if (!member) {
            return message.reply('Please mention the member you want to untimeout.');
        }
        if (!member.moderatable) {
            return message.reply('I cannot untimeout this member. They might have a higher role or I lack permissions.');
        }
        const reason = args.slice(1).join(' ') || 'No reason provided.';
        try {
            await member.timeout(null, reason); // Set timeout to null to remove it
            message.channel.send(`${member.user.tag}'s timeout has been removed. Reason: ${reason}`);
        } catch (error) {
            console.error('Error removing timeout:', error);
            message.reply('Failed to remove timeout from the member.');
        }
    }

    else if (command === 'mutevoice') {
        if (!message.member.permissions.has('MuteMembers')) {
            return message.reply('You do not have permission to voice mute members.');
        }
        const member = message.mentions.members.first();
        if (!member) {
            return message.reply('Please mention the member you want to voice mute.');
        }
        if (!member.voice.channel) {
            return message.reply(`${member.user.tag} is not in a voice channel.`);
        }
        if (!member.manageable) {
            return message.reply('I cannot voice mute this member. They might have a higher role or I lack permissions.');
        }
        const reason = args.slice(1).join(' ') || 'No reason provided.';
        try {
            await member.voice.setMute(true, reason);
            message.channel.send(`${member.user.tag} has been voice muted. Reason: ${reason}`);
        } catch (error) {
            console.error('Error voice muting member:', error);
            message.reply('Failed to voice mute the member.');
        }
    }

    else if (command === 'unmutevoice') {
        if (!message.member.permissions.has('MuteMembers')) {
            return message.reply('You do not have permission to voice unmute members.');
        }
        const member = message.mentions.members.first();
        if (!member) {
            return message.reply('Please mention the member you want to voice unmute.');
        }
        if (!member.voice.channel) {
            return message.reply(`${member.user.tag} is not in a voice channel.`);
        }
        if (!member.manageable) {
            return message.reply('I cannot voice unmute this member. They might have a higher role or I lack permissions.');
        }
        const reason = args.slice(1).join(' ') || 'No reason provided.';
        try {
            await member.voice.setMute(false, reason);
            message.channel.send(`${member.user.tag} has been voice unmuted. Reason: ${reason}`);
        } catch (error) {
            console.error('Error voice unmuting member:', error);
            message.reply('Failed to voice unmute the member.');
        }
    }

    // --- Message/Channel Management Commands ---
    else if (command === 'create') {
        const count = parseInt(args[0]);
        if (isNaN(count) || count <= 0 || count > 100) {
            return message.reply('Please provide a valid number of messages to create (1-100).');
        }
        try {
            for (let i = 0; i < count; i++) {
                await message.channel.send(`Message ${i + 1}/${count}`);
            }
            message.channel.send(`Created ${count} messages.`);
        } catch (error) {
            console.error('Error creating messages:', error);
            message.reply('Failed to create messages.');
        }
    }

    else if (command === 'createchannels') {
        if (!message.member.permissions.has('ManageChannels')) {
            return message.reply('You do not have permission to create channels.');
        }
        const count = parseInt(args[0]);
        if (isNaN(count) || count <= 0 || count > 50) {
            return message.reply('Please provide a valid number of channels to create (1-50).');
        }
        try {
            for (let i = 0; i < count; i++) {
                await message.guild.channels.create({
                    name: `new-channel-${Date.now()}-${i}`,
                    type: 0, // 0 for text channel
                });
            }
            message.channel.send(`Created ${count} new text channels.`);
        } catch (error) {
            console.error('Error creating channels:', error);
            message.reply('Failed to create channels.');
        }
    }

    else if (command === 'nukechannel' || command === 'nuke') {
        if (!message.member.permissions.has('ManageChannels')) {
            return message.reply('You do not have permission to nuke channels.');
        }
        const currentChannel = message.channel;
        if (!currentChannel.deletable) {
            return message.reply('I cannot delete this channel. It might be a system channel or I lack permissions.');
        }

        try {
            const channelName = currentChannel.name;
            const channelTopic = currentChannel.topic;
            const channelParent = currentChannel.parent;
            const channelPosition = currentChannel.position;
            const channelPermissions = currentChannel.permissionOverwrites.cache;

            await currentChannel.delete();
            const newChannel = await message.guild.channels.create({
                name: channelName,
                type: currentChannel.type,
                topic: channelTopic,
                parent: channelParent,
                position: channelPosition,
            });

            // Apply old permissions to the new channel
            channelPermissions.forEach(perm => {
                newChannel.permissionOverwrites.create(perm.id, perm.toJSON());
            });

            newChannel.send(`This channel has been nuked and recreated by ${message.author}!`);
        } catch (error) {
            console.error('Error nuking channel:', error);
            message.reply('Failed to nuke the channel.');
        }
    }

    else if (command === 'deletebot') { // ADDED: !deletebot command
        if (!message.member.permissions.has('ManageMessages')) {
            return message.reply('You do not have permission to delete messages.');
        }

        try {
            const fetchedMessages = await message.channel.messages.fetch({ limit: 100 });
            const botMessages = fetchedMessages.filter(msg => msg.author.id === client.user.id);

            if (botMessages.size === 0) {
                return message.channel.send('No bot messages found in the last 100 messages.');
            }

            await message.channel.bulkDelete(botMessages, true);
            message.channel.send(`Deleted ${botMessages.size} bot messages.`);
        } catch (error) {
            console.error('Error deleting bot messages:', error);
            message.reply('Failed to delete bot messages. Make sure I have "Manage Messages" permission.');
        }
    }

    else if (command === 'say') { // ADDED: !say command
        if (!message.member.permissions.has('Administrator')) { // Prompt specifies Administrator
            return message.reply('You do not have permission to use this command.');
        }
        const text = args.join(' ');
        if (!text) {
            return message.reply('Please provide a message for me to say.');
        }
        message.delete().catch(console.error); // Delete the command message
        const sentMessage = await message.channel.send(text);
        setTimeout(() => {
            sentMessage.delete().catch(console.error);
        }, 5000); // ADDED: Delete bot's message after 5 seconds
    }

    else if (command === 'role') {
        if (!message.member.permissions.has('ManageRoles')) {
            return message.reply('You do not have permission to manage roles.');
        }
        const member = message.mentions.members.first();
        if (!member) {
            return message.reply('Please mention the member you want to assign/remove a role from.');
        }
        const roleName = args.slice(1).join(' ');
        if (!roleName) {
            return message.reply('Please provide a role name.');
        }

        const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
        if (!role) {
            return message.reply(`Role "${roleName}" not found.`);
        }
        if (role.position >= message.guild.members.me.roles.highest.position) {
            return message.reply('I cannot manage this role as it is higher than or equal to my highest role.');
        }

        try {
            if (member.roles.cache.has(role.id)) {
                await member.roles.remove(role);
                message.channel.send(`Removed role **${role.name}** from ${member.user.tag}.`);
            } else {
                await member.roles.add(role);
                message.channel.send(`Added role **${role.name}** to ${member.user.tag}.`);
            }
        } catch (error) {
            console.error('Error managing role:', error);
            message.reply('Failed to manage the role. Make sure the role exists and I have permissions.');
        }
    }

    // --- !rank command (NEW) ---
    else if (command === 'rank') {
        if (!message.member.permissions.has('ManageRoles')) {
            return message.reply('You do not have permission to manage roles.');
        }

        const member = message.mentions.members.first();
        if (!member) {
            return message.reply('Please mention the member you want to assign roles to.');
        }

        const roleNames = args.slice(1).map(arg => arg.toLowerCase());
        if (roleNames.length === 0) {
            return message.reply('Please provide at least one role name to assign (e.g., `!rank @user admin mod vip`).');
        }

        const assignedRoles = [];
        const failedRoles = [];

        for (const roleName of roleNames) {
            const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleName);
            if (!role) {
                failedRoles.push(`\`${roleName}\` (not found)`);
                continue;
            }
            if (role.position >= message.guild.members.me.roles.highest.position) {
                failedRoles.push(`\`${roleName}\` (bot cannot manage)`);
                continue;
            }
            if (member.roles.cache.has(role.id)) {
                failedRoles.push(`\`${roleName}\` (already has)`);
                continue;
            }

            try {
                await member.roles.add(role);
                assignedRoles.push(`\`${role.name}\``);
            } catch (error) {
                console.error(`Error adding role ${role.name} to ${member.user.tag}:`, error);
                failedRoles.push(`\`${role.name}\` (failed to add)`);
            }
        }

        let response = `**Role assignment for ${member.user.tag}:**\n`;
        if (assignedRoles.length > 0) {
            response += `✅ Added: ${assignedRoles.join(', ')}\n`;
        }
        if (failedRoles.length > 0) {
            response += `❌ Failed: ${failedRoles.join(', ')}\n`;
        }
        if (assignedRoles.length === 0 && failedRoles.length === 0) {
            response += 'No roles were assigned or found.';
        }
        message.channel.send(response);
    }

    // --- Voice Commands ---
    // Check if the user is in a voice channel for voice commands
    const voiceChannel = message.member?.voice.channel; // ADDED: Define voiceChannel here for message commands
    const voiceCommands = ['call', 'playsound', 'playvideo', 'leave', 'callvoice', 'ytplay', 'livestream', 'stop', 'stopvideo', 'sharescreen', 'speakerphone', 'phone', 'onlinephone', 'phonecommand']; // MODIFIED: Added new voice commands
    if (voiceCommands.includes(command) && !voiceChannel && command !== 'callvoice' && command !== 'sharescreen' && command !== 'speakerphone' && !(command === 'phone' && args[0] === 'hangup') && !(command === 'onlinephone' && args[0] === 'hangup') && !(command === 'phonecommand' && args[0] === 'hangup')) { // MODIFIED: Exclude sharescreen/speakerphone/phone hangup/onlinephone hangup/phonecommand hangup from requiring user in VC
        return message.reply('You need to be in a voice channel to use this command!');
    }

    // --- !call command ---
    if (command === 'call') {
        if (!message.member.permissions.has('Administrator')) { // Prompt specifies Administrator
            return message.reply('You do not have permission to use this command.');
        }
        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });
            connections.set(message.guild.id, connection);
            message.reply(`Joined voice channel: **${voiceChannel.name}**`);
        } catch (error) {
            console.error('Error joining voice channel:', error);
            message.reply('Failed to join the voice channel.');
        }
    }

    // --- !playsound command (MODIFIED for soundboard clips) ---
    else if (command === 'playsound') {
        const clipName = args[0];

        if (!clipName) {
            return message.reply('Please provide a soundboard clip name to play, or use `!listsounds` to see available clips.');
        }

        const filePath = path.join(SOUNDBOARD_DIR, clipName);
        if (!fs.existsSync(filePath)) {
            return message.reply(`Sound clip \`${clipName}\` not found in the \`soundboard_clips\` directory.`);
        }

        const connection = connections.get(message.guild.id);
        if (!connection) {
            return message.reply('I am not in a voice channel. Use `!call` first.');
        }

        try {
            const player = players.get(message.guild.id) || createAudioPlayer();
            players.set(message.guild.id, player);

            const resource = createAudioResource(filePath);
            player.play(resource);
            connection.subscribe(player);

            player.on(AudioPlayerStatus.Playing, () => {
                message.channel.send(`Now playing soundboard clip: \`${clipName}\``);
            });

            player.on('error', error => {
                console.error(`Error playing soundboard clip: ${error.message}`);
                message.channel.send(`Failed to play soundboard clip: ${error.message}`);
            });

        } catch (error) {
            console.error('Error playing soundboard clip:', error);
            message.reply(`Failed to play soundboard clip: ${error.message}. Make sure the file path is correct and accessible.`);
        }
    }

    // --- !listsounds command (NEW) ---
    else if (command === 'listsounds') {
        try {
            const files = fs.readdirSync(SOUNDBOARD_DIR)
                .filter(file => file.endsWith('.mp3') || file.endsWith('.wav'))
                .map(file => `\`${file}\``);
            if (files.length === 0) {
                return message.channel.send('No soundboard clips found in the `soundboard_clips` directory.');
            }
            return message.channel.send(`Available soundboard clips:\n${files.join(', ')}`);
        } catch (error) {
            console.error('Error reading soundboard directory:', error);
            return message.channel.send('Failed to list soundboard clips.');
        }
    }

    // --- !ytplay command (NEW) ---
    else if (command === 'ytplay') {
        const url = args[0];
        if (!url) {
            return message.reply('Please provide a YouTube URL.');
        }

        const connection = connections.get(message.guild.id);
        if (!connection) {
            return message.reply('I am not in a voice channel. Use `!call` first.');
        }

        try {
            message.channel.send(`Attempting to play YouTube audio from: \`${url}\`...`);

            const player = players.get(message.guild.id) || createAudioPlayer();
            players.set(message.guild.id, player);

            // Use yt-dlp to stream audio directly
            const ytDlpProcess = ytDlp.exec([
                url,
                '-f', 'bestaudio[ext=webm+acodec=opus]/bestaudio',
                '-o', '-',
                '--no-playlist',
                '--quiet',
                '--no-warnings',
                '--extractor-args', `youtube:po_token=${PO_TOKEN}`, // MODIFIED: Use PO_TOKEN constant
            ], { stdio: ['ignore', 'pipe', 'ignore'] });

            // ADDED: Error handling for yt-dlp process
            ytDlpProcess.on('error', (err) => {
                console.error('yt-dlp process error:', err);
                message.channel.send('Failed to start YouTube audio process. Please try again later.');
                // Clean up connection and player if an error occurs
                if (connection) connection.destroy();
                if (player) player.stop();
            });

            ytDlpProcess.on('close', (code) => {
                if (code !== 0) {
                    console.error(`yt-dlp process exited with code ${code}`);
                    // Only reply if not already replied by an error event
                    if (!message.replied && !message.deferred) {
                        message.channel.send('YouTube audio process exited unexpectedly. Please try again later.');
                    }
                    // Clean up connection and player if an error occurs
                    if (connection) connection.destroy();
                    if (player) player.stop();
                }
            });

            const audioStream = ytDlpProcess.stdout;

            const resource = createAudioResource(audioStream);
            player.play(resource);
            connection.subscribe(player);

            ytDlpProcess.on('error', (error) => {
                console.error(`yt-dlp process error (slash): ${error.message}`);
                message.channel.send(`An error occurred while trying to stream audio.`);
                player.stop();
            });

            player.on(AudioPlayerStatus.Playing, () => {
                message.channel.send(`Now playing YouTube audio!`);
            });

            player.on('error', error => {
                console.error(`Error playing YouTube audio: ${error.message}`);
                message.channel.send(`Failed to play YouTube audio: ${error.message}`);
            });

        } catch (error) {
            console.error('Error in /ytplay slash command:', error);
            message.reply(`Failed to play YouTube audio: ${error.message}. Make sure the URL is correct and yt-dlp is working.`);
        }
    }

    // --- !livestream command (NEW) ---
    else if (command === 'livestream') {
        const url = args[0];
        if (!url) {
            return message.reply('Please provide a live audio stream URL.');
        }

        const connection = connections.get(message.guild.id);
        if (!connection) {
            return message.reply('I am not in a voice channel. Use `!call` first.');
        }

        try {
            message.channel.send(`Attempting to play live stream from: \`${url}\`...`);

            const player = players.get(message.guild.id) || createAudioPlayer();
            players.set(message.guild.id, player);

            const resource = createAudioResource(url); // createAudioResource can handle URLs directly for streams
            player.play(resource);
            connection.subscribe(player);

            player.on(AudioPlayerStatus.Playing, () => {
                message.channel.send(`Now playing live stream!`);
            });

            player.on('error', error => {
                console.error(`Error playing live stream: ${error.message}`);
                message.channel.send(`Failed to play live stream: ${error.message}`);
            });

        } catch (error) {
            console.error('Error in /livestream slash command:', error);
            message.reply(`Failed to play live stream: ${error.message}. Make sure the URL is a valid audio stream.`);
        }
    }

    // --- !playvideo command (MODIFIED for local video files) ---
    else if (command === 'playvideo') {
        const filename = args[0];
        if (!filename) {
            return message.reply('Please provide a filename (e.g., `video.mp4`) from the `videos` directory.');
        }

        const filePath = path.join(VIDEOS_DIR, filename);
        if (!fs.existsSync(filePath)) {
            return message.reply(`Video file \`${filename}\` not found in the \`videos\` directory.`);
        }

        const connection = connections.get(message.guild.id);
        if (!connection) {
            return message.reply('I am not in a voice channel. Use `!call` first.');
        }

        try {
            const player = players.get(message.guild.id) || createAudioPlayer();
            players.set(message.guild.id, player);

            const resource = createAudioResource(filePath);
            player.play(resource);
            connection.subscribe(player);

            player.on(AudioPlayerStatus.Playing, () => {
                message.channel.send(`Now playing audio from local video: \`${filename}\``);
            });

            player.on('error', error => {
                console.error(`Error playing local video audio: ${error.message}`);
                message.channel.send(`Failed to play local video audio: ${error.message}`);
            });

        } catch (error) {
            console.error('Error playing local video audio:', error);
            message.reply(`Failed to play local video audio: ${error.message}. Make sure the file path is correct and accessible.`);
        }
    }

    // --- !callvoice command (NEW) ---
    else if (command === 'callvoice') {
        if (!message.member.permissions.has('Administrator')) { // Prompt specifies Administrator
            return message.reply('You do not have permission to use this command.');
        }
        const targetChannel = message.mentions.channels.first();
        const filename = args[1];

        if (!targetChannel || targetChannel.type !== 2) { // 2 is VoiceChannel
            return message.reply('Please mention a valid voice channel (e.g., `#general-voice`).');
        }
        if (!filename) {
            return message.reply('Please provide a filename (e.g., `video.mp4`) from the `videos` directory.');
        }

        const filePath = path.join(VIDEOS_DIR, filename);
        if (!fs.existsSync(filePath)) {
            return message.reply(`Video file \`${filename}\` not found in the \`videos\` directory.`);
        }

        try {
            const connection = joinVoiceChannel({
                channelId: targetChannel.id,
                guildId: targetChannel.guild.id,
                adapterCreator: targetChannel.guild.voiceAdapterCreator,
            });
            connections.set(message.guild.id, connection);
            message.reply(`Joined voice channel: **${targetChannel.name}**`);

            const player = players.get(message.guild.id) || createAudioPlayer();
            players.set(message.guild.id, player);

            const resource = createAudioResource(filePath);
            player.play(resource);
            connection.subscribe(player);

            player.on(AudioPlayerStatus.Playing, () => {
                message.channel.send(`Now playing audio from local video in **${targetChannel.name}**: \`${filename}\``);
            });

            player.on('error', error => {
                console.error(`Error playing local video audio in !callvoice: ${error.message}`);
                message.channel.send(`Failed to play local video audio in **${targetChannel.name}**: ${error.message}`);
            });

        } catch (error) {
            console.error('Error in !callvoice command:', error);
            message.reply(`Failed to join channel or play video: ${error.message}.`);
        }
    }

    // --- !leave, !stop, !stopvideo commands (utility for voice) ---
    else if (['leave', 'stop', 'stopvideo'].includes(command)) { // MODIFIED: Added aliases
        const connection = connections.get(message.guild.id);
        if (connection) {
            connection.destroy();
            connections.delete(message.guild.id);
            const player = players.get(message.guild.id);
            if (player) { // FIX: Added parentheses around 'player'
                player.stop();
                players.delete(message.guild.id);
            }
            message.reply('Stopped audio and left the voice channel.');
        } else {
            message.reply('I am not in a voice channel.');
        }
    }

    // --- !sharescreen command (NEW) ---
    else if (command === 'sharescreen') {
        if (!voiceChannel) {
            return message.reply('You need to be in a voice channel for me to explain screen sharing limitations.');
        }
        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });
            connections.set(message.guild.id, connection);
            message.channel.send('I\'ve joined your voice channel. Please note that as a bot, I cannot directly share my screen or view yours. Screen sharing is a user-to-user feature on Discord.');
        } catch (error) {
            console.error('Error joining voice channel for sharescreen:', error);
            message.reply('Failed to join the voice channel to explain screen sharing.');
        }
    }

    // --- !speakerphone command (NEW) ---
    else if (command === 'speakerphone') {
        if (!voiceChannel) {
            return message.reply('You need to be in a voice channel for me to explain speakerphone limitations.');
        }
        const targetUser = message.mentions.users.first();
        const userMention = targetUser ? ` ${targetUser.toString()}` : '';

        try {
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            });
            connections.set(message.guild.id, connection);
            message.channel.send(`I've joined your voice channel${userMention}. As a bot, I don't have a "speakerphone" feature in the traditional sense. I can play audio, but I cannot act as an intermediary for voice communication between users like a speakerphone would.`);
        } catch (error) {
            console.error('Error joining voice channel for speakerphone:', error);
            message.reply('Failed to join the voice channel to explain speakerphone.');
        }
    }

    // --- Communication Commands ---
    else if (command === 'alert') {
        let targetChannel = message.channel;
        let alertMessage = args.join(' ');

        const channelMention = message.mentions.channels.first();
        if (channelMention) {
            targetChannel = channelMention;
            alertMessage = args.slice(1).join(' '); // Remove channel mention from message
        }

        if (!alertMessage) {
            return message.reply('Please provide a message for the alert.');
        }

        try {
            await targetChannel.send(`🚨 **ALERT from ${message.author.tag}:** ${alertMessage}`);
            if (targetChannel.id !== message.channel.id) {
                message.channel.send(`Alert sent to ${targetChannel}.`);
            }
        } catch (error) {
            console.error('Error sending alert:', error);
            message.reply(`Failed to send alert to ${targetChannel}. Make sure I have permission to send messages there.`);
        }
    }

    else if (command === 'sendmessage' || command === 'snedmessage' || command === 'messagecall' || command === 'nuksendemessage' || command === 'nukesendmessage' || command === 'dm') {
        // Add permission check for !sendmessage and variants
        if (!message.member.permissions.has('ManageMessages')) {
            return message.reply('You do not have permission to use this command.');
        }
        // !messagecall already has its own permission check, keep it.
        if (command === 'messagecall' && !message.member.permissions.has('Administrator')) {
            return message.reply('You do not have permission to use this command.');
        }

        let user = message.mentions.users.first(); // 1. Try to get user by mention first
        let dmMessageContent;
        let userIdentifier = args[0]; // The first argument, could be mention, ID, or name
        let messageStartIndex = 1; // Default start index for message content

        if (user) {
            // If a mention was found, the user is identified.
            dmMessageContent = args.slice(messageStartIndex).join(' ');
        } else if (userIdentifier) {
            // 2. Try to find by User ID globally
            // Discord User IDs are typically 17-19 digits long
            if (!isNaN(userIdentifier) && userIdentifier.length >= 17 && userIdentifier.length <= 19) {
                try {
                    const fetchedUser = await client.users.fetch(userIdentifier, { force: true }); // Force fetch to ensure latest data
                    if (fetchedUser) {
                        user = fetchedUser;
                        dmMessageContent = args.slice(messageStartIndex).join(' ');
                    }
                } catch (e) {
                    // User ID not found or invalid, continue to name search
                    console.warn(`Attempted to fetch user by ID ${userIdentifier} but failed: ${e.message}`);
                }
            }

            if (!user) { // If user not found by mention or ID, try by name in the current guild
                const targetNameLower = userIdentifier.toLowerCase();

                // 3. Try to find by exact display name or username (case-insensitive)
                // First, check in cache for efficiency
                let matchingMembers = message.guild.members.cache.filter(
                    m => m.displayName.toLowerCase() === targetNameLower || m.user.username.toLowerCase() === targetNameLower
                );

                if (matchingMembers.size === 0) {
                    // If not found in cache, fetch from API for a broader search
                    const fetchedMembers = await message.guild.members.fetch({ query: userIdentifier, limit: 50 });
                    matchingMembers = fetchedMembers.filter(
                        m => m.displayName.toLowerCase() === targetNameLower || m.user.username.toLowerCase() === targetNameLower
                    );
                }

                if (matchingMembers.size === 1) {

                    user = matchingMembers.first().user;
                    dmMessageContent = args.slice(messageStartIndex).join(' '); // Message content starts after the name
                } else if (matchingMembers.size > 1) {
                    return message.reply(`Multiple users found with the exact name "${userIdentifier}". Please be more specific, mention the user, or provide their ID.`);
                } else {
                    // No user found by mention, ID, or exact name
                    return message.reply('Could not find a user with that exact display name, username, or ID. Please mention the user or provide their exact name/ID.');
                }
            }
        }

        if (!user) {
            // If no user was identified at all (e.g., no args, or first arg was not a user)
            return message.reply('Please mention the user, provide their exact display name/username, or their User ID to send a direct message to.');
        }

        if (!dmMessageContent) {
            // If user was found but no message content was provided
            return message.reply('Please provide a message to send.');
        }

        try {
            const finalMessage = dmMessageContent;
            await user.send(finalMessage);
            message.channel.send(`Direct message sent to ${user.tag}.`);
        } catch (error) {
            console.error('Error sending DM:', error);
            await message.reply(`Failed to send a direct message to ${user.tag}. They might have DMs disabled. Sending message in this channel instead as a fallback.`);
            await message.channel.send(`${user.toString()}, you have a message from ${message.author.toString()}: ${dmMessageContent}`);
        }
    }

    // --- Phone command (NEW) ---
    else if (command === 'phone' || command === 'onlinephone' || command === 'phonecommand') {
        const subCommand = args[0];
        if (!subCommand) {
            return message.reply('Please specify a subcommand: `call` or `hangup`');
        }

        if (subCommand === 'call') {
            if (!voiceChannel) {
                return message.reply('You need to be in a voice channel to make a call!');
            }
            
            const targetUser = message.mentions.users.first();
            if (!targetUser) {
                return message.reply('Please mention the user you want to call.');
            }
            if (targetUser.bot) {
                return message.reply('You cannot call a bot.');
            }
            if (targetUser.id === message.author.id) {
                return message.reply('You cannot call yourself.');
            }

            try {
                // Get display names for both caller and target
                const callerDisplayName = await getDisplayName(message.member, message.author.username);
                const targetMember = await message.guild.members.fetch(targetUser.id);
                const targetDisplayName = await getDisplayName(targetMember, targetUser.username);

                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                });
                connections.set(message.guild.id, connection);

                const invite = await voiceChannel.createInvite({
                    maxUses: 1,
                    maxAge: 600,
                    unique: true,
                    reason: `Call from ${callerDisplayName}`,
                });

                const incomingCallEmbed = {
                    color: 0x3498db,
                    title: '📞 Incoming Call',
                    description: `**${callerDisplayName}** is calling you!`,
                    fields: [
                        {
                            name: 'To Answer',
                            value: `Click here to join the call: ${invite.url}`,
                        }

                    ],
                    timestamp: new Date(),
                    footer: {
                        text: `Call from ${callerDisplayName} • Click the link to join`
                    }
                };

                const outgoingCallEmbed = {
                    color: 0x2ecc71,
                    title: '📞 Outgoing Call',
                    description: `Calling **${targetDisplayName}**...`,
                    fields: [
                        {
                            name: 'Status',
                            value: `I've joined **${voiceChannel.name}** and sent them an invite.`,
                        }
                    ],
                    timestamp: new Date(),
                    footer: {
                        text: `Calling ${targetDisplayName} • Waiting for answer`
                    }
                };

                try {
                    await targetUser.send({ embeds: [incomingCallEmbed] });
                    await message.channel.send({ embeds: [outgoingCallEmbed] });
                } catch (dmError) {
                    console.error('Error sending phone call DM:', dmError);
                    await message.reply(`Failed to send DM to ${targetDisplayName}. They might have DMs disabled. Posting invite in this channel instead.`);
                    await message.channel.send({ 
                        content: `📞 ${targetUser.toString()}, ${message.author.toString()} is calling you!`,
                        embeds: [incomingCallEmbed]
                    });
                }
            } catch (error) {
                console.error('Error initiating phone call:', error);
                message.reply(`Failed to initiate call: ${error.message}`);
            }
        } else if (subCommand === 'hangup') {
            const connection = connections.get(message.guild.id);
            if (connection) {
                connection.destroy();
                connections.delete(message.guild.id);
                const player = players.get(message.guild.id);
                if (player) {
                    player.stop();
                    players.delete(message.guild.id);
                }
                const hangupEmbed = {
                    color: 0xe74c3c,
                    title: '📞 Call Ended',
                    description: 'The call has been ended.',
                    timestamp: new Date(),
                    footer: {
                        text: 'Call ended • Thanks for using Discord Phone'
                    }
                };
                message.channel.send({ embeds: [hangupEmbed] });
            } else {
                message.reply('I am not currently in a call.');
            }
        }
    }

    // --- Plugins & Development Commands ---
    else if (command === 'download') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You do not have permission to use this command.');
        }

        const url = args[0];
        if (!url) {
            return message.reply('Please provide a file URL to download.');
        }

        let filename = args.slice(1).join(' ').trim(); // Optional filename
        let outputPath;

        if (filename) {
            outputPath = path.join(DOWNLOADS_DIR, filename);
        } else {
            // yt-dlp will generate a filename based on title if -o is just a directory
            outputPath = DOWNLOADS_DIR;
        }

        const progressMessage = await message.channel.send(`Starting download from \`${url}\`...`);

        try {
            const ytDlpArgs = [
                url,
                // Generic download, no specific format selection
                '-o', `${outputPath}${filename ? '' : '/%(title)s.%(ext)s'}`, // Output path, use %(title)s if no custom filename
                '--restrict-filenames', // Keep filenames simple
                '--no-playlist',
                '--progress', // Show progress
                '--newline', // Ensure progress is on new lines
                '--quiet', // Suppress most output, but --progress overrides this for progress lines
                '--no-warnings',
            ];

            const downloadProcess = ytDlp.exec(ytDlpArgs);

            let lastProgressLine = '';
            const progressInterval = setInterval(() => {
                if (lastProgressLine) {
                    progressMessage.edit(`Downloading: \`${lastProgressLine}\``).catch(() => {});
                }
            }, 2000); // Update every 2 seconds to avoid rate limits

            downloadProcess.stdout.on('data', (data) => {
                const lines = data.toString().split(/[\r\n]/).filter(l => l.includes('%'));
                if (lines.length > 0) {
                    lastProgressLine = lines[lines.length - 1].trim();
                }
            });

            await new Promise((resolve, reject) => {
                downloadProcess.on('close', code => {
                    clearInterval(progressInterval);
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`Download process exited with code ${code}`));
                    }
                });
                downloadProcess.on('error', err => {
                    clearInterval(progressInterval);
                    reject(err);
                });
            });

            await progressMessage.edit(`✅ File downloaded successfully to \`${DOWNLOADS_DIR}\`!`).catch(() => {});
        } catch (error) {
            console.error('Error downloading file:', error);
            await progressMessage.edit(`Failed to download file. The URL might be invalid or unsupported. Check the console for more details.`).catch(() => {});
        }
    }

    // --- !npmdownload command (NEW) ---
    else if (command === 'npmdownload') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You do not have permission to use this command.');
        }

        const packageName = args[0];
        if (!packageName) {
            return message.reply('Please provide an npm package name to download.');
        }

        try {
            const response = await fetch(`https://registry.npmjs.org/${packageName}`);
            if (!response.ok) {
                if (response.status === 404) {
                    return message.reply(`Package \`${packageName}\` not found on npm.`);
                }
                return message.reply(`Failed to fetch package info from npm. Status: ${response.status}`);
            }

            const packageInfo = await response.json();
            const latestVersion = packageInfo['dist-tags']?.latest;
            if (!latestVersion) {
                return message.reply(`Could not find the latest version for package \`${packageName}\`.`);
            }
            
            const tarballUrl = packageInfo.versions[latestVersion]?.dist?.tarball;

            if (!tarballUrl) {
                return message.reply(`Could not find a download URL for package \`${packageName}\`.`);
            }

            const url = tarballUrl;
            const filename = `${packageName.replace('/', '-')}-${latestVersion}.tgz`;
            const outputPath = path.join(DOWNLOADS_DIR, filename);

            const progressMessage = await message.channel.send(`Starting download for \`${packageName}@${latestVersion}\` from npm...`);

            const ytDlpArgs = [
                url,
                '-o', outputPath,
                '--restrict-filenames',
                '--no-playlist',
                '--progress',
                '--newline',
                '--quiet',
                '--no-warnings',
            ];

            const downloadProcess = ytDlp.exec(ytDlpArgs);

            let lastProgressLine = '';
            const progressInterval = setInterval(() => {
                if (lastProgressLine) {
                    progressMessage.edit(`Downloading: \`${lastProgressLine}\``).catch(() => {});
                }
            }, 2000);

            downloadProcess.stdout.on('data', (data) => {
                const lines = data.toString().split(/[\r\n]/).filter(l => l.includes('%'));
                if (lines.length > 0) {
                    lastProgressLine = lines[lines.length - 1].trim();
                }
            });

            await new Promise((resolve, reject) => {
                downloadProcess.on('close', code => {
                    clearInterval(progressInterval);
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`Download process exited with code ${code}`));
                    }
                });
                downloadProcess.on('error', err => {
                    clearInterval(progressInterval);
                    reject(err);
                });
            });

            await progressMessage.edit(`✅ Package \`${packageName}@${latestVersion}\` downloaded successfully to \`${DOWNLOADS_DIR}\`!`).catch(() => {});

        } catch (error) {
            console.error('Error in npmdownload command:', error);
            message.reply(`An error occurred: ${error.message}`);
        }
    }

    // --- !downloadvideo command (MODIFIED) ---
    else if (command === 'downloadvideo') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You do not have permission to use this command.');
        }

        const url = args[0];
        if (!url) {
            return message.reply('Please provide a YouTube URL to download.');
        }

        let filename = args.slice(1).join(' ').trim(); // Optional filename
        let outputPath;

        if (filename) {
            // Ensure filename has an extension, default to .mp4 if not provided
            if (!path.extname(filename)) {
                filename += '.mp4';
            }
            outputPath = path.join(VIDEOS_DIR, filename);
        } else {
            // yt-dlp will generate a filename based on title if -o is just a directory
            outputPath = VIDEOS_DIR;
        }

        const progressMessage = await message.channel.send(`Starting video download from \`${url}\`...`);

        try {
            const ytDlpArgs = [
                url,
                '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', // Prioritize mp4, then best available
                '--merge-output-format', 'mp4', // Ensure merged output is mp4
                '-o', `${outputPath}${filename ? '' : '/%(title)s.%(ext)s'}`, // Output path, use %(title)s if no custom filename
                '--restrict-filenames', // Keep filenames simple
                '--no-playlist',
                '--progress', // Show progress
                '--newline', // Ensure progress is on new lines
                '--quiet', // Suppress most output, but --progress overrides this for progress lines
                '--no-warnings',
                '--extractor-args', `youtube:po_token=${PO_TOKEN}`, // ADDED: PO_TOKEN
            ];

            const downloadProcess = ytDlp.exec(ytDlpArgs);

            let lastProgressLine = '';
            const progressInterval = setInterval(() => {
                if (lastProgressLine) {
                    progressMessage.edit(`Downloading: \`${lastProgressLine}\``).catch(() => {});
                }
            }, 2000); // Update every 2 seconds to avoid rate limits

            downloadProcess.stdout.on('data', (data) => {
                const lines = data.toString().split(/[\r\n]/).filter(l => l.includes('%'));
                if (lines.length > 0) {
                    lastProgressLine = lines[lines.length - 1].trim();
                }
            });

            await new Promise((resolve, reject) => {
                downloadProcess.on('close', code => {
                    clearInterval(progressInterval);
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`Download process exited with code ${code}`));
                    }
                });
                downloadProcess.on('error', err => {
                    clearInterval(progressInterval);
                    reject(err);
                });
            });

            await progressMessage.edit(`✅ Video downloaded successfully to \`${VIDEOS_DIR}\`!`).catch(() => {});
        } catch (error) {
            console.error('Error downloading video:', error);
            await progressMessage.edit(`Failed to download video. The URL might be invalid or unsupported. Check the console for more details.`).catch(() => {});
        }
    }

    // --- !downloadsound command (MODIFIED) ---
    else if (command === 'downloadsound') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You do not have permission to use this command.');
        }

        const url = args[0];
        if (!url) {
            return message.reply('Please provide a YouTube URL to download audio from.');
        }

        let filename = args.slice(1).join(' ').trim(); // Optional filename
        let outputPath;

        if (filename) {
            // Ensure filename has an extension, default to .mp3 if not provided
            if (!path.extname(filename)) {
                filename += '.mp3';
            }
            outputPath = path.join(SOUNDBOARD_DIR, filename);
        } else {
            // yt-dlp will generate a filename based on title if -o is just a directory
            outputPath = SOUNDBOARD_DIR;
        }

        const progressMessage = await message.channel.send(`Starting audio download from \`${url}\`...`);

        try {
            const ytDlpArgs = [
                url,
                '-f', 'bestaudio', // Download best audio
                '-x', // Extract audio
                '--audio-format', 'mp3', // Convert to mp3
                '-o', `${outputPath}${filename ? '' : '/%(title)s.%(ext)s'}`, // Output path, use %(title)s if no custom filename
                '--restrict-filenames', // Keep filenames simple
                '--no-playlist',
                '--progress', // Show progress
                '--newline', // Ensure progress is on new lines
                '--quiet', // Suppress most output, but --progress overrides this for progress lines
                '--no-warnings',
                '--extractor-args', `youtube:po_token=${PO_TOKEN}`, // ADDED: PO_TOKEN
            ];

            const downloadProcess = ytDlp.exec(ytDlpArgs);

            let lastProgressLine = '';
            const progressInterval = setInterval(() => {
                if (lastProgressLine) {
                    progressMessage.edit(`Downloading: \`${lastProgressLine}\``).catch(() => {});
                }
            }, 2000); // Update every 2 seconds to avoid rate limits

            downloadProcess.stdout.on('data', (data) => {
                const lines = data.toString().split(/[\r\n]/).filter(l => l.includes('%'));
                if (lines.length > 0) {
                    lastProgressLine = lines[lines.length - 1].trim();
                }
            });

            await new Promise((resolve, reject) => {
                downloadProcess.on('close', code => {
                    clearInterval(progressInterval);
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`Download process exited with code ${code}`));
                    }
                });
                downloadProcess.on('error', err => {
                    clearInterval(progressInterval);
                    reject(err);
                });
            });

            await progressMessage.edit(`✅ Audio downloaded successfully to \`${SOUNDBOARD_DIR}\`!`).catch(() => {});
        } catch (error) {
            console.error('Error downloading audio:', error);
            await progressMessage.edit(`Failed to download audio. The URL might be invalid or unsupported. Check the console for more details.`).catch(() => {});
        }
    }

    // --- !control command (NEW - Implementation) ---
    else if (command === 'control') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You do not have permission to use this command.');
        }

        const subCommand = args[0]?.toLowerCase();
        const subArgs = args.slice(1);

        if (!subCommand) {
            const currentActivity = client.user.presence.activities[0];
            let activityInfo = 'No custom activity set.';
            if (currentActivity) {
                activityInfo = `Type: \`${ActivityType[currentActivity.type]}\`, Name: \`${currentActivity.name}\``;
                if (currentActivity.url) activityInfo += `, URL: \`${currentActivity.url}\``;
            }
            return message.channel.send(
                `**Bot Presence Control:**\n` +
                `Current Status: \`${client.user.presence.status}\`\n` +
                `Current Activity: ${activityInfo}\n\n` +
                `**Usage:**\n` +
                `\`!control status <online|idle|dnd|invisible>\`\n` +
                `\`!control activity <playing|streaming|listening|watching|competing> <name> [url (for streaming)]\`\n` +
                `\`!control clear\` - Clears custom activity.`
            );
        }

        switch (subCommand) {
            case 'status':
                const newStatus = subArgs[0]?.toLowerCase();
                const validStatuses = ['online', 'idle', 'dnd', 'invisible'];
                if (!newStatus || !validStatuses.includes(newStatus)) {
                    return message.reply(`Invalid status. Please use one of: \`${validStatuses.join(', ')}\`.`);
                }
                client.user.setStatus(newStatus);
                message.channel.send(`✅ Bot status set to \`${newStatus}\`.`);
                break;

            case 'activity':
                const activityTypeStr = subArgs[0]?.toLowerCase();
                const activityName = subArgs.slice(1).join(' ');
                const validActivityTypes = ['playing', 'streaming', 'listening', 'watching', 'competing'];

                if (!activityTypeStr || !validActivityTypes.includes(activityTypeStr)) {
                    return message.reply(`Invalid activity type. Please use one of: \`${validActivityTypes.join(', ')}\`.`);
                }
                if (!activityName && activityTypeStr !== 'streaming') { // Streaming can have no name if only URL
                    return message.reply('Please provide an activity name.');
                }

                let type;
                switch (activityTypeStr) {
                    case 'playing': type = ActivityType.Playing; break;
                    case 'streaming': type = ActivityType.Streaming; break;
                    case 'listening': type = ActivityType.Listening; break;
                    case 'watching': type = ActivityType.Watching; break;
                    case 'competing': type = ActivityType.Competing; break;
                }

                const activityOptions = {
                    name: activityName,
                    type: type,
                };

                // For streaming, check if the last argument is a valid URL
                if (type === ActivityType.Streaming) {
                    const lastArg = subArgs[subArgs.length - 1];
                    if (lastArg && (lastArg.startsWith('http://') || lastArg.startsWith('https://'))) {
                        activityOptions.url = lastArg;
                        // If URL is part of the name, remove it from the name
                        if (activityName.endsWith(lastArg)) {
                            activityOptions.name = activityName.substring(0, activityName.length - lastArg.length).trim();
                        }
                    } else {
                        // If streaming, but no URL provided, it's not a valid streaming activity
                        return message.reply('For streaming activity, please provide a valid Twitch/YouTube URL as the last argument.');
                    }
                }

                client.user.setActivity(activityOptions);
                message.channel.send(`✅ Bot activity set to \`${activityTypeStr}\` \`${activityOptions.name}\`${activityOptions.url ? ` (URL: ${activityOptions.url})` : ''}.`);
                break;

            case 'clear':
                client.user.setActivity(null); // Clear all activities
                message.channel.send('✅ Bot custom activity cleared.');
                break;

            default:
                message.reply('Unknown subcommand for `!control`. Use `!control` for usage instructions.');
                break;
        }
    }

    // --- !youtubeupload command (NEW - Placeholder) ---
    else if (command === 'youtubeupload' || command === 'addyoutubeupload') { // MODIFIED: Added alias
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You do not have permission to use this command.');
        }

        return message.channel.send(
            `**YouTube Upload Feature (Complex - Placeholder):**\n` +
            `Implementing a secure and functional YouTube upload requires significant setup and coding, including:\n` +
            `1.  **Google Cloud Project:** Create a project and enable the YouTube Data API v3.\n` +
            `2.  **OAuth 2.0 Credentials:** Set up API keys and client secrets.\n` +
            `3.  **User Authentication Flow:** Implement a web-based flow for users to authorize your bot to upload on their behalf.\n` +
            `4.  **External Libraries:** Use a Node.js library like \`googleapis\` for API interaction.\n` +
            `5.  **Video Metadata:** Collect title, description, tags, privacy status from the user.\n` +
            `6.  **File Handling:** Ensure the bot can access the local video file.\n\n` +
            `Due to this complexity, security implications, and potential for misuse (e.g., copyright infringement), a full implementation is not provided here. This command serves as a placeholder for future development or integration with a dedicated plugin.`
        );
    }

    // --- Communication Commands ---
    else if (command === 'fakemessage') { // ADDED: !fakemessage command
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You need Administrator permission to use this command.');
        }

        const userIdentifier = args[0];
        const targetUser = userIdentifier?.toLowerCase() === 'bot' ? client.user : message.mentions.users.first();
        const fakeMessageContent = args.slice(1).join(' ');

        if (!targetUser || !fakeMessageContent) {
            return message.reply('Please provide both a user (or "bot") and a message (e.g., `!fakemessage @user This is a fake message.`).');
        }

        try {
            // Check if the bot has permissions to manage webhooks
            if (!message.channel.permissionsFor(message.guild.members.me).has('ManageWebhooks')) {
                return message.reply('I need "Manage Webhooks" permission in this channel to send messages as other users.');
            }

            // Find an existing webhook or create a new one
            let webhook = (await message.channel.fetchWebhooks()).find(wh => wh.owner.id === client.user.id);

            if (!webhook) {
                webhook = await message.channel.createWebhook({
                    name: 'FakeMessage Bot Webhook',
                    avatar: client.user.displayAvatarURL(),
                    reason: 'Needed for !fakemessage command',
                });
            }

            // Send the message using the webhook, impersonating the target user
            await webhook.send({
                content: fakeMessageContent,
                username: targetUser.username,
                avatarURL: targetUser.displayAvatarURL({ dynamic: true }),
            });

            await message.channel.send(`Successfully sent a message as ${targetUser.tag}.`);

        } catch (error) {
            console.error('Error in !fakemessage command:', error);
            message.reply(`Failed to send fake message: ${error.message}. Make sure I have "Manage Webhooks" permission.`);
        }
    }

    // --- Plugin Management Commands ---
    else if (command === 'plugin') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply({ content: 'You do not have permission to manage plugins.', ephemeral: true });
        }

        const subCommand = args[0];
        let response;

        switch (subCommand) {
            case 'load':
                const pluginToLoad = args[1];
                response = await loadPlugin(pluginToLoad, message.guild.id, message.channel);
                break;
            case 'unload':
                const pluginToUnload = args[1];
                response = await unloadPlugin(pluginToUnload, message.guild.id, message.channel);
                break;
            case 'list':
                response = listPlugins();
                break;
            default:
                response = 'Unknown plugin subcommand.';
        }
        await message.reply({ content: response, ephemeral: true });
    }

    // --- !update command (NEW - Implementation) ---
    else if (command === 'update') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You do not have permission to use this command.');
        }

        await message.channel.send('**Starting update process...**\n1. Pulling latest changes from Git...');

        exec('git pull', async (pullError, pullStdout, pullStderr) => {
            if (pullError) {
                console.error(`git pull error: ${pullError}`);
                return message.channel.send(`Failed to pull from Git: \`\`\`${pullError.message}\`\`\``);
            }

            const pullOutput = pullStdout || pullStderr;
            await message.channel.send(`Git pull output:\n\`\`\`${pullOutput || 'No output'}\`\`\``);

            // Only run npm install if there were actual changes
            if (pullOutput.includes('Already up to date.')) {
                await message.channel.send('No new code changes. Skipping dependency update. Reloading plugins...');
                const reloadResult = await reloadAllPlugins(client, message.guild.id, message.channel);
                await message.channel.send(`**Plugin Reload Results:**\n${reloadResult}`);
                return;
            }

            await message.channel.send('2. Updating npm dependencies...');
            exec('npm install', async (npmError, npmStdout, npmStderr) => {
                if (npmError) {
                    console.error(`npm install error: ${npmError}`);
                    return message.channel.send(`Failed to update dependencies: \`\`\`${npmError.message}\`\`\``);
                }
                
                const npmOutput = npmStdout || npmStderr;
                await message.channel.send(`NPM install output:\n\`\`\`${npmOutput || 'No output'}\`\`\``);

                await message.channel.send('3. Reloading all loaded plugins...');
                const reloadResult = await reloadAllPlugins(client, message.guild.id, message.channel);
                await message.channel.send(`**Plugin Reload Results:**\n${reloadResult}`);

                await message.channel.send('✅ **Update complete!** For core bot changes to take effect, a manual restart might be required.');
            });
        });
    }

    // --- !runpy command (NEW - Implementation) ---
    else if (command === 'runpy') {
        if (!message.member.permissions.has('Administrator')) {
            return message.reply('You do not have permission to use this command.');
        }
        const code = args.join(' ');
        if (!code) {
            return message.reply('Please provide Python code to run.');
        }

        // Basic check to prevent some obvious abuse
        const forbiddenModules = ['os', 'subprocess', 'sys', 'shutil', 'requests', 'socket'];
        if (forbiddenModules.some(module => code.includes(`import ${module}`))) {
            return message.reply('For security reasons, some modules are restricted.');
        }

        exec(`python -c "${code.replace(/"/g, '\\"')}"`, (error, stdout, stderr) => {
            if (error) {
                return message.channel.send(`**Error:**\n\`\`\`py\n${error.message}\`\`\``);
            }
            if (stderr) {
                return message.channel.send(`**Stderr:**\n\`\`\`py\n${stderr}\`\`\``);
            }
            message.channel.send(`**Output:**\n\`\`\`py\n${stdout || '(No output)'}\`\`\``);
        });
    }
});

// ADDED: Interaction listener for slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, member, guild, channel, client: botClient } = interaction;
    const voiceChannel = member?.voice.channel;

    // Helper to join voice channel for slash commands
    const joinVoiceChannelForInteraction = async (interaction, targetVoiceChannel = voiceChannel) => {
        if (!targetVoiceChannel) {
            await interaction.reply({ content: 'You need to be in a voice channel for this command!', ephemeral: true });
            return null;
        }
        try {
            const connection = joinVoiceChannel({
                channelId: targetVoiceChannel.id,
                guildId: targetVoiceChannel.guild.id,
                adapterCreator: targetVoiceChannel.guild.voiceAdapterCreator,
            });
            connections.set(guild.id, connection);
            return connection;
        } catch (error) {
            console.error('Error joining voice channel via slash command:', error);
            await interaction.reply({ content: 'Failed to join the voice channel.', ephemeral: true });
            return null;
        }
    };

    // Helper function to get a user's display name
    const getDisplayName = async (member, fallback) => {
        if (member) {
            // Try to get nickname first, then username, then fallback
            return member.nickname || member.user?.username || fallback;
        }
        return fallback;
    };

    switch (commandName) {
        case 'say':
            if (!member.permissions.has('ManageMessages')) { // Prompt specifies Manage Messages for /say
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }
            const messageText = options.getString('message');
            await channel.send(messageText); // Send the message publicly to the channel
            await interaction.reply({ content: 'Message sent!', ephemeral: true }); // Acknowledge ephemerally to the user
            break;

        case 'call':
            if (!member.permissions.has('Administrator')) { // Prompt specifies Administrator for /call
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }
            const connection = await joinVoiceChannelForInteraction(interaction);
            if (connection) {
                await interaction.reply(`Joined voice channel: **${voiceChannel.name}**`);
            }
            break;

        case 'badge':
            if (!member.permissions.has('Administrator')) { // Prompt specifies Administrator for /badge
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }
            const userToBadge = options.getUser('user');
            await interaction.reply({ content: `Developer badge assignment for ${userToBadge.tag} is a placeholder.`, ephemeral: true });
            break;

        case 'sharescreen':
            const ssConnection = await joinVoiceChannelForInteraction(interaction);
            if (ssConnection) {
                await interaction.reply('I\'ve joined your voice channel. Please note that as a bot, I cannot directly share my screen or view yours. Screen sharing is a user-to-user feature on Discord.');
            }
            break;

        case 'speakerphone':
            const spUser = options.getUser('user');
            const spUserMention = spUser ? ` ${spUser.toString()}` : '';
            const spConnection = await joinVoiceChannelForInteraction(interaction);
            if (spConnection) {
                await interaction.reply(`I've joined your voice channel${spUserMention}. As a bot, I don't have a "speakerphone" feature in the traditional sense. I can play audio, but I cannot act as an intermediary for voice communication between users like a speakerphone would.`);
            }
            break;

        case 'sound':
            const clipName = options.getString('clip');
            if (!clipName) {
                // List available clips
                try {
                    const files = fs.readdirSync(SOUNDBOARD_DIR)
                        .filter(file => file.endsWith('.mp3') || file.endsWith('.wav'))
                        .map(file => `\`${file}\``);
                    if (files.length === 0) {
                        return interaction.reply({ content: 'No soundboard clips found in the `soundboard_clips` directory.', ephemeral: true });
                    }
                    return interaction.reply({ content: `Available soundboard clips:\n${files.join(', ')}`, ephemeral: true });
                } catch (error) {
                    console.error('Error reading soundboard directory:', error);
                    return interaction.reply({ content: 'Failed to list soundboard clips.', ephemeral: true });
                }
            }

            const filePath = path.join(SOUNDBOARD_DIR, clipName);
            if (!fs.existsSync(filePath)) {
                return interaction.reply({ content: `Sound clip \`${clipName}\` not found in the \`soundboard_clips\` directory.`, ephemeral: true });
            }

            const soundConnection = connections.get(guild.id) || await joinVoiceChannelForInteraction(interaction);
            if (!soundConnection) return;

            try {
                const player = players.get(guild.id) || createAudioPlayer();
                players.set(guild.id, player);

                const resource = createAudioResource(filePath);
                player.play(resource);
                soundConnection.subscribe(player);

                await interaction.reply(`Now playing soundboard clip: \`${clipName}\``);

                player.on('error', error => {
                    console.error(`Error playing soundboard clip via slash: ${error.message}`);
                    channel.send(`Failed to play soundboard clip: ${error.message}`);
                });

            } catch (error) {
                console.error('Error playing soundboard clip via slash:', error);
                await interaction.reply({ content: `Failed to play soundboard clip: ${error.message}.`, ephemeral: true });
            }
            break;

        case 'ytplay':
            const ytUrl = options.getString('url');
            const ytConnection = connections.get(guild.id) || await joinVoiceChannelForInteraction(interaction);
            if (!ytConnection) return;

            await interaction.deferReply(); // Defer reply as download might take time

            try {
                const player = players.get(guild.id) || createAudioPlayer();
                players.set(guild.id, player);

                const ytDlpProcess = ytDlp.exec([
                    ytUrl,
                    '-f', 'bestaudio[ext=webm+acodec=opus]/bestaudio',
                    '-o', '-',
                    '--no-playlist',
                    '--quiet',
                    '--no-warnings',
                    '--extractor-args', `youtube:po_token=${PO_TOKEN}`, // MODIFIED: Use PO_TOKEN constant
                ], { stdio: ['ignore', 'pipe', 'ignore'] });

                // ADDED: Error handling for yt-dlp process
                ytDlpProcess.on('error', (err) => {
                    console.error('yt-dlp process error:', err);
                    interaction.editReply('Failed to start YouTube audio process. Please try again later.');
                    // Clean up connection and player if an error occurs
                    if (ytConnection) ytConnection.destroy();
                    if (player) player.stop();
                });

                ytDlpProcess.on('close', (code) => {
                    if (code !== 0) {
                        console.error(`yt-dlp process exited with code ${code}`);
                        // Only reply if not already replied by an error event
                        if (!interaction.replied && !interaction.deferred) {
                            interaction.editReply('YouTube audio process exited unexpectedly. Please try again later.');
                        }
                        // Clean up connection and player if an error occurs
                        if (ytConnection) ytConnection.destroy();
                        if (player) player.stop();
                    }
                });

                const audioStream = ytDlpProcess.stdout;

                const resource = createAudioResource(audioStream);
                player.play(resource);
                ytConnection.subscribe(player);

                ytDlpProcess.on('error', (error) => {
                    console.error(`yt-dlp process error (slash): ${error.message}`);
                    interaction.editReply(`An error occurred while trying to stream audio.`).catch(() => {});
                    player.stop();
                });

                player.on(AudioPlayerStatus.Playing, () => {
                    interaction.editReply(`Now playing YouTube audio!`);
                });

                player.on('error', error => {
                    console.error(`Error playing YouTube audio: ${error.message}`);
                    interaction.editReply(`Failed to play YouTube audio: ${error.message}`);
                });

            } catch (error) {
                console.error('Error in /ytplay slash command:', error);
                interaction.editReply(`Failed to play YouTube audio: ${error.message}. Make sure the URL is correct and yt-dlp is working.`);
            }
            break;

        case 'livestream':
            const lsUrl = options.getString('url');
            const lsConnection = connections.get(guild.id) || await joinVoiceChannelForInteraction(interaction);
            if (!lsConnection) return;

            await interaction.deferReply();

            try {
                const player = players.get(guild.id) || createAudioPlayer();
                players.set(guild.id, player);

                const resource = createAudioResource(lsUrl);
                player.play(resource);
                lsConnection.subscribe(player);

                player.on(AudioPlayerStatus.Playing, () => {
                    interaction.editReply(`Now playing live stream!`);
                });

                player.on('error', error => {
                    console.error(`Error playing live stream via slash: ${error.message}`);
                    interaction.editReply(`Failed to play live stream: ${error.message}`);
                });

            } catch (error) {
                console.error('Error in /livestream slash command:', error);
                interaction.editReply(`Failed to play live stream: ${error.message}. Make sure the URL is a valid audio stream.`);
            }
            break;

        case 'playvideo':
            const videoFilename = options.getString('filename');
            const videoFilePath = path.join(VIDEOS_DIR, videoFilename);

            if (!fs.existsSync(videoFilePath)) {
                return interaction.reply({ content: `Video file \`${videoFilename}\` not found in the \`videos\` directory.`, ephemeral: true });
            }

            const videoConnection = connections.get(guild.id) || await joinVoiceChannelForInteraction(interaction);
            if (!videoConnection) return;

            try {
                const player = players.get(guild.id) || createAudioPlayer();
                players.set(guild.id, player);

                const resource = createAudioResource(videoFilePath);
                player.play(resource);
                videoConnection.subscribe(player);

                await interaction.reply(`Now playing audio from local video: \`${videoFilename}\``);

                player.on('error', error => {
                    console.error(`Error playing local video audio via slash: ${error.message}`);
                    channel.send(`Failed to play local video audio: ${error.message}`);
                });

            } catch (error) {
                console.error('Error playing local video audio via slash:', error);
                await interaction.reply({ content: `Failed to play local video audio: ${error.message}.`, ephemeral: true });
            }
            break;

        case 'sendmessage':
        case 'dm': // ADDED: Alias for /sendmessage
            // Add permission check for /sendmessage and /dm
            if (!member.permissions.has('ManageMessages')) {
                return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
            }

            const userToDM = options.getUser('user');
            const dmContent = options.getString('message');

            if (!userToDM) {
                return interaction.reply({ content: 'Please specify a user to send the message to.', ephemeral: true });
            }
            if (!dmContent) {
                return interaction.reply({ content: 'Please provide a message to send.', ephemeral: true });
            }

            try {
                const finalMessage = dmContent;
                await userToDM.send(finalMessage);
                await interaction.reply({ content: `Direct message sent to ${userToDM.tag}.`, ephemeral: true });
            } catch (error) {
                console.error('Error sending DM via slash command:', error);
                await interaction.reply({ content: `Failed to send a direct message to ${userToDM.tag}. They might have DMs disabled. Sending message in this channel instead as a fallback.`, ephemeral: true });
                await interaction.channel.send(`${userToDM.toString()}, you have a message from ${interaction.user.toString()}: ${dmContent}`);
            }
            break;

        case 'fakemessage': // ADDED: Implementation for /fakemessage
            if (!member.permissions.has('Administrator')) {
                return interaction.reply({ content: 'You need Administrator permission to use this command.', ephemeral: true });
            }

            const targetUser = options.getUser('user');
            const fakeMessageContent = options.getString('message'); // FIX: Corrected variable name
            const customUsername = options.getString('username');

            if (!targetUser || !fakeMessageContent) {
                return interaction.reply({ content: 'Please provide both a user and a message.', ephemeral: true });
            }

            try {
                // Check if the bot has permissions to manage webhooks
                if (!channel.permissionsFor(guild.members.me).has('ManageWebhooks')) {
                    return interaction.reply({ content: 'I need "Manage Webhooks" permission in this channel to send messages as other users.', ephemeral: true });
                }

                // Find an existing webhook or create a new one
                let webhook = (await channel.fetchWebhooks()).find(wh => wh.owner.id === botClient.user.id);

                if (!webhook) {
                    webhook = await channel.createWebhook({
                        name: 'FakeMessage Bot Webhook',
                        avatar: botClient.user.displayAvatarURL(),
                        reason: 'Needed for /fakemessage command',
                    });
                }

                // Send the message using the webhook, impersonating the target user
                await webhook.send({
                    content: fakeMessageContent,
                    username: customUsername || targetUser.username,
                    avatarURL: targetUser.displayAvatarURL({ dynamic: true }),
                });

                await interaction.reply({ content: `Successfully sent a message as ${customUsername || targetUser.tag}.`, ephemeral: true });

            } catch (error) {
                console.error('Error in /fakemessage command:', error);
                await interaction.reply({ content: `Failed to send fake message: ${error.message}. Make sure I have "Manage Webhooks" permission.`, ephemeral: true });
            }
            break;

        case 'plugin': // ADDED: Slash command for /plugin
            if (!member.permissions.has('Administrator')) {
                return interaction.reply({ content: 'You do not have permission to manage plugins.', ephemeral: true });
            }

            const subCommand = options.getSubcommand();
            let response;

            switch (subCommand) {
                case 'load':
                    const pluginToLoad = options.getString('name');
                    response = await loadPlugin(pluginToLoad, guild.id, channel);
                    break;
                case 'unload':
                    const pluginToUnload = options.getString('name');
                    response = await unloadPlugin(pluginToUnload, guild.id, channel);
                    break;
                case 'list':
                    response = listPlugins();
                    break;
                default:
                    response = 'Unknown plugin subcommand.';
            }
            await interaction.reply({ content: response, ephemeral: true });
            break;

        case 'phone': // ADDED: Slash command for /phone
            const phoneSubcommand = options.getSubcommand();

            if (phoneSubcommand === 'call') {
                if (!voiceChannel) {
                    return interaction.reply({ content: 'You need to be in a voice channel to make a call!', ephemeral: true });
                }
                const targetUser = options.getUser('user');
                if (!targetUser) {
                    return interaction.reply({ content: 'Please specify a user to call.', ephemeral: true });
                }
                if (targetUser.bot) {
                    return interaction.reply({ content: 'You cannot call a bot.', ephemeral: true });
                }
                if (targetUser.id === member.id) {
                    return interaction.reply({ content: 'You cannot call yourself.', ephemeral: true });
                }

                await interaction.deferReply();

                try {
                    // Get display names using the helper
                    const callerDisplayName = await getDisplayName(member, member.user.username);
                    const targetMember = await guild.members.fetch(targetUser.id);
                    const targetDisplayName = await getDisplayName(targetMember, targetUser.username);

                    const connection = await joinVoiceChannelForInteraction(interaction, voiceChannel);
                    if (!connection) return;

                    const invite = await voiceChannel.createInvite({
                        maxUses: 1,
                        maxAge: 600,
                        unique: true,
                        reason: `Call from ${callerDisplayName}`,
                    });

                    // Create fancy phone call embeds
                    const incomingCallEmbed = {
                        color: 0x3498db,
                        title: '📞 Incoming Call',

                        description: `**${callerDisplayName}** is calling you!`,
                        fields: [
                            {
                                name: 'To Answer',
                                value: `Click here to join the call: ${invite.url}`,
                            }
                        ],
                        timestamp: new Date(),
                        footer: {
                            text: `Call from ${callerDisplayName} • Click the link to join`
                        }
                    };

                    const outgoingCallEmbed = {
                        color: 0x2ecc71,
                        title: '📞 Outgoing Call',
                        description: `Calling **${targetDisplayName}**...`,
                        fields: [
                            {
                                name: 'Status',
                                value: `I've joined **${voiceChannel.name}** and sent them an invite.`,
                            }
                        ],
                        timestamp: new Date(),
                        footer: {
                            text: `Calling ${targetDisplayName} • Waiting for answer`
                        }
                    };

                    try {
                        await targetUser.send({ embeds: [incomingCallEmbed] });
                        await interaction.editReply({ embeds: [outgoingCallEmbed] });
                    } catch (dmError) {
                        console.error('Error sending phone call DM:', dmError);
                        await interaction.editReply(`Failed to send DM to ${targetDisplayName}. They might have DMs disabled. Posting invite in this channel instead.`);
                        await message.channel.send({ 
                            content: `📞 ${targetUser.toString()}, ${member.toString()} is calling you!`,
                            embeds: [incomingCallEmbed]
                        });
                    }
                } catch (error) {
                    console.error('Error initiating phone call via slash command:', error);
                    await interaction.editReply(`Failed to initiate call: ${error.message}. Make sure I have permissions to create invites.`);
                }
            } else if (phoneSubcommand === 'hangup') {
                const connection = connections.get(guild.id);
                if (connection) {
                    connection.destroy();
                    connections.delete(guild.id);
                    const player = players.get(guild.id);
                    if (player) {
                        player.stop();
                        players.delete(guild.id);
                    }
                    const hangupEmbed = {
                        color: 0xe74c3c,
                        title: '📞 Call Ended',
                        description: 'The call has been ended.',
                        timestamp: new Date(),
                        footer: {
                            text: 'Call ended • Thanks for using Discord Phone'
                        }
                    };
                    await interaction.reply({ embeds: [hangupEmbed] });
                } else {
                    await interaction.reply({ content: 'I am not currently in a call.', ephemeral: true });
                }
            }
            break;

        case 'setavatar': // MODIFIED: Implementation for /setavatar
            if (!member.permissions.has('Administrator')) {
                return interaction.reply({ content: 'You need Administrator permission to use this command.', ephemeral: true });
            }

            const avatarUrlOption = options.getString('url');
            const userOption = options.getUser('user');

            let finalAvatarUrl;

            if (userOption) {
                finalAvatarUrl = userOption.displayAvatarURL({ dynamic: true, size: 1024 }); // Get user's avatar URL
            } else if (avatarUrlOption) {
                // Basic URL validation for direct URL input
                if (!(avatarUrlOption.startsWith('http://') || avatarUrlOption.startsWith('https://'))) {
                    return interaction.reply({ content: 'Please provide a valid URL for the avatar image.', ephemeral: true });
                }
                finalAvatarUrl = avatarUrlOption;
            } else {
                return interaction.reply({ content: 'Please provide either an image URL or mention a user to use their avatar.', ephemeral: true });
            }

            try {
                await botClient.user.setAvatar(finalAvatarUrl);
                await interaction.reply({ content: '✅ Bot avatar updated successfully!', ephemeral: true });
            } catch (error) {
                console.error('Error setting bot avatar:', error);
                await interaction.reply({ content: `Failed to set bot avatar: ${error.message}. Make sure the URL is a direct link to an image (PNG, JPG, GIF) and the image size is within Discord limits.`, ephemeral: true });
            }
            break;

        default:
            await interaction.reply({ content: 'Unknown command!', ephemeral: true });
            break;
    }
});

// Log in to Discord with your client's token
// IMPORTANT: Replace 'YOUR_BOT_TOKEN' with your actual bot token.
// You can get your bot token from the Discord Developer Portal:
// https://discord.com/developers/applications
client.login(TOKEN); // MODIFIED: Use the TOKEN constant