import { inspect } from "node:util";
import { Telegraf, type Telegram } from "telegraf";
import { multipartOptions } from "./tools/common";
import type { InputFile, Message, Convenience } from "telegraf/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const TELEGRAM_CAPTION_LIMIT = 1024;

/** Caption length as counted for TELEGRAM_CAPTION_LIMIT checks: UTF-16 code units. */
export function captionLength(caption: string): number {
  return caption.length;
}

// Telegram's message length limit
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Interface for error details
 */
export interface TelegramError {
  code?: number;
  retryAfter?: number;
  description: string;
  context?: string;
  originalError?: any;
  deliveredMessageIds?: number[];
  mediaDelivered?: boolean;
}

/** Returns a UTF-16 boundary without separating a surrogate pair. */
function safeSplitIndex(text: string, index: number): number {
  const end = Math.min(index, text.length);
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF
    ? end - 1 : end;
}

/**
 * Splits a long message into chunks that respect Telegram's character limit
 * while preserving word boundaries and formatting where possible
 */
export function splitMessage(text: string, maxLength: number = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= maxLength) {
    return text.trim() ? [text] : [];
  }

  const chunks: string[] = [];
  let currentChunk = '';

  // Split by paragraphs first (double newlines)
  const paragraphs = text.split('\n\n');

  for (const paragraph of paragraphs) {
    // If a single paragraph is too long, we need to split it further
    if (paragraph.length > maxLength) {
      // If we have content in current chunk, save it first
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // Split long paragraph by sentences
      const sentences = paragraph.split(/(?<=[.!?])\s+/);

      for (const sentence of sentences) {
        // If a single sentence is still too long, split by words
        if (sentence.length > maxLength) {
          // Save current chunk if it has content
          if (currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = '';
          }

          // Split by words
          const words = sentence.split(' ');
          for (const word of words) {
            // If a single word is too long, we have to split it (rare case)
            if (word.length > maxLength) {
              // Save current chunk if it has content
              if (currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
              }

              // Split the word into character chunks, advancing by at least one code point
              for (let i = 0; i < word.length;) {
                let end = safeSplitIndex(word, i + Math.max(maxLength - 3, 1));
                if (end <= i) end = i + (word.codePointAt(i)! > 0xFFFF ? 2 : 1);
                const wordChunk = word.slice(i, end);
                chunks.push(wordChunk + (end < word.length ? '...' : ''));
                i = end;
              }
            } else {
              // Check if adding this word would exceed the limit
              const testChunk = currentChunk + (currentChunk ? ' ' : '') + word;
              if (testChunk.length > maxLength) {
                // Save current chunk and start new one
                chunks.push(currentChunk.trim());
                currentChunk = word;
              } else {
                currentChunk = testChunk;
              }
            }
          }
        } else {
          // Check if adding this sentence would exceed the limit
          const testChunk = currentChunk + (currentChunk ? ' ' : '') + sentence;
          if (testChunk.length > maxLength) {
            // Save current chunk and start new one
            chunks.push(currentChunk.trim());
            currentChunk = sentence;
          } else {
            currentChunk = testChunk;
          }
        }
      }
    } else {
      // Check if adding this paragraph would exceed the limit
      const testChunk = currentChunk + (currentChunk ? '\n\n' : '') + paragraph;
      if (testChunk.length > maxLength) {
        // Save current chunk and start new one
        chunks.push(currentChunk.trim());
        currentChunk = paragraph;
      } else {
        currentChunk = testChunk;
      }
    }
  }

  // Add the last chunk if it has content
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(chunk => chunk.trim().length > 0);
}

function partFooter(part: number, total: number): string {
  return `\n\n\u{1F4C4} Part ${part}/${total}`;
}

/** Sends text sequentially, reserving room for the part indicator. */
export async function sendLongMessage(
  bot: Telegraf,
  chatId: string,
  text: string,
  options: Convenience.ExtraReplyMessage = {}
): Promise<Message[]> {
  let chunks = splitMessage(text);
  if (chunks.length > 1) {
    let reserved = partFooter(chunks.length, chunks.length).length;
    while (true) {
      chunks = splitMessage(text, TELEGRAM_MESSAGE_LIMIT - reserved);
      const required = partFooter(chunks.length, chunks.length).length;
      if (required <= reserved) break;
      reserved = required;
    }
  }

  const messages: Message[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const messageText = chunks.length > 1
      ? chunks[i] + partFooter(i + 1, chunks.length)
      : chunks[i];
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 100));
    try {
      messages.push(await bot.telegram.sendMessage(chatId, messageText, options));
    } catch (error) {
      throw {
        ...createTelegramError(error),
        deliveredMessageIds: messages.map(message => message.message_id),
      };
    }
  }
  return messages;
}

/** Sends a caption-bearing item followed by any caption overflow as text. */
export async function sendWithLongCaption<T extends { message_id: number }>(
  bot: Telegraf,
  chatId: string,
  send: (caption?: string) => Promise<T>,
  caption?: string,
  options: Convenience.ExtraReplyMessage = {}
): Promise<[T, ...Message[]]> {
  const boundary = caption === undefined ? 0 : safeSplitIndex(caption, TELEGRAM_CAPTION_LIMIT);
  const first = await send(caption?.slice(0, boundary));
  const remainder = caption?.slice(boundary);
  if (!remainder?.trim()) return [first];
  await new Promise(resolve => setTimeout(resolve, 100));
  try {
    return [first, ...await sendLongMessage(bot, chatId, remainder, options)];
  } catch (error) {
    const normalized = createTelegramError(error);
    throw {
      ...normalized,
      deliveredMessageIds: [first.message_id, ...(normalized.deliveredMessageIds ?? [])],
      mediaDelivered: true,
    };
  }
}

/**
 * Sends a photo through telegram (bot.telegram unless an upload batch view is given). With uploading
 * set, the photo request carries multipart-safe options; caption overflow keeps the originals.
 */
export async function sendPhotoWithLongCaption(
  bot: Telegraf,
  chatId: string,
  media: string | InputFile,
  caption?: string,
  options: Convenience.ExtraPhoto = {},
  telegram: Telegram = bot.telegram,
  uploading = false
): Promise<Message[]> {
  const extra = multipartOptions(options, uploading);
  return sendWithLongCaption(bot, chatId,
    first => telegram.sendPhoto(chatId, media, { ...extra, caption: first }),
    caption, options);
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(result: unknown): CallToolResult {
  return textResult(JSON.stringify(result, null, 2));
}

/** Summarizes the first message and every delivered part in order. */
export function messageResult(messages: Message[]): CallToolResult {
  if (!messages.length) {
    return { isError: true, content: [{ type: "text", text: formatErrorForMCP({ description: "No message was sent" }) }] };
  }
  const first = messages[0];
  const result = {
    chat_id: first.chat.id,
    message_id: first.message_id,
    message_ids: messages.map(message => message.message_id),
    date: first.date,
    ...("dice" in first ? { dice: { emoji: first.dice.emoji, value: first.dice.value } } : {}),
  };
  return jsonResult({ ...result, ...messageFile(first) });
}

/** File identifiers of a message's media; photos report their largest size. */
export function messageFile(message: Message): { file_id: string; file_unique_id: string } | undefined {
  let file;
  if ("photo" in message) {
    file = message.photo.reduce((largest, photo) =>
      photo.width * photo.height > largest.width * largest.height ? photo : largest);
  } else if ("animation" in message) file = message.animation;
  else if ("document" in message) file = message.document;
  else if ("video" in message) file = message.video;
  else if ("audio" in message) file = message.audio;
  else if ("voice" in message) file = message.voice;
  else if ("video_note" in message) file = message.video_note;
  else if ("sticker" in message) file = message.sticker;
  return file && { file_id: file.file_id, file_unique_id: file.file_unique_id };
}

/** Summarizes an album: every message id plus each item's file identifiers. */
export function mediaGroupResult(messages: Message[]): CallToolResult {
  if (!messages.length) return messageResult(messages);
  const [first] = messages;
  return jsonResult({
    chat_id: first.chat.id,
    message_id: first.message_id,
    message_ids: messages.map(message => message.message_id),
    date: first.date,
    items: messages.map(message => ({ message_id: message.message_id, ...messageFile(message) })),
  });
}

/**
 * Creates a standardized error object with detailed information
 */
export function createTelegramError(error: any, context?: string): TelegramError {
  if (typeof error?.description === "string" && Object.prototype.hasOwnProperty.call(error, "originalError")) {
    return { ...error, context: context || error.context };
  }
  let telegramError: TelegramError = {
    description: 'Unknown error occurred',
    context: context || 'Telegram API operation',
    originalError: error
  };

  if (error?.response?.error_code) {
    // Telegram API error
    telegramError.code = error.response.error_code;
    telegramError.description = error.response.description || error.message || 'Telegram API error';
    if (telegramError.code === 429) {
      telegramError.retryAfter = error.response.parameters?.retry_after;
    }
  } else if (error?.code) {
    // Network or other coded error
    telegramError.code = error.code;
    telegramError.description = error.message || 'Network or system error';
  } else if (error?.message) {
    // Generic error with message
    telegramError.description = error.message;
  } else if (typeof error === 'string') {
    // String error
    telegramError.description = error;
  }

  return telegramError;
}

/**
 * Masks bot credentials, e.g. the request URL that network errors echo back.
 */
export function redactSecrets(text: string): string {
  const redacted = text.replace(/(bot|user)(\d+):[^\/\s"']+/g, "$1$2:[REDACTED]");
  const token = process.env.TELEGRAM_BOT_API_TOKEN;
  return token ? redacted.replaceAll(token, "[REDACTED]") : redacted;
}

/**
 * Formats an error for MCP response
 */
export function formatErrorForMCP(error: TelegramError): string {
  let errorMessage = `Error: ${error.description}`;

  if (error.code) {
    errorMessage = `Error ${error.code}: ${error.description}`;
  }

  // Local failures have no code; only Telegram and network errors report one.
  if (error.code !== undefined && error.code !== null) {
    errorMessage += `\nerror_code: ${error.code}`;
  }
  errorMessage += `\ndescription: ${error.description}`;
  if (error.retryAfter !== undefined) {
    errorMessage += `\nretry_after: ${error.retryAfter}`;
  }

  if (error.context) {
    errorMessage += `\nContext: ${error.context}`;
  }

  return redactSecrets(errorMessage);
}

/**
 * Logs error details for debugging while maintaining privacy
 */
export function logError(error: TelegramError, operation: string): void {
  console.error(redactSecrets(`[${operation}] ${error.code ? `Code ${error.code}: ` : ''}${error.description}`));

  if (error.context) {
    console.error(redactSecrets(`[${operation}] Context: ${error.context}`));
  }

  // Log original error for debugging (but not sensitive data)
  if (error.originalError && process.env.NODE_ENV === 'development') {
    console.error(redactSecrets(`[${operation}] Original error: ${inspect(error.originalError)}`));
  }
}

/**
 * Generic error handler for MCP tool responses
 */
export function handleToolError(error: any, operation: string, context?: string): CallToolResult {
  const telegramError = createTelegramError(error, context || operation);
  // Report partial delivery only when something actually reached the chat.
  if (telegramError.deliveredMessageIds?.length) {
    telegramError.context += `; Delivered ${telegramError.deliveredMessageIds.length} part(s); message_ids: ${JSON.stringify(telegramError.deliveredMessageIds)}`;
    if (telegramError.mediaDelivered) telegramError.context += "; media was delivered";
  }
  logError(telegramError, operation);

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: formatErrorForMCP(telegramError),
      },
    ],
  };
}
