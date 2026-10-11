#!/usr/bin/env node

import { delimiter } from "node:path";
import { packageInfo, startServer } from "./server";

// CLI argument parsing
const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');
const showVersion = args.includes('--version') || args.includes('-v');

// --version and --help exit before the stdio transport starts, so stdout is safe here.
if (showVersion) {
  console.log(`${packageInfo.name} v${packageInfo.version}`);
  process.exit(0);
}

if (showHelp) {
  console.log(`
${packageInfo.name} v${packageInfo.version}
${packageInfo.description}

USAGE:
  npx @null-topology/telegram-bot-mcp-server [options]
  telegram-bot-mcp-server [options]

OPTIONS:
  -h, --help     Show this help message
  -v, --version  Show version information

ENVIRONMENT VARIABLES:
  TELEGRAM_BOT_API_TOKEN  Your Telegram bot token (required)
                         Get one from @BotFather on Telegram
  TELEGRAM_UPLOAD_ROOTS   Directories (separated by "${delimiter}") that local media
                         uploads are restricted to when it lists at least one
                         directory; unset, empty, or only separators allows
                         any local file the server can read
                         Example: /srv/telegram/outbox
  TELEGRAM_DOWNLOAD_DIR   Directory where download-file saves files (created if
                         missing); unset disables download-file
                         Example: /srv/telegram/inbox

MEDIA INPUTS:
  Media tools accept three forms of input:
    - a Telegram file_id of a file already on Telegram's servers
    - an http(s) URL that Telegram downloads itself
    - a local file path, which must be absolute; when TELEGRAM_UPLOAD_ROOTS
      lists at least one directory, it must also be inside one of them (both
      the path as given and the file it resolves to)
  Video notes are the exception: they take a file_id or a local path, not a URL.

EXAMPLES:
  # Run with environment variable
  TELEGRAM_BOT_API_TOKEN=your_token_here npx @null-topology/telegram-bot-mcp-server

  # Run with token in .env file
  npx @null-topology/telegram-bot-mcp-server

MCP CLIENT CONFIGURATION:
Add this to your MCP client configuration:

{
  "mcpServers": {
    "telegram_bot": {
      "command": "npx",
      "args": ["@null-topology/telegram-bot-mcp-server"],
      "env": {
        "TELEGRAM_BOT_API_TOKEN": "your_bot_token_here"
      }
    }
  }
}

FEATURES:
- Send messages with automatic splitting for long content
- Send photos, documents, videos, audio, voice messages, animations, and stickers
- Send polls, quizzes, dice, locations, and contacts
- Edit, delete, forward, copy, and pin messages
- Manage chat members (ban/unban, restrict, promote)
- Manage chat settings and invite links
- Get chat, member, and file information
- Configure bot settings (name, description, commands)
- Comprehensive error handling with detailed feedback
- Upload local files, optionally restricted to TELEGRAM_UPLOAD_ROOTS (10 MB photos, 50 MB other media)
- Send video notes and media groups (albums), edit captions, and set reactions
- Convert local voice audio to OGG/Opus with ffmpeg (optional dependency)
- Download files of up to 20 MB into TELEGRAM_DOWNLOAD_DIR

For more information, visit: https://github.com/siavashdelkhosh81/telegram-bot-mcp-server
`);
  process.exit(0);
}

// Check for bot token
const TELEGRAM_BOT_API_TOKEN = process.env.TELEGRAM_BOT_API_TOKEN;

if (!TELEGRAM_BOT_API_TOKEN) {
  console.error(`
❌ Error: Missing Telegram Bot Token

Please set the TELEGRAM_BOT_API_TOKEN environment variable.

To get a bot token:
1. Open Telegram and search for @BotFather
2. Start a conversation and run: /newbot
3. Follow the prompts to create your bot
4. Copy the token and set it as an environment variable

Examples:
  TELEGRAM_BOT_API_TOKEN=your_token_here npx @null-topology/telegram-bot-mcp-server

Or add it to your MCP client configuration:
{
  "mcpServers": {
    "telegram_bot": {
      "command": "npx",
      "args": ["@null-topology/telegram-bot-mcp-server"],
      "env": {
        "TELEGRAM_BOT_API_TOKEN": "your_bot_token_here"
      }
    }
  }
}
`);
  process.exit(1);
}

void startServer(TELEGRAM_BOT_API_TOKEN);
