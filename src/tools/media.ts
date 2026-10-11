import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Telegraf } from "telegraf";
import type { Convenience } from "telegraf/types";
import { z } from "zod";
import { PHOTO_UPLOAD_LIMIT, UPLOAD_LIMIT, withUploads } from "../uploads";
import { captionLength, handleToolError, mediaGroupResult, messageResult, sendPhotoWithLongCaption, sendWithLongCaption, TELEGRAM_CAPTION_LIMIT } from "../utils";
import { prepareVoice } from "../voice";
import { chatIdSchema, filenameSchema, isUpload, multipartOptions, parseSchema, sendOptions, sendSchema, textOptions, toolMetadata, ToolOptions } from "./common";

const captionBehavior = " Captions exceeding 1024 characters continue as text messages; common send options and JSON message identifiers are supported.";
const inputForms = (limit: string) => ` Media accepts a Telegram file_id, an http(s) URL, or an absolute local path, restricted to TELEGRAM_UPLOAD_ROOTS when it lists at least one directory (uploads up to ${limit}, with an optional filename).`;

export function registerMediaTools(server: McpServer, bot: Telegraf, options: ToolOptions = {}) {
  server.registerTool("send-photo", {
    ...toolMetadata("send-photo"),
    description: "Send photo with caption using a chat id. Automatically handles long captions that exceed Telegram's character limit by splitting them across multiple messages." + captionBehavior + inputForms("10 MB"),
    inputSchema: {
      chatId: chatIdSchema,
      text: z.string().describe("Caption for the photo. Long captions will be automatically split into multiple messages.").optional(),
      media: z.string().describe("Photo to send. Pass a file_id as String to send a photo that exists on the Telegram servers (recommended), pass an HTTP URL as a String for Telegram to get a photo from the Internet, or upload a new photo using multipart/form-data. The photo must be at most 10 MB in size. The photo's width and height must not exceed 10000 in total. Width and height ratio must be at most 20 "),
      filename: filenameSchema,
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    try {
      return messageResult(await withUploads(async uploads => {
        const media = await uploads.resolve(input.media, PHOTO_UPLOAD_LIMIT, input.filename);
        return sendPhotoWithLongCaption(bot, input.chatId, media, input.text, sendOptions(input), uploads.telegram(bot.telegram), isUpload(media));
      }));
    } catch (error) { return handleToolError(error, "send-photo", `Sending photo to chat ${input.chatId}`); }
  });

  server.registerTool("send-document", {
    ...toolMetadata("send-document"),
    description: "Send a document/file (PDF, ZIP, text file, etc.) to a chat. Bots can send files of up to 50 MB in size." + captionBehavior + inputForms("50 MB"),
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Document to send. Pass a file_id as String to send a file that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get a file from the Internet"),
      caption: z.string().describe("Caption for the document; 0-1024 characters").optional(),
      filename: filenameSchema,
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    const { chatId, caption } = input;
    try {
      return messageResult(await withUploads(async uploads => {
        const media = await uploads.resolve(input.media, UPLOAD_LIMIT, input.filename);
        const telegram = uploads.telegram(bot.telegram);
        const options = sendOptions(input);
        const extra = multipartOptions(options, isUpload(media));
        return sendWithLongCaption(bot, chatId, first => telegram.sendDocument(chatId, media, { ...extra, caption: first }), caption, options);
      }));
    } catch (error) { return handleToolError(error, "send-document", `Sending document to chat ${chatId}`); }
  });

  server.registerTool("send-video", {
    ...toolMetadata("send-video"),
    description: "Send a video to a chat. Telegram clients support MPEG4 videos (other formats may be sent as Document). Bots can send video files of up to 50 MB in size." + captionBehavior + inputForms("50 MB"),
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Video to send. Pass a file_id as String to send a video that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get a video from the Internet"),
      caption: z.string().describe("Caption for the video; 0-1024 characters").optional(),
      filename: filenameSchema,
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    const { chatId, caption } = input;
    try {
      return messageResult(await withUploads(async uploads => {
        const media = await uploads.resolve(input.media, UPLOAD_LIMIT, input.filename);
        const telegram = uploads.telegram(bot.telegram);
        const options = sendOptions(input);
        const extra = multipartOptions(options, isUpload(media));
        return sendWithLongCaption(bot, chatId, first => telegram.sendVideo(chatId, media, { ...extra, caption: first }), caption, options);
      }));
    } catch (error) { return handleToolError(error, "send-video", `Sending video to chat ${chatId}`); }
  });

  server.registerTool("send-audio", {
    ...toolMetadata("send-audio"),
    description: "Send an audio file to be displayed in the music player. Audio must be in .MP3 or .M4A format. Bots can send audio files of up to 50 MB in size." + captionBehavior + inputForms("50 MB"),
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Audio file to send. Pass a file_id as String to send an audio file that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get an audio file from the Internet"),
      caption: z.string().describe("Caption for the audio; 0-1024 characters").optional(),
      filename: filenameSchema,
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    const { chatId, caption } = input;
    try {
      return messageResult(await withUploads(async uploads => {
        const media = await uploads.resolve(input.media, UPLOAD_LIMIT, input.filename);
        const telegram = uploads.telegram(bot.telegram);
        const options = sendOptions(input);
        const extra = multipartOptions(options, isUpload(media));
        return sendWithLongCaption(bot, chatId, first => telegram.sendAudio(chatId, media, { ...extra, caption: first }), caption, options);
      }));
    } catch (error) { return handleToolError(error, "send-audio", `Sending audio to chat ${chatId}`); }
  });

  server.registerTool("send-voice", {
    ...toolMetadata("send-voice"),
    description: "Send an audio file as a playable voice message. The file must be in .OGG format encoded with OPUS, or in .MP3/.M4A format." + captionBehavior
      + " Media accepts a Telegram file_id, an http(s) URL, or an absolute local path, restricted to TELEGRAM_UPLOAD_ROOTS when it lists at least one directory (uploads up to 50 MB, with an optional filename); local audio that is not OGG/Opus is converted with ffmpeg.",
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Voice message to send. Pass a file_id as String to send a file that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get a file from the Internet"),
      caption: z.string().describe("Caption for the voice message; 0-1024 characters").optional(),
      duration: z.number().int().positive().optional().describe("Duration of the voice message in seconds"),
      filename: filenameSchema,
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    const { chatId, caption, duration } = input;
    try {
      return messageResult(await withUploads(async uploads => {
        const voice = await prepareVoice(uploads, input.media, input.filename, options.runFfmpeg);
        try {
          const telegram = uploads.telegram(bot.telegram);
          const send = sendOptions(input);
          const extra = multipartOptions(send, isUpload(voice.media));
          return await sendWithLongCaption(bot, chatId, first => telegram.sendVoice(chatId, voice.media, {
            ...extra, caption: first, ...(duration !== undefined && { duration }),
          }), caption, send);
        } finally {
          await voice.cleanup();
        }
      }));
    } catch (error) { return handleToolError(error, "send-voice", `Sending voice message to chat ${chatId}`); }
  });

  server.registerTool("send-animation", {
    ...toolMetadata("send-animation"),
    description: "Send an animation (GIF or H.264/MPEG-4 AVC video without sound) to a chat. Bots can send animation files of up to 50 MB in size." + captionBehavior + inputForms("50 MB"),
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Animation to send. Pass a file_id as String to send an animation that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get an animation from the Internet"),
      caption: z.string().describe("Caption for the animation; 0-1024 characters").optional(),
      filename: filenameSchema,
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    const { chatId, caption } = input;
    try {
      return messageResult(await withUploads(async uploads => {
        const media = await uploads.resolve(input.media, UPLOAD_LIMIT, input.filename);
        const telegram = uploads.telegram(bot.telegram);
        const options = sendOptions(input);
        const extra = multipartOptions(options, isUpload(media));
        return sendWithLongCaption(bot, chatId, first => telegram.sendAnimation(chatId, media, { ...extra, caption: first }), caption, options);
      }));
    } catch (error) { return handleToolError(error, "send-animation", `Sending animation to chat ${chatId}`); }
  });

  server.registerTool("send-sticker", {
    ...toolMetadata("send-sticker"),
    description: "Send a static .WEBP, animated .TGS, or video .WEBM sticker to a chat. Supports common send options and returns JSON message and file identifiers." + inputForms("50 MB"),
    inputSchema: {
      chatId: chatIdSchema,
      media: z.string().describe("Sticker to send. Pass a file_id as String to send a sticker that exists on the Telegram servers (recommended), or pass an HTTP URL as a String for Telegram to get a .WEBP sticker from the Internet"),
      filename: filenameSchema,
      ...sendSchema,
    },
  }, async (input) => {
    try {
      return messageResult(await withUploads(async uploads => {
        const media = await uploads.resolve(input.media, UPLOAD_LIMIT, input.filename);
        return [await uploads.telegram(bot.telegram).sendSticker(input.chatId, media, multipartOptions(sendOptions(input), isUpload(media)))];
      }));
    } catch (error) { return handleToolError(error, "send-sticker", `Sending sticker to chat ${input.chatId}`); }
  });

  server.registerTool("send-video-note", {
    ...toolMetadata("send-video-note"),
    description: "Send a rounded square MPEG4 video message (video note) of up to 1 minute to a chat. Accepts a Telegram file_id or an absolute local path, restricted to TELEGRAM_UPLOAD_ROOTS when it lists at least one directory (uploads up to 50 MB, with an optional filename); Telegram does not accept video notes by URL. Video notes have no caption. Supports common send options and returns JSON message and file identifiers.",
    inputSchema: {
      chatId: chatIdSchema,
      videoNote: z.string().describe("Video note to send: a Telegram file_id (recommended) or an absolute local path, restricted to TELEGRAM_UPLOAD_ROOTS when it lists at least one directory"),
      duration: z.number().int().positive().optional().describe("Duration of the video in seconds"),
      length: z.number().int().positive().optional().describe("Video width and height, i.e. the diameter of the video message"),
      filename: filenameSchema,
      ...sendSchema,
    },
  }, async (input) => {
    const { chatId, duration, length } = input;
    try {
      return messageResult(await withUploads(async uploads => {
        const videoNote = await uploads.resolve(input.videoNote, UPLOAD_LIMIT, input.filename);
        return [await uploads.telegram(bot.telegram).sendVideoNote(chatId, videoNote as Exclude<typeof videoNote, { url: string }>, {
          ...multipartOptions(sendOptions(input), isUpload(videoNote)),
          ...(duration !== undefined && { duration }),
          ...(length !== undefined && { length }),
        })];
      }));
    } catch (error) { return handleToolError(error, "send-video-note", `Sending video note to chat ${chatId}`); }
  });

  server.registerTool("send-media-group", {
    ...toolMetadata("send-media-group"),
    description: "Send 2-10 photos, videos, documents or audio files as an album. Photos and videos can be mixed; documents and audio can only be grouped with items of their own type. Each item accepts a Telegram file_id, an http(s) URL, or an absolute local path, restricted to TELEGRAM_UPLOAD_ROOTS when it lists at least one directory (uploads up to 10 MB for photos and 50 MB otherwise). Captions are limited to 1024 characters and are never split. Supports reply, thread, silent and protected sending and returns JSON message identifiers with per-item file identifiers.",
    inputSchema: {
      chatId: chatIdSchema,
      media: z.array(z.object({
        type: z.enum(["photo", "video", "document", "audio"]).describe("Item type"),
        media: z.string().describe("Telegram file_id, http(s) URL, or absolute local path (restricted to TELEGRAM_UPLOAD_ROOTS when it lists at least one directory)"),
        caption: z.string().optional().describe("Item caption; 0-1024 characters"),
        ...parseSchema,
        filename: filenameSchema,
      })).min(2).max(10).describe("Album items, 2-10 entries"),
      ...sendSchema,
    },
  }, async (input) => {
    const { chatId, media } = input;
    try {
      // Validate the whole album before any file is read or Telegram is called.
      const types = new Set(media.map(item => item.type));
      for (const only of ["document", "audio"] as const) {
        if (types.has(only) && types.size > 1) {
          throw new Error(`A media group with ${only} items can only contain ${only} items; got ${[...types].join(", ")}`);
        }
      }
      media.forEach((item, index) => {
        // Formatted captions are measured by Telegram after entity parsing, so only plain text is checked here.
        const plain = item.parseMode === undefined || item.parseMode === "none";
        if (plain && item.caption !== undefined && captionLength(item.caption) > TELEGRAM_CAPTION_LIMIT) {
          throw new Error(`Caption of item ${index + 1} is ${captionLength(item.caption)} characters; media group captions are limited to ${TELEGRAM_CAPTION_LIMIT} characters and are not split`);
        }
      });
      return mediaGroupResult(await withUploads(async uploads => {
        const group = [];
        for (const item of media) {
          group.push({
            type: item.type,
            media: await uploads.resolve(item.media, item.type === "photo" ? PHOTO_UPLOAD_LIMIT : UPLOAD_LIMIT, item.filename),
            ...(item.caption !== undefined && { caption: item.caption }),
            ...textOptions(item),
          });
        }
        const extra = multipartOptions(sendOptions(input), group.some(item => isUpload(item.media)));
        return uploads.telegram(bot.telegram).sendMediaGroup(chatId, group as Convenience.MediaGroup, extra);
      }));
    } catch (error) { return handleToolError(error, "send-media-group", `Sending media group to chat ${chatId}`); }
  });
}
