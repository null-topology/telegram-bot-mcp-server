import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Telegraf } from "telegraf";
import { registerAllTools } from "./tools";
import { createTelegramError, formatErrorForMCP, logError } from "./utils";

export const packageInfo: { name: string; version: string; description: string } = require("../package.json");

export function createServer(bot: Telegraf): McpServer {
  const server = new McpServer(
    { name: "telegram_bot", version: packageInfo.version },
    { capabilities: { tools: {} } }
  );
  registerAllTools(server, bot);
  return server;
}

export async function startServer(token: string): Promise<void> {
  try {
    const server = createServer(new Telegraf(token));
    await server.connect(new StdioServerTransport());
    console.error("Telegram bot MCP Server running on stdio");
  } catch (error) {
    const telegramError = createTelegramError(error, "Starting MCP server");
    logError(telegramError, "main");
    console.error("Failed to start Telegram bot MCP Server:", formatErrorForMCP(telegramError));
    process.exit(1);
  }
}
