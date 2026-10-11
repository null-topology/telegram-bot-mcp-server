import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Telegraf } from "telegraf";
import { z } from "zod";
import { TelegramCommandSchema } from "../types";
import { handleToolError, jsonResult, textResult } from "../utils";
import { toolMetadata } from "./common";

export function registerBotTools(server: McpServer, bot: Telegraf) {
  server.registerTool("get-me", {
    ...toolMetadata("get-me"),
    description: "A simple method for testing your bot's authentication token. Requires no parameters. Returns detailed bot information or comprehensive error details.",
    inputSchema: {},
  }, async () => {
    try { return jsonResult(await bot.telegram.getMe()); }
    catch (error) { return handleToolError(error, "get-me", "Testing bot authentication"); }
  });

  server.registerTool("set-my-short-description", {
    ...toolMetadata("set-my-short-description"),
    description: "Use this method to change the bot's short description, which is shown on the bot's profile page and is sent together with the link when users share the bot",
    inputSchema: { short_description: z.string().describe("New short description for the bot; 0-120 characters. Pass an empty string to remove the dedicated short description for the given language") },
  }, async ({ short_description }) => {
    try {
      await bot.telegram.setMyShortDescription(short_description);
      return textResult("Successfully update short description");
    } catch (error) { return handleToolError(error, "set-my-short-description", "Setting bot short description"); }
  });

  server.registerTool("get-my-short-description", {
    ...toolMetadata("get-my-short-description"),
    description: "Use this method to get the current bot short description",
    inputSchema: {},
  }, async () => {
    try { return textResult(JSON.stringify(await bot.telegram.getMyShortDescription())); }
    catch (error) { return handleToolError(error, "get-my-short-description", "Getting bot short description"); }
  });

  server.registerTool("set-my-commands", {
    ...toolMetadata("set-my-commands"),
    description: "Use this method to change the list of the bot's commands",
    inputSchema: { commands: z.array(TelegramCommandSchema) },
  }, async ({ commands }) => {
    try {
      await bot.telegram.setMyCommands(commands);
      return textResult("Successfully updated bot commands");
    } catch (error) { return handleToolError(error, "set-my-commands", "Setting bot commands"); }
  });

  server.registerTool("get-my-commands", {
    ...toolMetadata("get-my-commands"),
    description: "Use this method to get the current list of the bot's commands",
    inputSchema: {},
  }, async () => {
    try { return jsonResult(await bot.telegram.getMyCommands()); }
    catch (error) { return handleToolError(error, "get-my-commands", "Getting bot commands"); }
  });

  server.registerTool("set-my-name", {
    ...toolMetadata("set-my-name"),
    description: "Use this method to change the bot's name",
    inputSchema: { name: z.string().describe("New bot name; 0-64 characters") },
  }, async ({ name }) => {
    try {
      await bot.telegram.setMyName(name);
      return textResult("Successfully updated bot name");
    } catch (error) { return handleToolError(error, "set-my-name", "Setting bot name"); }
  });

  server.registerTool("get-my-name", {
    ...toolMetadata("get-my-name"),
    description: "Use this method to get the bot's name",
    inputSchema: {},
  }, async () => {
    try { return jsonResult(await bot.telegram.getMyName()); }
    catch (error) { return handleToolError(error, "get-my-name", "Getting bot name"); }
  });

  server.registerTool("set-my-description", {
    ...toolMetadata("set-my-description"),
    description: "Use this method to change the bot's description, which is shown in the chat with the bot if the chat is empty",
    inputSchema: { description: z.string().describe("New bot description; 0-512 characters") },
  }, async ({ description }) => {
    try {
      await bot.telegram.setMyDescription(description);
      return textResult("Successfully updated bot description");
    } catch (error) { return handleToolError(error, "set-my-description", "Setting bot description"); }
  });

  server.registerTool("get-my-description", {
    ...toolMetadata("get-my-description"),
    description: "Use this method to get the bot's description",
    inputSchema: {},
  }, async () => {
    try { return jsonResult(await bot.telegram.getMyDescription()); }
    catch (error) { return handleToolError(error, "get-my-description", "Getting bot description"); }
  });
}
