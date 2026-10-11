import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Telegraf } from "telegraf";
import { z } from "zod";
import { downloadFile } from "../downloads";
import { handleToolError, jsonResult } from "../utils";
import { toolMetadata, userIdSchema } from "./common";

export function registerFileTools(server: McpServer, bot: Telegraf) {
  server.registerTool("get-user-profile-photos", {
    ...toolMetadata("get-user-profile-photos"),
    description: "Get a user's profile pictures, including file IDs that can be re-sent with send-photo.",
    inputSchema: {
      userId: userIdSchema,
      offset: z.number().describe("Sequential number of the first photo to be returned. By default, all photos are returned").optional(),
      limit: z.number().describe("Limits the number of photos to be retrieved. Values between 1-100 are accepted. Defaults to 100").optional(),
    },
  }, async ({ userId, offset, limit }) => {
    try { return jsonResult(await bot.telegram.getUserProfilePhotos(userId, offset, limit)); }
    catch (error) { return handleToolError(error, "get-user-profile-photos", `Getting profile photos of user ${userId}`); }
  });

  server.registerTool("get-file", {
    ...toolMetadata("get-file"),
    description: "Get basic info about a file (by file_id). Bots can download files of up to 20 MB in size. The result contains no download URL.",
    inputSchema: { fileId: z.string().describe("File identifier to get information about") },
  }, async ({ fileId }) => {
    try {
      return jsonResult(await bot.telegram.getFile(fileId));
    } catch (error) { return handleToolError(error, "get-file", `Getting file info for ${fileId}`); }
  });

  server.registerTool("download-file", {
    ...toolMetadata("download-file"),
    description: "Download a file (by file_id) into TELEGRAM_DOWNLOAD_DIR on the server host. Bots can download files of up to 20 MB in size. Returns JSON with the saved path, size, MIME type and file identifiers; the download URL is never returned.",
    inputSchema: { fileId: z.string().describe("Identifier of the file to download") },
  }, async ({ fileId }) => {
    try { return jsonResult(await downloadFile(bot, fileId)); }
    catch (error) { return handleToolError(error, "download-file", `Downloading file ${fileId}`); }
  });
}
