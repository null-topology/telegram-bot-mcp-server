import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Convenience } from "telegraf/types";

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
