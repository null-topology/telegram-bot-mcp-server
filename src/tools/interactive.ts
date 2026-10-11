import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Telegraf } from "telegraf";
import { z } from "zod";
import { handleToolError, messageResult } from "../utils";
import { chatIdSchema, sendOptions, sendSchema, toolMetadata } from "./common";

const sendBehavior = " Supports common send options and returns JSON message identifiers.";

export function registerInteractiveTools(server: McpServer, bot: Telegraf) {
  server.registerTool("send-poll", {
    ...toolMetadata("send-poll"),
    description: "Send a native poll or quiz to a chat. Supports anonymous polls, multiple answers, and quiz mode with a correct answer." + sendBehavior,
    inputSchema: {
      chatId: chatIdSchema,
      question: z.string().describe("Poll question, 1-300 characters"),
      options: z.array(z.string()).min(2).max(10).describe("List of 2-10 answer options, each 1-100 characters"),
      isAnonymous: z.boolean().describe("True if the poll needs to be anonymous. Defaults to true").optional(),
      allowsMultipleAnswers: z.boolean().describe("True if the poll allows multiple answers. Ignored for quiz polls. Defaults to false").optional(),
      type: z.enum(["regular", "quiz"]).describe("Poll type: 'regular' or 'quiz'. Defaults to 'regular'").optional(),
      correctOptionId: z.number().describe("0-based identifier of the correct answer option. Required for polls in quiz mode").optional(),
      ...sendSchema,
    },
  }, async (input) => {
    const { chatId, question, options, isAnonymous, allowsMultipleAnswers, type, correctOptionId } = input;
    try {
      const extra = { ...sendOptions(input), is_anonymous: isAnonymous, correct_option_id: correctOptionId };
      const response = type === "quiz"
        ? await bot.telegram.sendQuiz(chatId, question, options, extra)
        : await bot.telegram.sendPoll(chatId, question, options, { ...extra, allows_multiple_answers: allowsMultipleAnswers });
      return messageResult([response]);
    } catch (error) { return handleToolError(error, "send-poll", `Sending poll to chat ${chatId}`); }
  });

  server.registerTool("send-dice", {
    ...toolMetadata("send-dice"),
    description: "Send an animated emoji that displays a random value (dice, darts, basketball, football, bowling, or slot machine)." + sendBehavior,
    inputSchema: {
      chatId: chatIdSchema,
      emoji: z.enum(["\u{1F3B2}", "\u{1F3AF}", "\u{1F3C0}", "⚽", "\u{1F3B3}", "\u{1F3B0}"]).describe("Emoji on which the dice throw animation is based. Defaults to \u{1F3B2}").optional(),
      ...sendSchema,
    },
  }, async (input) => {
    try { return messageResult([await bot.telegram.sendDice(input.chatId, { ...sendOptions(input), emoji: input.emoji })]); }
    catch (error) { return handleToolError(error, "send-dice", `Sending dice to chat ${input.chatId}`); }
  });

  server.registerTool("send-location", {
    ...toolMetadata("send-location"),
    description: "Send a point on the map (latitude/longitude) to a chat." + sendBehavior,
    inputSchema: {
      chatId: chatIdSchema,
      latitude: z.number().describe("Latitude of the location"),
      longitude: z.number().describe("Longitude of the location"),
      ...sendSchema,
    },
  }, async (input) => {
    try { return messageResult([await bot.telegram.sendLocation(input.chatId, input.latitude, input.longitude, sendOptions(input))]); }
    catch (error) { return handleToolError(error, "send-location", `Sending location to chat ${input.chatId}`); }
  });

  server.registerTool("send-contact", {
    ...toolMetadata("send-contact"),
    description: "Send a phone contact to a chat." + sendBehavior,
    inputSchema: {
      chatId: chatIdSchema,
      phoneNumber: z.string().describe("Contact's phone number"),
      firstName: z.string().describe("Contact's first name"),
      lastName: z.string().describe("Contact's last name").optional(),
      ...sendSchema,
    },
  }, async (input) => {
    try {
      return messageResult([await bot.telegram.sendContact(input.chatId, input.phoneNumber, input.firstName, { ...sendOptions(input), last_name: input.lastName })]);
    } catch (error) { return handleToolError(error, "send-contact", `Sending contact to chat ${input.chatId}`); }
  });
}
