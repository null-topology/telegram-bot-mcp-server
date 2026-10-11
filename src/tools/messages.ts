import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Telegraf } from "telegraf";
import { z } from "zod";
import { handleToolError, jsonResult, messageResult, sendLongMessage, sendWithLongCaption, textResult } from "../utils";
import { chatIdSchema, forwardSchema, parseSchema, previewSchema, sendOptions, sendSchema, textOptions, threadSchema, toolMetadata } from "./common";

export function registerMessageTools(server: McpServer, bot: Telegraf) {
  server.registerTool("send-message", {
    ...toolMetadata("send-message"),
    description: "Send message using a chat id. Automatically splits long messages that exceed Telegram's 4096 character limit while preserving word boundaries and formatting. Supports common send options and returns JSON message identifiers.",
    inputSchema: {
      chatId: chatIdSchema,
      text: z.string().describe("Message the user want to send to chat id. Long messages will be automatically split into multiple parts."),
      ...sendSchema, ...parseSchema, ...previewSchema,
    },
  }, async (input) => {
    if (!input.text.trim()) {
      return handleToolError(new Error("Message text is empty or whitespace-only; nothing was sent"), "send-message", `Sending message to chat ${input.chatId}`);
    }
    try { return messageResult(await sendLongMessage(bot, input.chatId, input.text, sendOptions(input))); }
    catch (error) { return handleToolError(error, "send-message", `Sending message to chat ${input.chatId}`); }
  });

  server.registerTool("send-chat-action", {
    ...toolMetadata("send-chat-action"),
    description: "Show a status indicator in the chat (e.g. 'typing…', 'sending photo…'). The status is shown for 5 seconds or until the next message arrives. Useful to signal that a longer operation is in progress. Supports a target message thread.",
    inputSchema: {
      chatId: chatIdSchema,
      action: z.enum(["typing", "upload_photo", "record_video", "upload_video", "record_voice", "upload_voice", "upload_document", "choose_sticker", "find_location", "record_video_note", "upload_video_note"]).describe("Type of action to broadcast, matching what the user is about to receive"),
      ...threadSchema,
    },
  }, async ({ chatId, action, messageThreadId }) => {
    try {
      await bot.telegram.sendChatAction(chatId, action, messageThreadId === undefined ? {} : { message_thread_id: messageThreadId });
      return textResult(`Chat action '${action}' sent successfully`);
    } catch (error) { return handleToolError(error, "send-chat-action", `Sending chat action to chat ${chatId}`); }
  });

  server.registerTool("forward-message", {
    ...toolMetadata("forward-message"),
    description: "Forward a message of any kind from one chat to another. The forwarded message keeps a link to the original sender. Supports thread, notification and content protection options and returns JSON message identifiers.",
    inputSchema: {
      chatId: chatIdSchema,
      fromChatId: z.string().describe("Unique identifier for the chat where the original message was sent"),
      messageId: z.number().describe("Message identifier in the chat specified in fromChatId"),
      ...forwardSchema,
    },
  }, async (input) => {
    const { chatId, fromChatId, messageId } = input;
    try { return messageResult([await bot.telegram.forwardMessage(chatId, fromChatId, messageId, sendOptions(input))]); }
    catch (error) { return handleToolError(error, "forward-message", `Forwarding message ${messageId} from ${fromChatId} to ${chatId}`); }
  });

  server.registerTool("copy-message", {
    ...toolMetadata("copy-message"),
    description: "Copy a message of any kind from one chat to another. Unlike forwarding, the copied message does not have a link to the original message. Supports common send options, an optional replacement caption with overflow after 1024 characters, and JSON message identifiers.",
    inputSchema: {
      chatId: chatIdSchema,
      fromChatId: z.string().describe("Unique identifier for the chat where the original message was sent"),
      messageId: z.number().describe("Message identifier in the chat specified in fromChatId"),
      caption: z.string().optional().describe("Replacement caption; text beyond 1024 characters is sent as follow-up messages"),
      ...sendSchema, ...parseSchema,
    },
  }, async (input) => {
    const { chatId, fromChatId, messageId, caption } = input;
    try {
      const options = sendOptions(input);
      const messages = await sendWithLongCaption(bot, chatId,
        first => bot.telegram.copyMessage(chatId, fromChatId, messageId, { ...options, caption: first }), caption, options);
      return jsonResult({ chat_id: chatId, message_id: messages[0].message_id, message_ids: messages.map(message => message.message_id), date: null });
    } catch (error) { return handleToolError(error, "copy-message", `Copying message ${messageId} from ${fromChatId} to ${chatId}`); }
  });

  server.registerTool("edit-message-text", {
    ...toolMetadata("edit-message-text"),
    description: "Edit the text of a message previously sent by the bot. Supports formatting and link preview options and returns JSON message identifiers or an edit confirmation.",
    inputSchema: {
      chatId: chatIdSchema,
      messageId: z.number().describe("Identifier of the message to edit"),
      text: z.string().describe("New text of the message, 1-4096 characters"),
      ...parseSchema, ...previewSchema,
    },
  }, async (input) => {
    const { chatId, messageId, text } = input;
    try {
      const response = await bot.telegram.editMessageText(chatId, messageId, undefined, text, textOptions(input));
      return response === true ? jsonResult({ chat_id: chatId, message_id: messageId, edited: true }) : messageResult([response]);
    } catch (error) { return handleToolError(error, "edit-message-text", `Editing message ${messageId} in chat ${chatId}`); }
  });

  server.registerTool("delete-message", {
    ...toolMetadata("delete-message"),
    description: "Delete a message from a chat. Bots can delete their own messages, and incoming messages in groups/supergroups where they have the appropriate admin rights. A message can only be deleted if it was sent less than 48 hours ago.",
    inputSchema: { chatId: chatIdSchema, messageId: z.number().describe("Identifier of the message to delete") },
  }, async ({ chatId, messageId }) => {
    try {
      await bot.telegram.deleteMessage(chatId, messageId);
      return textResult(`Message ${messageId} deleted successfully from chat ${chatId}`);
    } catch (error) { return handleToolError(error, "delete-message", `Deleting message ${messageId} from chat ${chatId}`); }
  });

  server.registerTool("pin-chat-message", {
    ...toolMetadata("pin-chat-message"),
    description: "Pin a message in a chat. The bot must be an administrator with the 'can_pin_messages' right in groups and channels.",
    inputSchema: {
      chatId: chatIdSchema,
      messageId: z.number().describe("Identifier of the message to pin"),
      disableNotification: z.boolean().describe("True to pin silently, without sending a notification to all chat members").optional(),
    },
  }, async ({ chatId, messageId, disableNotification }) => {
    try {
      await bot.telegram.pinChatMessage(chatId, messageId, { disable_notification: disableNotification });
      return textResult(`Message ${messageId} pinned successfully in chat ${chatId}`);
    } catch (error) { return handleToolError(error, "pin-chat-message", `Pinning message ${messageId} in chat ${chatId}`); }
  });

  server.registerTool("unpin-chat-message", {
    ...toolMetadata("unpin-chat-message"),
    description: "Unpin a message in a chat. If no messageId is provided, the most recent pinned message is unpinned.",
    inputSchema: { chatId: chatIdSchema, messageId: z.number().describe("Identifier of the message to unpin. If omitted, the most recent pinned message is unpinned").optional() },
  }, async ({ chatId, messageId }) => {
    try {
      await bot.telegram.unpinChatMessage(chatId, messageId);
      return textResult(`Message unpinned successfully in chat ${chatId}`);
    } catch (error) { return handleToolError(error, "unpin-chat-message", `Unpinning message in chat ${chatId}`); }
  });

  server.registerTool("unpin-all-chat-messages", {
    ...toolMetadata("unpin-all-chat-messages"),
    description: "Unpin all pinned messages in a chat at once.",
    inputSchema: { chatId: chatIdSchema },
  }, async ({ chatId }) => {
    try {
      await bot.telegram.unpinAllChatMessages(chatId);
      return textResult(`All messages unpinned successfully in chat ${chatId}`);
    } catch (error) { return handleToolError(error, "unpin-all-chat-messages", `Unpinning all messages in chat ${chatId}`); }
  });
}
