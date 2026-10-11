import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Convenience } from "telegraf/types";
import type { FfmpegRunner } from "../voice";

export const chatIdSchema = z.string().describe("Unique identifier for the target chat or username of the target channel");
export const userIdSchema = z.number().describe("Unique identifier of the target user");
export const threadSchema = {
  messageThreadId: z.number().optional().describe("Identifier of the target forum message thread"),
};
export const forwardSchema = {
  ...threadSchema,
  disableNotification: z.boolean().optional().describe("Send silently without a notification sound"),
  protectContent: z.boolean().optional().describe("Protect the sent content from forwarding and saving"),
};
export const sendSchema = {
  ...forwardSchema,
  replyToMessageId: z.number().optional().describe("Message to reply to; send even if the original message is unavailable"),
};
export const parseSchema = {
  parseMode: z.enum(["HTML", "MarkdownV2", "none"]).optional().describe("Formatting mode for text or captions; none omits Telegram's parse_mode"),
};
export const previewSchema = {
  disableLinkPreview: z.boolean().optional().describe("Disable link previews in the message text"),
};
export const filenameSchema = z.string().min(1).max(255)
  .regex(/^[^\x00-\x1f\x7f"\\/]+$/, "File name must not contain slashes, quotes or control characters")
  .optional().describe("File name shown in Telegram for an uploaded local file; ignored for file_id and URL inputs");

/** Dependencies that tests can replace. */
export interface ToolOptions {
  runFfmpeg?: FfmpegRunner;
}

interface SendInputs {
  messageThreadId?: number;
  disableNotification?: boolean;
  protectContent?: boolean;
  replyToMessageId?: number;
  parseMode?: "HTML" | "MarkdownV2" | "none";
  disableLinkPreview?: boolean;
}

export function sendOptions(input: SendInputs): Convenience.ExtraReplyMessage {
  return {
    ...(input.messageThreadId !== undefined && { message_thread_id: input.messageThreadId }),
    ...(input.disableNotification !== undefined && { disable_notification: input.disableNotification }),
    ...(input.protectContent !== undefined && { protect_content: input.protectContent }),
    ...(input.replyToMessageId !== undefined && {
      reply_parameters: { message_id: input.replyToMessageId, allow_sending_without_reply: true },
    }),
    ...textOptions(input),
  };
}

export function textOptions(input: SendInputs): Convenience.ExtraEditMessageText {
  return {
    ...(input.parseMode && input.parseMode !== "none" && { parse_mode: input.parseMode }),
    ...(input.disableLinkPreview === true && { link_preview_options: { is_disabled: true } }),
  };
}

/** Option fields that Telegraf leaves out of multipart requests unless they are already strings. */
const MULTIPART_JSON_FIELDS = ["reply_parameters", "link_preview_options"] as const;

/**
 * Returns extra unchanged for JSON requests. When the call uploads a local file, Telegraf sends
 * multipart/form-data and drops these nested objects, so they are passed as JSON strings.
 */
export function multipartOptions<T extends object>(extra: T, uploading: boolean): T {
  if (!uploading) return extra;
  const result = { ...extra } as Record<string, unknown>;
  for (const field of MULTIPART_JSON_FIELDS) {
    if (result[field] !== undefined && typeof result[field] !== "string") result[field] = JSON.stringify(result[field]);
  }
  return result as T;
}

/** True when a resolved media value is a local upload rather than a file_id or URL string. */
export function isUpload(media: unknown): boolean {
  return typeof media === "object" && media !== null;
}

const readOnly = new Set([
  "get-me", "get-chat", "get-chat-member-count", "get-chat-member",
  "get-my-short-description", "get-my-commands", "get-my-name", "get-my-description",
  "get-chat-administrators", "get-user-profile-photos", "get-file",
]);
const destructive = new Set([
  "delete-message", "kick-chat-member", "un-ban-chat-member", "restrict-chat-member",
  "promote-chat-member", "leave-chat", "revoke-chat-invite-link",
  "export-chat-invite-link", "unpin-all-chat-messages",
]);

export function toolMetadata(name: string): { title: string; annotations: ToolAnnotations } {
  const title = name.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
  return {
    title,
    annotations: {
      title,
      readOnlyHint: readOnly.has(name),
      destructiveHint: destructive.has(name),
      openWorldHint: true,
    },
  };
}
