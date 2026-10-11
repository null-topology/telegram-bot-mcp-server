import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Telegraf } from "telegraf";
import { z } from "zod";
import { handleToolError, messageResult, sendPhotoWithLongCaption, sendWithLongCaption } from "../utils";
import { chatIdSchema, parseSchema, sendOptions, sendSchema, toolMetadata } from "./common";

const captionBehavior = " Captions exceeding 1024 characters continue as text messages; common send options and JSON message identifiers are supported.";

export function registerMediaTools(server: McpServer, bot: Telegraf) {
  server.registerTool("send-photo", {
    ...toolMetadata("send-photo"),
    description: "Send photo with caption using a chat id. Automatically handles long captions that exceed Telegram's character limit by splitting them across multiple messages." + captionBehavior,
    inputSchema: {
      chatId: chatIdSchema,
      text: z.string().describe("Caption for the photo. Long captions will be automatically split into multiple messages.").optional(),
      media: z.string().describe("Photo to send. Pass a file_id as String to send a photo that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a photo from the Internet, or upload a new photo using multipart/form-data. The photo must be at most 10 MB in size. The photo's width and height must not exceed 10000 in total. Width and height ratio must be at most 20 "),
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    try { return messageResult(await sendPhotoWithLongCaption(bot, input.chatId, input.media, input.text, sendOptions(input))); }
    catch (error) { return handleToolError(error, "send-photo", `Sending photo to chat ${input.chatId}`); }
  });

  server.registerTool("send-document", {
    ...toolMetadata("send-document"),
    description: "Send a document/file (PDF, ZIP, text file, etc.) to a chat. Bots can send files of up to 50 MB in size." + captionBehavior,
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Document to send. Pass a file_id as String to send a file that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get a file from the Internet"),
      caption: z.string().describe("Caption for the document; 0-1024 characters").optional(),
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    const { chatId, media, caption } = input;
    try {
      const options = sendOptions(input);
      return messageResult(await sendWithLongCaption(bot, chatId, first => bot.telegram.sendDocument(chatId, media, { ...options, caption: first }), caption, options));
    } catch (error) { return handleToolError(error, "send-document", `Sending document to chat ${chatId}`); }
  });

  server.registerTool("send-video", {
    ...toolMetadata("send-video"),
    description: "Send a video to a chat. Telegram clients support MPEG4 videos (other formats may be sent as Document). Bots can send video files of up to 50 MB in size." + captionBehavior,
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Video to send. Pass a file_id as String to send a video that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get a video from the Internet"),
      caption: z.string().describe("Caption for the video; 0-1024 characters").optional(),
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    const { chatId, media, caption } = input;
    try {
      const options = sendOptions(input);
      return messageResult(await sendWithLongCaption(bot, chatId, first => bot.telegram.sendVideo(chatId, media, { ...options, caption: first }), caption, options));
    } catch (error) { return handleToolError(error, "send-video", `Sending video to chat ${chatId}`); }
  });

  server.registerTool("send-audio", {
    ...toolMetadata("send-audio"),
    description: "Send an audio file to be displayed in the music player. Audio must be in .MP3 or .M4A format. Bots can send audio files of up to 50 MB in size." + captionBehavior,
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Audio file to send. Pass a file_id as String to send an audio file that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get an audio file from the Internet"),
      caption: z.string().describe("Caption for the audio; 0-1024 characters").optional(),
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    const { chatId, media, caption } = input;
    try {
      const options = sendOptions(input);
      return messageResult(await sendWithLongCaption(bot, chatId, first => bot.telegram.sendAudio(chatId, media, { ...options, caption: first }), caption, options));
    } catch (error) { return handleToolError(error, "send-audio", `Sending audio to chat ${chatId}`); }
  });

  server.registerTool("send-voice", {
    ...toolMetadata("send-voice"),
    description: "Send an audio file as a playable voice message. The file must be in .OGG format encoded with OPUS, or in .MP3/.M4A format." + captionBehavior,
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Voice message to send. Pass a file_id as String to send a file that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get a file from the Internet"),
      caption: z.string().describe("Caption for the voice message; 0-1024 characters").optional(),
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    const { chatId, media, caption } = input;
    try {
      const options = sendOptions(input);
      return messageResult(await sendWithLongCaption(bot, chatId, first => bot.telegram.sendVoice(chatId, media, { ...options, caption: first }), caption, options));
    } catch (error) { return handleToolError(error, "send-voice", `Sending voice message to chat ${chatId}`); }
  });

  server.registerTool("send-animation", {
    ...toolMetadata("send-animation"),
    description: "Send an animation (GIF or H.264/MPEG-4 AVC video without sound) to a chat. Bots can send animation files of up to 50 MB in size." + captionBehavior,
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Animation to send. Pass a file_id as String to send an animation that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get an animation from the Internet"),
      caption: z.string().describe("Caption for the animation; 0-1024 characters").optional(),
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    const { chatId, media, caption } = input;
    try {
      const options = sendOptions(input);
      return messageResult(await sendWithLongCaption(bot, chatId, first => bot.telegram.sendAnimation(chatId, media, { ...options, caption: first }), caption, options));
    } catch (error) { return handleToolError(error, "send-animation", `Sending animation to chat ${chatId}`); }
  });

  server.registerTool("send-sticker", {
    ...toolMetadata("send-sticker"),
    description: "Send a static .WEBP, animated .TGS, or video .WEBM sticker to a chat. Supports common send options and returns JSON message and file identifiers.",
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Sticker to send. Pass a file_id as String to send a sticker that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get a .WEBP sticker from the Internet"),
      ...sendSchema,
    },
  }, async (input) => {
    try { return messageResult([await bot.telegram.sendSticker(input.chatId, input.media, sendOptions(input))]); }
    catch (error) { return handleToolError(error, "send-sticker", `Sending sticker to chat ${input.chatId}`); }
  });
}
