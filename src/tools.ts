import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Telegraf } from "telegraf";
import { registerBotTools } from "./tools/bot";
import { registerChatTools } from "./tools/chat";
import { registerFileTools } from "./tools/files";
import { registerInteractiveTools } from "./tools/interactive";
import { registerInviteTools } from "./tools/invites";
import { registerMediaTools } from "./tools/media";
import { registerMemberTools } from "./tools/members";
import { registerMessageTools } from "./tools/messages";

/** Registers every Telegram tool without starting an update consumer. */
export function registerAllTools(server: McpServer, bot: Telegraf) {
  registerBotTools(server, bot);
  registerMessageTools(server, bot);
  registerMediaTools(server, bot);
  registerInteractiveTools(server, bot);
  registerChatTools(server, bot);
  registerMemberTools(server, bot);
  registerInviteTools(server, bot);
  registerFileTools(server, bot);
}
