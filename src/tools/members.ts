import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Telegraf } from "telegraf";
import { z } from "zod";
import { handleToolError, textResult } from "../utils";
import { chatIdSchema, toolMetadata, userIdSchema } from "./common";

export function registerMemberTools(server: McpServer, bot: Telegraf) {
  server.registerTool("kick-chat-member", {
    ...toolMetadata("kick-chat-member"),
    description: "Kick a user from a group, a supergroup or a channel. Provides detailed error information if the operation fails.",
    inputSchema: { chatId: chatIdSchema, userId: userIdSchema },
  }, async ({ chatId, userId }) => {
    try {
      await bot.telegram.banChatMember(chatId, userId);
      return textResult(`User ${userId} banned from chat ${chatId} successfully`);
    } catch (error) { return handleToolError(error, "kick-chat-member", `Banning user ${userId} from chat ${chatId}`); }
  });

  server.registerTool("un-ban-chat-member", {
    ...toolMetadata("un-ban-chat-member"),
    description: "Use this method to unban a previously banned user in a supergroup or channel. The user will not return to the group or channel automatically. Provides detailed error information if the operation fails.",
    inputSchema: { chatId: chatIdSchema, userId: userIdSchema },
  }, async ({ chatId, userId }) => {
    try {
      await bot.telegram.unbanChatMember(chatId, userId, { only_if_banned: true });
      return textResult(`User ${userId} unbanned from chat ${chatId} successfully`);
    } catch (error) { return handleToolError(error, "un-ban-chat-member", `Unbanning user ${userId} from chat ${chatId}`); }
  });

  server.registerTool("get-chat-member-count", {
    ...toolMetadata("get-chat-member-count"),
    description: "Use this method to get the number of members in a chat",
    inputSchema: { chatId: chatIdSchema },
  }, async ({ chatId }) => {
    try { return textResult(JSON.stringify(await bot.telegram.getChatMembersCount(chatId))); }
    catch (error) { return handleToolError(error, "get-chat-member-count", `Getting member count for chat ${chatId}`); }
  });

  server.registerTool("get-chat-member", {
    ...toolMetadata("get-chat-member"),
    description: "get information about a member of a chat",
    inputSchema: { chatId: chatIdSchema, userId: userIdSchema },
  }, async ({ chatId, userId }) => {
    try { return textResult(JSON.stringify(await bot.telegram.getChatMember(chatId, userId))); }
    catch (error) { return handleToolError(error, "get-chat-member", `Getting member ${userId} info from chat ${chatId}`); }
  });

  server.registerTool("restrict-chat-member", {
    ...toolMetadata("restrict-chat-member"),
    description: "Restrict a user in a supergroup (mute or limit what they can send). The bot must be an administrator with the appropriate rights. Pass all permissions as true to lift restrictions.",
    inputSchema: {
      chatId: z.string().describe("Unique identifier for the target supergroup"),
      userId: userIdSchema,
      canSendMessages: z.boolean().describe("True if the user is allowed to send text messages, contacts, locations and venues").optional(),
      canSendMedia: z.boolean().describe("True if the user is allowed to send photos, videos, audios and documents").optional(),
      canSendPolls: z.boolean().describe("True if the user is allowed to send polls").optional(),
      canSendOtherMessages: z.boolean().describe("True if the user is allowed to send animations, games, stickers and use inline bots").optional(),
      untilDate: z.number().describe("Date when restrictions will be lifted, as a unix timestamp. If the user is restricted for more than 366 days or less than 30 seconds from the current time, they are considered restricted forever").optional(),
    },
  }, async ({ chatId, userId, canSendMessages, canSendMedia, canSendPolls, canSendOtherMessages, untilDate }) => {
    try {
      await bot.telegram.restrictChatMember(chatId, userId, {
        permissions: {
          can_send_messages: canSendMessages ?? false,
          can_send_photos: canSendMedia ?? false,
          can_send_videos: canSendMedia ?? false,
          can_send_audios: canSendMedia ?? false,
          can_send_documents: canSendMedia ?? false,
          can_send_voice_notes: canSendMedia ?? false,
          can_send_video_notes: canSendMedia ?? false,
          can_send_polls: canSendPolls ?? false,
          can_send_other_messages: canSendOtherMessages ?? false,
          can_add_web_page_previews: canSendMessages ?? false,
        },
        until_date: untilDate,
      });
      return textResult(`User ${userId} restricted successfully in chat ${chatId}`);
    } catch (error) { return handleToolError(error, "restrict-chat-member", `Restricting user ${userId} in chat ${chatId}`); }
  });

  server.registerTool("promote-chat-member", {
    ...toolMetadata("promote-chat-member"),
    description: "Promote a user to administrator in a supergroup or channel, or demote them by passing all rights as false. The bot must be an administrator with the appropriate rights.",
    inputSchema: {
      chatId: chatIdSchema,
      userId: userIdSchema,
      canManageChat: z.boolean().describe("True if the administrator can access the chat event log, boost list, and see hidden members").optional(),
      canDeleteMessages: z.boolean().describe("True if the administrator can delete messages of other users").optional(),
      canRestrictMembers: z.boolean().describe("True if the administrator can restrict, ban or unban chat members").optional(),
      canPromoteMembers: z.boolean().describe("True if the administrator can add new administrators").optional(),
      canChangeInfo: z.boolean().describe("True if the administrator can change chat title, photo and other settings").optional(),
      canInviteUsers: z.boolean().describe("True if the administrator can invite new users to the chat").optional(),
      canPinMessages: z.boolean().describe("True if the administrator can pin messages (supergroups only)").optional(),
    },
  }, async ({ chatId, userId, canManageChat, canDeleteMessages, canRestrictMembers, canPromoteMembers, canChangeInfo, canInviteUsers, canPinMessages }) => {
    try {
      await bot.telegram.promoteChatMember(chatId, userId, {
        can_manage_chat: canManageChat,
        can_delete_messages: canDeleteMessages,
        can_restrict_members: canRestrictMembers,
        can_promote_members: canPromoteMembers,
        can_change_info: canChangeInfo,
        can_invite_users: canInviteUsers,
        can_pin_messages: canPinMessages,
      });
      return textResult(`User ${userId} promoted successfully in chat ${chatId}`);
    } catch (error) { return handleToolError(error, "promote-chat-member", `Promoting user ${userId} in chat ${chatId}`); }
  });
}
