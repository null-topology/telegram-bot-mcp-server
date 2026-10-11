import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
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

/**
 * Replaces every literal occurrence of the bot token in outgoing messages. The SDK answers invalid
 * tool input with validation errors that quote the input, before any tool code runs.
 */
export function redactTransport(transport: Transport, token: string): Transport {
  if (!token) return transport;
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const text = JSON.stringify(message);
    return send(text.includes(token) ? JSON.parse(text.split(token).join("[REDACTED]")) as JSONRPCMessage : message, options);
  };
  return transport;
}

export async function startServer(token: string, transport: Transport = new StdioServerTransport()): Promise<void> {
  try {
    const server = createServer(new Telegraf(token));
    await server.connect(redactTransport(transport, token));
    console.error("Telegram bot MCP Server running on stdio");
  } catch (error) {
    const telegramError = createTelegramError(error, "Starting MCP server");
    logError(telegramError, "main");
    console.error("Failed to start Telegram bot MCP Server:", formatErrorForMCP(telegramError));
    process.exit(1);
  }
}
