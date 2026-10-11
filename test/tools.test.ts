import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Telegraf } from "telegraf";
import { registerAllTools } from "../src/tools";
import { createServer, packageInfo, startServer } from "../src/server";
import { messageResult, splitMessage, sendLongMessage } from "../src/utils";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const readOnly = ["get-me", "get-chat", "get-chat-member-count", "get-chat-member", "get-my-short-description", "get-my-commands", "get-my-name", "get-my-description", "get-chat-administrators", "get-user-profile-photos", "get-file"];
const destructive = ["delete-message", "kick-chat-member", "un-ban-chat-member", "restrict-chat-member", "promote-chat-member", "leave-chat", "revoke-chat-invite-link", "export-chat-invite-link", "unpin-all-chat-messages"];
const names = ["get-me", "send-message", "send-photo", "kick-chat-member", "un-ban-chat-member", "get-chat", "get-chat-member-count", "get-chat-member", "set-my-short-description", "get-my-short-description", "set-my-commands", "get-my-commands", "set-my-name", "get-my-name", "set-my-description", "get-my-description", "send-document", "send-video", "send-audio", "send-voice", "send-animation", "send-sticker", "send-poll", "send-dice", "send-location", "send-contact", "send-chat-action", "forward-message", "copy-message", "edit-message-text", "delete-message", "pin-chat-message", "unpin-chat-message", "unpin-all-chat-messages", "set-chat-title", "set-chat-description", "get-chat-administrators", "restrict-chat-member", "promote-chat-member", "create-chat-invite-link", "revoke-chat-invite-link", "export-chat-invite-link", "leave-chat", "get-user-profile-photos", "get-file", "send-video-note", "send-media-group", "edit-message-caption", "set-message-reaction", "download-file"];
const common = { replyToMessageId: 7, messageThreadId: 9, disableNotification: true, protectContent: true };
const extra = { reply_parameters: { message_id: 7, allow_sending_without_reply: true }, message_thread_id: 9, disable_notification: true, protect_content: true };
const file = { file_id: "file", file_unique_id: "unique" };
const mediaCases = [
  ["send-photo", "sendPhoto", "photo", "text"],
  ["send-document", "sendDocument", "document", "caption"],
  ["send-video", "sendVideo", "video", "caption"],
  ["send-audio", "sendAudio", "audio", "caption"],
  ["send-voice", "sendVoice", "voice", "caption"],
  ["send-animation", "sendAnimation", "animation", "caption"],
] as const;
const sendCases = [
  ["send-sticker", "sendSticker", { media: "file" }],
  ["send-poll", "sendPoll", { question: "Question?", options: ["A", "B"] }],
  ["send-poll", "sendQuiz", { question: "Question?", options: ["A", "B"], type: "quiz", correctOptionId: 1 }],
  ["send-dice", "sendDice", {}],
  ["send-location", "sendLocation", { latitude: 1, longitude: 2 }],
  ["send-contact", "sendContact", { phoneNumber: "123", firstName: "Test" }],
] as const;

let server: McpServer;
let client: Client;
let api: Record<string, ReturnType<typeof vi.fn>>;
let nextId: number;
function message(additions = {}) {
  return { chat: { id: 123 }, message_id: nextId++, date: 1000, ...additions };
}
async function call(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}
function json(result: Awaited<ReturnType<typeof call>>) {
  const content = result.content as { type: string; text: string }[];
  expect(content[0].type).toBe("text");
  return JSON.parse(content[0].text);
}
function text(result: Awaited<ReturnType<typeof call>>) {
  return (result.content as { text: string }[])[0].text;
}
// The subprocess test runs the compiled CLI, which only exists after a build.
function requireBuild(path: string) {
  if (!existsSync(path)) throw new Error(`${path} is missing; run yarn build first`);
  return path;
}

beforeEach(async () => {
  nextId = 1;
  api = {};
  for (const method of ["sendMessage", "sendPhoto", "sendDocument", "sendVideo", "sendAudio", "sendVoice", "sendAnimation", "sendSticker", "sendPoll", "sendQuiz", "sendDice", "sendLocation", "sendContact", "forwardMessage", "editMessageText"]) {
    api[method] = vi.fn(async () => message());
  }
  for (const [, method, field] of mediaCases) {
    api[method] = vi.fn(async () => message({ [field]: field === "photo" ? [{ ...file, width: 100, height: 100 }, { file_id: "small", file_unique_id: "small-unique", width: 1, height: 1 }] : file }));
  }
  api.sendSticker = vi.fn(async () => message({ sticker: file }));
  api.copyMessage = vi.fn(async () => ({ message_id: nextId++ }));
  api.sendChatAction = vi.fn(async () => true);
  api.getMe = vi.fn(async () => ({ id: 55, username: "test_bot", can_join_groups: true, can_read_all_group_messages: false }));
  server = new McpServer({ name: "test", version: "1" });
  registerAllTools(server, { telegram: api } as unknown as Telegraf);
  client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});
afterEach(async () => {
  await client.close();
  await server.close();
  vi.restoreAllMocks();
});

it("returns file metadata without a token or download URL", async () => {
  const token = "123456:fake_token";
  const metadata = { ...file, file_size: 10, file_path: "documents/file.bin" };
  api.getFile = vi.fn(async () => metadata);
  api.getFileLink = vi.fn(async () => new URL(`https://api.telegram.org/file/bot${token}/documents/file.bin`));
  const result = await call("get-file", { fileId: "file" });
  expect(json(result)).toEqual(metadata);
  expect(JSON.stringify(result)).not.toContain(token);
  expect(JSON.stringify(result)).not.toContain("download_link");
  expect(api.getFileLink).not.toHaveBeenCalled();
  const tool = (await client.listTools()).tools.find(tool => tool.name === "get-file");
  expect(tool?.description).toContain("The result contains no download URL.");
});

it("does not split a surrogate pair at the caption boundary", async () => {
  const caption = "x".repeat(1023) + "\u{1F600}" + "tail";
  const result = json(await call("send-photo", { chatId: "123", media: "file", text: caption }));
  const sentCaption = api.sendPhoto.mock.calls[0][2].caption as string;
  const overflow = api.sendMessage.mock.calls[0][1] as string;
  expect(sentCaption).toHaveLength(1023);
  expect(sentCaption.isWellFormed()).toBe(true);
  expect(overflow.isWellFormed()).toBe(true);
  expect(sentCaption + overflow).toBe(caption);
  expect(result.message_ids).toEqual([1, 2]);
});

it("keeps surrogate pairs intact in long spaceless text", async () => {
  const text = "\u{1F600}".repeat(5000);
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    expect(chunk.isWellFormed()).toBe(true);
    expect(chunk.length).toBeLessThanOrEqual(4096);
  }
  expect(chunks.map(chunk => chunk.replace(/\.\.\.$/, "")).join("")).toBe(text);
  await call("send-message", { chatId: "123", text });
  for (const [, part] of api.sendMessage.mock.calls) {
    expect(part.isWellFormed()).toBe(true);
    expect(part.length).toBeLessThanOrEqual(4096);
  }
});

it("skips a whitespace-only caption remainder", async () => {
  const result = json(await call("send-photo", { chatId: "123", media: "file", text: "x".repeat(1024) + "\n" }));
  expect(api.sendPhoto).toHaveBeenCalledTimes(1);
  expect(api.sendMessage).not.toHaveBeenCalled();
  expect(result.message_ids).toEqual([1]);
});

it("skips whitespace-only text parts", async () => {
  expect(await sendLongMessage({ telegram: api } as unknown as Telegraf, "123", " \n\t ")).toEqual([]);
  expect(api.sendMessage).not.toHaveBeenCalled();
});

it.each(["", "   ", "\n\n"])("rejects empty send-message text %j without calling Telegram", async (input) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await call("send-message", { chatId: "123", text: input });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("Message text is empty or whitespace-only; nothing was sent");
  expect(text(result)).not.toContain("TypeError");
  expect(text(result)).not.toContain("Cannot read properties");
  for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled();
});

it("returns an error result for an empty message list", () => {
  const result = messageResult([]);
  expect(result.isError).toBe(true);
  expect((result.content as { text: string }[])[0].text).toContain("No message was sent");
});

it.each([1, 2, 3, 4, 5])("splits long words into whole code points with maxLength %i", (maxLength) => {
  for (const word of ["\u{1F600}".repeat(7), "abcdefghij"]) {
    const chunks = splitMessage(word, maxLength);
    for (const chunk of chunks) expect(chunk.isWellFormed()).toBe(true);
    expect(chunks.map(chunk => chunk.replace(/\.\.\.$/, "")).join("")).toBe(word);
  }
});

it("reports delivered identifiers when the second text part fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  api.sendMessage.mockImplementationOnce(async () => message()).mockRejectedValue({ response: { error_code: 429, description: "Rate limited", parameters: { retry_after: 12 } } });
  const result = await call("send-message", { chatId: "123", text: "x".repeat(9000) });
  expect(result.isError).toBe(true);
  expect(api.sendMessage).toHaveBeenCalledTimes(2);
  const text = (result.content as { text: string }[])[0].text;
  expect(text).toContain("error_code: 429");
  expect(text).toContain("description: Rate limited");
  expect(text).toContain("retry_after: 12");
  expect(text).toContain("Delivered 1 part");
  expect(text).toContain("message_ids: [1]");
});

it("omits the delivery summary when the first text part fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  api.sendMessage.mockRejectedValue({ response: { error_code: 400, description: "Mock failure" } });
  const result = await call("send-message", { chatId: "123", text: "Hello" });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("description: Mock failure");
  expect(text(result)).toContain("Context: Sending message to chat 123");
  expect(text(result)).not.toContain("Delivered");
  expect(text(result)).not.toContain("message_ids");
  expect(text(result)).not.toContain("media was delivered");
});

it("prints error_code only for errors that carry a code", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const local = await call("send-document", { chatId: "123", media: "./a.pdf" });
  expect(local.isError).toBe(true);
  expect(text(local)).toContain("description: Local paths must be absolute");
  expect(text(local)).not.toContain("error_code");
  api.sendMessage.mockRejectedValue({ response: { error_code: 400, description: "Mock failure" } });
  const remote = await call("send-message", { chatId: "123", text: "Hello" });
  expect(text(remote)).toContain("error_code: 400\ndescription: Mock failure");
});

it.each([0, 1])("reports media and delivered identifiers when caption overflow fails after %i text parts", async (delivered) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  api.sendMessage.mockRejectedValue({ response: { error_code: 400, description: "Mock failure" } });
  if (delivered) api.sendMessage.mockImplementationOnce(async () => message());
  const result = await call("send-photo", { chatId: "123", media: "file", text: "x".repeat(10000) });
  expect(result.isError).toBe(true);
  const text = (result.content as { text: string }[])[0].text;
  expect(text).toContain("description: Mock failure");
  expect(text).toContain(`Delivered ${delivered + 1} part`);
  expect(text).toContain(`message_ids: ${JSON.stringify(delivered ? [1, 2] : [1])}`);
  expect(text).toContain("media was delivered");
});

it("returns the dice emoji and rolled value", async () => {
  const dice = { emoji: "\u{1F3B2}", value: 6 };
  api.sendDice.mockImplementation(async () => message({ dice }));
  expect(json(await call("send-dice", { chatId: "123" }))).toEqual({ chat_id: 123, message_id: 1, message_ids: [1], date: 1000, dice });
});

it("reports the largest photo size when sizes are listed in ascending order", async () => {
  api.sendPhoto.mockImplementation(async () => message({ photo: [
    { file_id: "small", file_unique_id: "small-unique", width: 90, height: 90 },
    { file_id: "medium", file_unique_id: "medium-unique", width: 320, height: 320 },
    { ...file, width: 1280, height: 1280 },
  ] }));
  expect(json(await call("send-photo", { chatId: "123", media: "file", text: "Caption" }))).toMatchObject(file);
});

it("omits parse mode for plain captions and edited text", async () => {
  await call("send-photo", { chatId: "123", media: "file", text: "Caption", parseMode: "none" });
  expect(api.sendPhoto.mock.calls[0][2]).not.toHaveProperty("parse_mode");
  await call("edit-message-text", { chatId: "123", messageId: 4, text: "Edited", parseMode: "none" });
  expect(api.editMessageText.mock.calls[0][4]).not.toHaveProperty("parse_mode");
});

it("exits immediately with code 1 when startup fails", async () => {
  const previousExitCode = process.exitCode;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(StdioServerTransport.prototype, "start").mockRejectedValue(new Error("Startup failure"));
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("Exit intercepted"); });
  try {
    await expect(startServer("123456:fake_token")).rejects.toThrow("Exit intercepted");
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

it("asks for a build when the compiled CLI is missing", () => {
  const missing = join(tmpdir(), `missing-build-${process.pid}-${Date.now()}`, "cli.js");
  expect(() => requireBuild(missing)).toThrow("is missing; run yarn build first");
});

it("keeps every stdio stdout line valid JSON-RPC during initialization", async () => {
  const child = spawn(process.execPath, [requireBuild(fileURLToPath(new URL("../.build/cli.js", import.meta.url)))], {
    env: { ...process.env, TELEGRAM_BOT_API_TOKEN: "123456:fake_token" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let pending = "";
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let timeout: ReturnType<typeof setTimeout>;
  try {
    const initialized = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Initialization timed out: ${stderr}`)), 5000);
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Child exited before initialization (${code}): ${stderr}`)));
      child.stderr.on("data", data => { stderr += data.toString(); });
      child.stdout.on("data", data => {
        stdout += data.toString();
        pending += data.toString();
        const lines = pending.split("\n");
        pending = lines.pop()!;
        try {
          for (const line of lines) {
            const response = JSON.parse(line);
            if (response.id === 1 && response.result) resolve();
            else if (response.id === 1 && response.error) reject(new Error(JSON.stringify(response.error)));
          }
        } catch (error) { reject(error); }
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n");
    await initialized;
  } finally {
    clearTimeout(timeout!);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
  const responses = stdout.trim().split("\n").map(line => JSON.parse(line));
  for (const response of responses) expect(response.jsonrpc).toBe("2.0");
  expect(responses.find(response => response.id === 1)?.result.serverInfo).toEqual({ name: "telegram_bot", version: "2.0.0" });
}, 10000);

describe("tool registration", () => {
  it("pins all 50 tool names, descriptions and input keys", async () => {
    const { tools } = await client.listTools();
    const contract = tools.sort((a, b) => a.name.localeCompare(b.name)).map(tool => JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputKeys: Object.keys(tool.inputSchema.properties ?? {}).sort(),
    })).join("\n") + "\n";
    const snapshot = fileURLToPath(new URL("./__snapshots__/tools.contract.snap", import.meta.url));
    expect(existsSync(snapshot)).toBe(true);
    await expect(contract).toMatchFileSnapshot(snapshot);
  });
  it("registers exactly 50 tools with explicit annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([...names].sort());
    expect(tools).toHaveLength(50);
    for (const tool of tools) {
      expect(tool.title).toEqual(expect.any(String));
      expect(tool.annotations).toMatchObject({ readOnlyHint: readOnly.includes(tool.name), destructiveHint: destructive.includes(tool.name), openWorldHint: true });
    }
  });
  it("publishes new option descriptions and keeps the options optional", async () => {
    const { tools } = await client.listTools();
    const optionNames = ["replyToMessageId", "messageThreadId", "disableNotification", "protectContent", "parseMode", "disableLinkPreview"];
    for (const tool of tools) {
      const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
      for (const option of optionNames) {
        if (!(option in properties)) continue;
        expect(properties[option].description).toEqual(expect.any(String));
        expect(tool.inputSchema.required ?? []).not.toContain(option);
      }
    }
  });
  it("returns full bot information", async () => {
    expect(json(await call("get-me"))).toEqual(await api.getMe());
  });
});

it("passes common text options and returns JSON message identifiers", async () => {
  const result = await call("send-message", { chatId: "123", text: "Hello", ...common, parseMode: "HTML", disableLinkPreview: true });
  expect(api.sendMessage).toHaveBeenCalledWith("123", "Hello", { ...extra, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  expect(json(result)).toEqual({ chat_id: 123, message_id: 1, message_ids: [1], date: 1000 });
});
it("omits parse mode and link preview options when disabled or absent", async () => {
  await call("send-message", { chatId: "123", text: "Plain", parseMode: "none", disableLinkPreview: false });
  expect(api.sendMessage.mock.calls[0][2]).not.toHaveProperty("parse_mode");
  expect(api.sendMessage.mock.calls[0][2]).not.toHaveProperty("link_preview_options");
});
it.each(["word ".repeat(2000), "x".repeat(9000), "paragraph\n\n".repeat(1000), "sentence. ".repeat(1000), "x".repeat(4096 * 9)])("splits long text within 4096 including footers and keeps options", async (text) => {
  const result = json(await call("send-message", { chatId: "123", text, ...common, parseMode: "MarkdownV2" }));
  expect(api.sendMessage.mock.calls.length).toBeGreaterThan(1);
  for (const [, part, options] of api.sendMessage.mock.calls) {
    expect(part.length).toBeLessThanOrEqual(4096);
    expect(options).toEqual({ ...extra, parse_mode: "MarkdownV2" });
  }
  expect(result.message_ids).toEqual(api.sendMessage.mock.results.map((_, i) => i + 1));
  expect(result.message_id).toBe(1);
});
it.each(mediaCases)("%s passes caption options and returns file identifiers", async (name, method, _field, captionInput) => {
  const result = await call(name, { chatId: "123", media: "file", [captionInput]: "Caption", ...common, parseMode: "HTML" });
  expect(api[method]).toHaveBeenCalledWith("123", "file", { ...extra, caption: "Caption", parse_mode: "HTML" });
  expect(json(result)).toEqual({ chat_id: 123, message_id: 1, message_ids: [1], date: 1000, ...file });
});
it.each(mediaCases)("%s overflows captions at 1024 and retains options on follow-up text", async (name, method, _field, captionInput) => {
  const caption = "x".repeat(1025);
  const result = json(await call(name, { chatId: "123", media: "file", [captionInput]: caption, ...common, parseMode: "HTML" }));
  expect(api[method].mock.calls[0][2]).toEqual({ ...extra, caption: caption.slice(0, 1024), parse_mode: "HTML" });
  expect(api.sendMessage).toHaveBeenCalledWith("123", "x", { ...extra, parse_mode: "HTML" });
  expect(result.message_ids).toEqual([1, 2]);
  expect(result.file_id).toBe("file");
});
it("keeps a 1024-character caption on the media without follow-ups", async () => {
  await call("send-photo", { chatId: "123", media: "file", text: "x".repeat(1024) });
  expect(api.sendMessage).not.toHaveBeenCalled();
});
it.each(sendCases)("%s passes common options and returns message identifiers (%s)", async (name, method, inputs) => {
  const result = json(await call(name, { chatId: "123", ...inputs, ...common }));
  expect(api[method].mock.calls[0].at(-1)).toMatchObject(extra);
  expect(result).toMatchObject({ chat_id: 123, message_id: 1, message_ids: [1], date: 1000 });
  if (name === "send-sticker") expect(result).toMatchObject(file);
});
it("passes forward options without reply parameters", async () => {
  const result = json(await call("forward-message", { chatId: "123", fromChatId: "456", messageId: 4, messageThreadId: 9, disableNotification: true, protectContent: true }));
  expect(api.forwardMessage).toHaveBeenCalledWith("123", "456", 4, { message_thread_id: 9, disable_notification: true, protect_content: true });
  expect(api.forwardMessage.mock.calls[0][3]).not.toHaveProperty("reply_parameters");
  expect(result).toEqual({ chat_id: 123, message_id: 1, message_ids: [1], date: 1000 });
});
it("copies with caption overflow and a null date", async () => {
  const result = json(await call("copy-message", { chatId: "123", fromChatId: "456", messageId: 4, caption: "x".repeat(1025), ...common, parseMode: "HTML" }));
  expect(api.copyMessage).toHaveBeenCalledWith("123", "456", 4, { ...extra, caption: "x".repeat(1024), parse_mode: "HTML" });
  expect(result).toEqual({ chat_id: "123", message_id: 1, message_ids: [1, 2], date: null });
  expect(api.sendMessage.mock.calls[0][2]).toEqual({ ...extra, parse_mode: "HTML" });
});
it("passes the thread to chat actions", async () => {
  await call("send-chat-action", { chatId: "123", action: "typing", messageThreadId: 9 });
  expect(api.sendChatAction).toHaveBeenCalledWith("123", "typing", { message_thread_id: 9 });
});
it("edits text with formatting and preview options", async () => {
  const result = json(await call("edit-message-text", { chatId: "123", messageId: 4, text: "Edited", parseMode: "HTML", disableLinkPreview: true }));
  expect(api.editMessageText).toHaveBeenCalledWith("123", 4, undefined, "Edited", { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  expect(result).toEqual({ chat_id: 123, message_id: 1, message_ids: [1], date: 1000 });
});
it("handles the true edit response", async () => {
  api.editMessageText.mockResolvedValue(true);
  expect(json(await call("edit-message-text", { chatId: "123", messageId: 4, text: "Edited" }))).toEqual({ chat_id: "123", message_id: 4, edited: true });
});
const methods: Record<string, string> = {
  "kick-chat-member": "banChatMember",
  "un-ban-chat-member": "unbanChatMember",
  "get-chat-member-count": "getChatMembersCount",
  // download-file calls getFile through callApi so its deadline can abort the request.
  "download-file": "callApi",
};
const failureArgs: Record<string, Record<string, unknown>> = {
  "send-media-group": { media: [{ type: "photo", media: "file" }, { type: "video", media: "file" }] },
};
it.each(names)("%s reports API failures rather than success", async (name) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const method = methods[name] ?? name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  api[method] = vi.fn().mockRejectedValue({ response: { error_code: 429, description: "Rate limited", parameters: { retry_after: 12 } } });
  // download-file refuses before calling Telegram unless a download directory is configured.
  const downloads = mkdtempSync(join(tmpdir(), "telegram-failure-test-"));
  vi.stubEnv("TELEGRAM_DOWNLOAD_DIR", downloads);
  let result;
  try {
    result = await call(name, {
      chatId: "123", userId: 1, text: "Text", media: "file", fromChatId: "456", messageId: 4,
      short_description: "Short", commands: [{ command: "start", description: "Start" }],
      name: "Name", description: "Description", title: "Title", inviteLink: "https://example.com/invite",
      fileId: "file", action: "typing", question: "Question?", options: ["A", "B"],
      latitude: 1, longitude: 2, phoneNumber: "123", firstName: "Test",
      videoNote: "file", caption: "Caption", ...failureArgs[name],
    });
  } finally {
    vi.unstubAllEnvs();
    rmSync(downloads, { recursive: true, force: true });
  }
  expect(api[method]).toHaveBeenCalled();
  expect(result.isError).toBe(true);
  expect((result.content as { text: string }[])[0].text).toContain("description: Rate limited");
  expect((result.content as { text: string }[])[0].text).toContain("retry_after: 12");
});

it("splits large caption overflow within limits and delays every follow-up", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const caption = "x".repeat(12000);
  const result = json(await call("send-document", { chatId: "123", media: "file", caption, ...common, parseMode: "MarkdownV2" }));
  expect(api.sendDocument.mock.calls[0][2].caption.length).toBe(1024);
  for (const [, text, options] of api.sendMessage.mock.calls) {
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(options).toEqual({ ...extra, parse_mode: "MarkdownV2" });
  }
  expect(result.message_ids).toEqual([1, 2, 3, 4]);
  expect(timers.mock.calls.filter(([, delay]) => delay === 100)).toHaveLength(3);
});

it("leaves exactly 4096 characters unsplit", async () => {
  await call("send-message", { chatId: "123", text: "x".repeat(4096) });
  expect(api.sendMessage).toHaveBeenCalledTimes(1);
  expect(api.sendMessage.mock.calls[0][1]).toHaveLength(4096);
});

it("builds the shared server with package metadata", async () => {
  const sharedServer = createServer({ telegram: api } as unknown as Telegraf);
  const sharedClient = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([sharedServer.connect(serverTransport), sharedClient.connect(clientTransport)]);
    expect(sharedClient.getServerVersion()).toEqual({ name: "telegram_bot", version: "2.0.0" });
    expect(Object.keys(sharedClient.getServerCapabilities() ?? {})).toEqual(["tools"]);
    expect(sharedClient.getServerCapabilities()).not.toHaveProperty("resources");
    expect(packageInfo.name).toBe("@null-topology/telegram-bot-mcp-server");
    expect((await sharedClient.listTools()).tools).toHaveLength(50);
  } finally {
    await sharedClient.close();
    await sharedServer.close();
  }
});
it.each([400, 429])("marks Telegram %i failures as errors with details", async (code) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  api.sendMessage.mockRejectedValue({ response: { error_code: code, description: "Mock failure", parameters: { retry_after: 12 } } });
  const result = await call("send-message", { chatId: "123", text: "Hello" });
  expect(result.isError).toBe(true);
  const text = (result.content as { text: string }[])[0].text;
  expect(text).toContain(`error_code: ${code}`);
  expect(text).toContain("description: Mock failure");
  if (code === 429) expect(text).toContain("retry_after: 12");
});
