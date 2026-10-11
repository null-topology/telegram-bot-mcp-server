import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Telegraf } from "telegraf";
import { z } from "zod";
import { handleToolError, jsonResult, textResult } from "../utils";
import { chatIdSchema, toolMetadata } from "./common";

export function registerInviteTools(server: McpServer, bot: Telegraf) {
  server.registerTool("create-chat-invite-link", {
    ...toolMetadata("create-chat-invite-link"),
    description: "Create an additional invite link for a chat. The bot must be an administrator with the appropriate rights. Returns the new invite link.",
    inputSchema: {
      chatId: chatIdSchema,
      name: z.string().describe("Invite link name; 0-32 characters").optional(),
      expireDate: z.number().describe("Unix timestamp when the link will expire").optional(),
      memberLimit: z.number().describe("Maximum number of users that can be members of the chat simultaneously after joining via this invite link; 1-99999").optional(),
    },
  }, async ({ chatId, name, expireDate, memberLimit }) => {
    try { return jsonResult(await bot.telegram.createChatInviteLink(chatId, { name, expire_date: expireDate, member_limit: memberLimit })); }
    catch (error) { return handleToolError(error, "create-chat-invite-link", `Creating invite link for chat ${chatId}`); }
  });

  server.registerTool("revoke-chat-invite-link", {
    ...toolMetadata("revoke-chat-invite-link"),
    description: "Revoke an invite link created by the bot. If the primary link is revoked, a new one is automatically generated.",
    inputSchema: { chatId: chatIdSchema, inviteLink: z.string().describe("The invite link to revoke") },
  }, async ({ chatId, inviteLink }) => {
    try { return jsonResult(await bot.telegram.revokeChatInviteLink(chatId, inviteLink)); }
    catch (error) { return handleToolError(error, "revoke-chat-invite-link", `Revoking invite link for chat ${chatId}`); }
  });

  server.registerTool("export-chat-invite-link", {
    ...toolMetadata("export-chat-invite-link"),
    description: "Generate a new primary invite link for a chat; any previously generated primary link is revoked. Returns the new invite link.",
    inputSchema: { chatId: chatIdSchema },
  }, async ({ chatId }) => {
    try { return textResult(await bot.telegram.exportChatInviteLink(chatId)); }
    catch (error) { return handleToolError(error, "export-chat-invite-link", `Exporting invite link for chat ${chatId}`); }
  });
}
