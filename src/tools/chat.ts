import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Telegraf } from "telegraf";
import { z } from "zod";
import { handleToolError, jsonResult, textResult } from "../utils";
import { chatIdSchema, toolMetadata } from "./common";

export function registerChatTools(server: McpServer, bot: Telegraf) {
  server.registerTool("get-chat", {
    ...toolMetadata("get-chat"),
    description: "Use this method to get up-to-date information about the chat. Returns detailed chat information or comprehensive error details.",
    inputSchema: { chatId: chatIdSchema },
  }, async ({ chatId }) => {
    try { return jsonResult(await bot.telegram.getChat(chatId)); }
    catch (error) { return handleToolError(error, "get-chat", `Getting chat information for ${chatId}`); }
  });

  server.registerTool("set-chat-title", {
    ...toolMetadata("set-chat-title"),
    description: "Change the title of a group, supergroup, or channel. The bot must be an administrator with the appropriate rights.",
    inputSchema: { chatId: chatIdSchema, title: z.string().describe("New chat title, 1-128 characters") },
  }, async ({ chatId, title }) => {
    try {
      await bot.telegram.setChatTitle(chatId, title);
      return textResult(`Chat title updated successfully for ${chatId}`);
    } catch (error) { return handleToolError(error, "set-chat-title", `Setting title for chat ${chatId}`); }
  });

  server.registerTool("set-chat-description", {
    ...toolMetadata("set-chat-description"),
    description: "Change the description of a group, supergroup, or channel. The bot must be an administrator with the appropriate rights.",
    inputSchema: { chatId: chatIdSchema, description: z.string().describe("New chat description, 0-255 characters. Pass an empty string to remove the description") },
  }, async ({ chatId, description }) => {
    try {
      await bot.telegram.setChatDescription(chatId, description);
      return textResult(`Chat description updated successfully for ${chatId}`);
    } catch (error) { return handleToolError(error, "set-chat-description", `Setting description for chat ${chatId}`); }
  });

  server.registerTool("get-chat-administrators", {
    ...toolMetadata("get-chat-administrators"),
    description: "Get a list of administrators in a chat (all admins except other bots), including their custom titles and rights.",
    inputSchema: { chatId: chatIdSchema },
  }, async ({ chatId }) => {
    try { return jsonResult(await bot.telegram.getChatAdministrators(chatId)); }
    catch (error) { return handleToolError(error, "get-chat-administrators", `Getting administrators of chat ${chatId}`); }
  });

  server.registerTool("leave-chat", {
    ...toolMetadata("leave-chat"),
    description: "Make the bot leave a group, supergroup, or channel.",
    inputSchema: { chatId: chatIdSchema },
  }, async ({ chatId }) => {
    try {
      await bot.telegram.leaveChat(chatId);
      return textResult(`Bot left chat ${chatId} successfully`);
    } catch (error) { return handleToolError(error, "leave-chat", `Leaving chat ${chatId}`); }
  });
}
