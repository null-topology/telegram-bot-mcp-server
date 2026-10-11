import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Telegraf } from "telegraf";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { registerAllTools } from "../src/tools";
import type { ToolOptions } from "../src/tools/common";
import { PHOTO_UPLOAD_LIMIT, UPLOAD_LIMIT, UploadBatch } from "../src/uploads";
import { isOggOpus as isOggOpusHeader, runFfmpeg, type FfmpegRunner } from "../src/voice";

async function readAll(stream: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
/** Resolves media through an upload batch and reads a local upload back as { content, filename }. */
async function resolveMediaInput(media: string, limit: number, filename?: string) {
  const uploads = new UploadBatch();
  try {
    const value = await uploads.resolve(media, limit, filename);
    if (typeof value === "string") return value;
    return { content: (await readAll(value.source)).toString(), filename: value.filename };
  } finally {
    await uploads.close();
  }
}
async function isOggOpus(path: string): Promise<boolean> {
  return isOggOpusHeader(readFileSync(path));
}

const common = { replyToMessageId: 7, messageThreadId: 9, disableNotification: true, protectContent: true };
const extra = { reply_parameters: { message_id: 7, allow_sending_without_reply: true }, message_thread_id: 9, disable_notification: true, protect_content: true };
const file = { file_id: "file", file_unique_id: "unique" };
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
// Root ignores directory permissions, so the unreadable-directory cases cannot be set up as root.
const runsAsRoot = process.getuid?.() === 0;

/** Runs check while target (a file or directory) has mode 000, then restores its previous mode. */
async function whileUnreadable(target: string, check: () => Promise<void>) {
  const mode = statSync(target).mode & 0o7777;
  chmodSync(target, 0o000);
  try {
    await check();
  } finally {
    chmodSync(target, mode);
  }
}

/** A single Ogg page whose first packet is the given bytes. */
function oggPage(packet: Buffer) {
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "latin1");
  header[5] = 2;
  header[26] = 1;
  return Buffer.concat([header, Buffer.from([packet.length]), packet]);
}
const opusFile = oggPage(Buffer.concat([Buffer.from("OpusHead", "latin1"), Buffer.from([1, 1, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0])]));
const vorbisFile = oggPage(Buffer.concat([Buffer.from("\x01vorbis", "latin1"), Buffer.alloc(23)]));

/** Half a second of a 440 Hz tone as 16-bit mono PCM WAV. */
function wav(rate = 8000, seconds = 0.5) {
  const samples = Math.round(rate * seconds);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8, "latin1");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "latin1");
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return buffer;
}

let work: string;
let api: Record<string, ReturnType<typeof vi.fn>>;
let ffmpeg: ReturnType<typeof vi.fn<FfmpegRunner>>;
let client: Client;
let nextId: number;
const connections: { client: Client; server: McpServer }[] = [];

function message(additions = {}) {
  return { chat: { id: 123 }, message_id: nextId++, date: 1000, ...additions };
}
function put(relative: string, content: string | Buffer = "data") {
  const path = join(work, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}
async function connect(options: ToolOptions) {
  const server = new McpServer({ name: "test", version: "1" });
  registerAllTools(server, { telegram: api } as unknown as Telegraf, options);
  const connected = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), connected.connect(clientTransport)]);
  connections.push({ client: connected, server });
  return connected;
}
async function call(name: string, args: Record<string, unknown>, through = client) {
  return through.callTool({ name, arguments: args });
}
function text(result: Awaited<ReturnType<typeof call>>) {
  return (result.content as { text: string }[])[0].text;
}
function json(result: Awaited<ReturnType<typeof call>>) {
  expect(result.isError).toBeFalsy();
  return JSON.parse(text(result));
}
function voiceTempDirs() {
  return readdirSync(tmpdir()).filter(name => name.startsWith("telegram-voice-"));
}

beforeEach(async () => {
  nextId = 1;
  work = realpathSync(mkdtempSync(join(tmpdir(), "telegram-media-test-")));
  vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", work);
  vi.spyOn(console, "error").mockImplementation(() => {});
  api = {
    sendMessage: vi.fn(async () => message()),
    sendPhoto: vi.fn(async () => message({ photo: [{ ...file, width: 10, height: 10 }] })),
    sendDocument: vi.fn(async () => message({ document: file })),
    sendVoice: vi.fn(async () => message({ voice: file })),
    sendVideo: vi.fn(async () => message({ video: file })),
    sendAudio: vi.fn(async () => message({ audio: file })),
    sendAnimation: vi.fn(async () => message({ animation: file })),
    sendSticker: vi.fn(async () => message({ sticker: file })),
    sendVideoNote: vi.fn(async () => message({ video_note: { ...file, length: 240, duration: 3 } })),
    sendMediaGroup: vi.fn(async (_chatId: string, media: { type: string }[]) => media.map((item, i) => message(item.type === "photo"
      ? { photo: [{ file_id: `small-${i}`, file_unique_id: `small-unique-${i}`, width: 1, height: 1 }, { file_id: `photo-${i}`, file_unique_id: `photo-unique-${i}`, width: 90, height: 90 }] }
      : { [item.type]: { file_id: `${item.type}-${i}`, file_unique_id: `${item.type}-unique-${i}` } }))),
    editMessageCaption: vi.fn(async () => message({ caption: "New", edit_date: 1001, photo: [{ ...file, width: 1, height: 1 }] })),
    setMessageReaction: vi.fn(async () => true),
  };
  // The fake converter writes a valid OGG/Opus header to the requested output path.
  ffmpeg = vi.fn<FfmpegRunner>(async (args) => { writeFileSync(args[args.length - 1], opusFile); });
  client = await connect({ runFfmpeg: ffmpeg });
});
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

describe("local media path guard", () => {
  it("accepts a file inside a root and uploads its realpath with the filename", async () => {
    const path = put("outbox/photo.jpg");
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    expect(await resolveMediaInput(path, PHOTO_UPLOAD_LIMIT)).toEqual({ content: "data", filename: "photo.jpg" });
    expect(await resolveMediaInput(path, PHOTO_UPLOAD_LIMIT, "renamed.jpg")).toEqual({ content: "data", filename: "renamed.jpg" });
  });
  it("accepts any of several roots, including one reached through a symlink", async () => {
    const path = put("outbox/photo.jpg");
    mkdirSync(join(work, "other"));
    symlinkSync(join(work, "outbox"), join(work, "linked-outbox"));
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", [join(work, "other"), join(work, "linked-outbox")].join(delimiter));
    expect(await resolveMediaInput(join(work, "linked-outbox", "photo.jpg"), UPLOAD_LIMIT)).toEqual({ content: "data", filename: "photo.jpg" });
    expect(await resolveMediaInput(path, UPLOAD_LIMIT)).toEqual({ content: "data", filename: "photo.jpg" });
  });
  it("rejects a file outside every root", async () => {
    mkdirSync(join(work, "outbox"));
    const path = put("elsewhere/secret.txt");
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow("is outside the directories allowed by TELEGRAM_UPLOAD_ROOTS");
    await expect(resolveMediaInput(`${work}/outbox/../elsewhere/secret.txt`, UPLOAD_LIMIT)).rejects.toThrow('contains "." or ".." segments');
  });
  it("refuses a missing path outside the roots as outside, before looking it up", async () => {
    mkdirSync(join(work, "outbox"));
    const path = join(work, "elsewhere", "missing.pdf");
    const outsideRoots = `Local file ${path} is outside the directories allowed by TELEGRAM_UPLOAD_ROOTS`;
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow(new Error(outsideRoots));
    const result = await call("send-document", { chatId: "123", media: path });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(outsideRoots);
    expect(text(result)).not.toMatch(/not found|not readable|ENOENT|EACCES/);
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
  it.skipIf(runsAsRoot)("refuses a path below an unreadable directory outside the roots as outside", async () => {
    mkdirSync(join(work, "outbox"));
    const path = put("locked/secret.pdf");
    const outsideRoots = `Local file ${path} is outside the directories allowed by TELEGRAM_UPLOAD_ROOTS`;
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    await whileUnreadable(join(work, "locked"), async () => {
      await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow(new Error(outsideRoots));
      const result = await call("send-document", { chatId: "123", media: path });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(outsideRoots);
      expect(text(result)).not.toMatch(/not found|not readable|ENOENT|EACCES/);
    });
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
  it("rejects . and .. segments even when the path would normalize into a root", async () => {
    put("outbox/photo.jpg");
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    for (const path of [`${work}/outbox/../outbox/photo.jpg`, `${work}/outbox/./photo.jpg`]) {
      await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow('contains "." or ".." segments; pass the path without them');
    }
  });
  it("realpaths the given path as is, so a symlinked directory followed by .. cannot escape a lexical check", async () => {
    // outbox/link -> elsewhere/deep, so outbox/link/../secret.txt is elsewhere/secret.txt on disk
    // while path.resolve would turn it into outbox/secret.txt.
    put("elsewhere/secret.txt", "secret");
    put("elsewhere/deep/keep.txt");
    put("outbox/secret.txt", "decoy");
    symlinkSync(join(work, "elsewhere", "deep"), join(work, "outbox", "link"));
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    const result = await call("send-document", { chatId: "123", media: `${work}/outbox/link/../secret.txt` });
    expect(result.isError).toBe(true);
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
  it("rejects a symlink inside a root that points outside it", async () => {
    const outside = put("elsewhere/secret.txt");
    mkdirSync(join(work, "outbox"));
    const link = join(work, "outbox", "innocent.jpg");
    symlinkSync(outside, link);
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    await expect(resolveMediaInput(link, UPLOAD_LIMIT)).rejects.toThrow("is outside the directories allowed by TELEGRAM_UPLOAD_ROOTS");
  });
  it("follows a symlink that stays inside the root", async () => {
    const target = put("outbox/real.jpg");
    symlinkSync(target, join(work, "outbox", "alias.jpg"));
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    expect(await resolveMediaInput(join(work, "outbox", "alias.jpg"), UPLOAD_LIMIT)).toEqual({ content: "data", filename: "real.jpg" });
  });
  it("reports a missing file", async () => {
    await expect(resolveMediaInput(join(work, "missing.jpg"), UPLOAD_LIMIT)).rejects.toThrow(`Local file not found: ${join(work, "missing.jpg")}`);
  });
  it("rejects a directory", async () => {
    mkdirSync(join(work, "folder"));
    await expect(resolveMediaInput(join(work, "folder"), UPLOAD_LIMIT)).rejects.toThrow("Local path is not a regular file");
    await expect(resolveMediaInput(work, UPLOAD_LIMIT)).rejects.toThrow("is outside");
  });
  it("does not treat a sibling directory with a shared prefix as inside the root", async () => {
    mkdirSync(join(work, "a"));
    const path = put("ab/file.txt");
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "a"));
    await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow("is outside the directories allowed by TELEGRAM_UPLOAD_ROOTS");
  });
  it("reads TELEGRAM_UPLOAD_ROOTS on every call", async () => {
    const inbox = join(work, "inbox");
    mkdirSync(inbox);
    const path = put("outbox/report.pdf", "report");
    const outsideRoots = `Local file ${path} is outside the directories allowed by TELEGRAM_UPLOAD_ROOTS`;

    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", inbox);
    await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow(outsideRoots);
    await expect(resolveMediaInput("./a.pdf", UPLOAD_LIMIT)).rejects.toThrow(new Error("Local paths must be absolute and inside TELEGRAM_UPLOAD_ROOTS; got ./a.pdf"));
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", undefined);
    expect(await resolveMediaInput(path, UPLOAD_LIMIT)).toEqual({ content: "report", filename: "report.pdf" });
    await expect(resolveMediaInput("./a.pdf", UPLOAD_LIMIT)).rejects.toThrow(new Error("Local paths must be absolute; got ./a.pdf"));
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", "");
    expect(await resolveMediaInput(path, UPLOAD_LIMIT)).toEqual({ content: "report", filename: "report.pdf" });
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", work);
    expect(await resolveMediaInput(path, UPLOAD_LIMIT)).toEqual({ content: "report", filename: "report.pdf" });
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", inbox);
    await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow(outsideRoots);

    // The registered tools follow the same switches without being registered again.
    const refused = await call("send-document", { chatId: "123", media: path });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain(outsideRoots);
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", undefined);
    json(await call("send-document", { chatId: "123", media: path }));
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", inbox);
    const refusedAgain = await call("send-document", { chatId: "123", media: path });
    expect(refusedAgain.isError).toBe(true);
    expect(text(refusedAgain)).toContain(outsideRoots);
    expect(api.sendDocument).toHaveBeenCalledTimes(1);
  });
  it("rejects relative upload roots and quotes the entry", async () => {
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", "outbox");
    await expect(resolveMediaInput(put("photo.jpg"), UPLOAD_LIMIT)).rejects.toThrow(new Error('TELEGRAM_UPLOAD_ROOTS entries must be absolute paths: "outbox"'));
  });
  it("fails closed on a root made only of whitespace, before anything is uploaded", async () => {
    const path = put("photo.jpg");
    const notAbsolute = 'TELEGRAM_UPLOAD_ROOTS entries must be absolute paths: " "';
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", " ");
    await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow(new Error(notAbsolute));
    const result = await call("send-document", { chatId: "123", media: path });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(notAbsolute);
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
  it("ignores empty entries around a root and still restricts uploads to it", async () => {
    const inside = put("outbox/photo.jpg", "inside");
    const elsewhere = put("elsewhere/secret.txt");
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", `${delimiter}${join(work, "outbox")}${delimiter}`);
    expect(await resolveMediaInput(inside, UPLOAD_LIMIT)).toEqual({ content: "inside", filename: "photo.jpg" });
    await expect(resolveMediaInput(elsewhere, UPLOAD_LIMIT)).rejects.toThrow(new Error(`Local file ${elsewhere} is outside the directories allowed by TELEGRAM_UPLOAD_ROOTS`));
  });
  it("fails closed when a whitespace entry follows a valid root", async () => {
    const path = put("outbox/photo.jpg");
    const notAbsolute = 'TELEGRAM_UPLOAD_ROOTS entries must be absolute paths: " "';
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", `${join(work, "outbox")}${delimiter} `);
    await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow(new Error(notAbsolute));
    const result = await call("send-document", { chatId: "123", media: path });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(notAbsolute);
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
  it.skipIf(runsAsRoot)("names the path and the code when a file inside a root cannot be resolved", async () => {
    const path = put("outbox/locked/photo.jpg");
    const notReadable = `Local file is not readable (EACCES): ${path}`;
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    await whileUnreadable(join(work, "outbox", "locked"), async () => {
      await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow(new Error(notReadable));
      const result = await call("send-document", { chatId: "123", media: path });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(notReadable);
    });
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
  it("names the path and the code for a symlink loop and a file used as a directory inside a root", async () => {
    mkdirSync(join(work, "outbox"));
    const loop = join(work, "outbox", "loop-a");
    symlinkSync(join(work, "outbox", "loop-b"), loop);
    symlinkSync(loop, join(work, "outbox", "loop-b"));
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    await expect(resolveMediaInput(loop, UPLOAD_LIMIT)).rejects.toThrow(new Error(`Local file is not readable (ELOOP): ${loop}`));
    const below = join(put("outbox/plain.txt"), "photo.jpg");
    await expect(resolveMediaInput(below, UPLOAD_LIMIT)).rejects.toThrow(new Error(`Local file is not readable (ENOTDIR): ${below}`));
  });
  it.skipIf(runsAsRoot)("names the input path and the code when a file inside a root cannot be opened", async () => {
    const real = put("outbox/files/photo.jpg");
    symlinkSync(join(work, "outbox", "files"), join(work, "outbox", "linked"));
    const path = join(work, "outbox", "linked", "photo.jpg");
    const notReadable = `Local file is not readable (EACCES): ${path}`;
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    await whileUnreadable(real, async () => {
      await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow(new Error(notReadable));
      const result = await call("send-document", { chatId: "123", media: path });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(notReadable);
      expect(text(result)).not.toContain("EACCES: permission denied, open");
      expect(text(result)).not.toContain(real);
    });
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
  it("enforces 10 MB for photos and 50 MB for other media using sparse files", async () => {
    const photo = put("big.jpg", "");
    truncateSync(photo, PHOTO_UPLOAD_LIMIT);
    expect(await resolveMediaInput(photo, PHOTO_UPLOAD_LIMIT)).toMatchObject({ filename: "big.jpg" });
    truncateSync(photo, PHOTO_UPLOAD_LIMIT + 1);
    await expect(resolveMediaInput(photo, PHOTO_UPLOAD_LIMIT)).rejects.toThrow("is 10.0 MB (10485761 bytes), which exceeds the 10.0 MB (10485760 bytes) upload limit");
    expect(await resolveMediaInput(photo, UPLOAD_LIMIT)).toMatchObject({ filename: "big.jpg" });

    const video = put("big.mp4", "");
    truncateSync(video, UPLOAD_LIMIT + 1);
    await expect(resolveMediaInput(video, UPLOAD_LIMIT)).rejects.toThrow("is 50.0 MB (52428801 bytes), which exceeds the 50.0 MB (52428800 bytes) upload limit");

    const result = await call("send-photo", { chatId: "123", media: photo });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("exceeds the 10.0 MB (10485760 bytes) upload limit");
    expect(api.sendPhoto).not.toHaveBeenCalled();
  });
});

describe.each([
  ["unset", undefined],
  ["empty", ""],
  ["a single delimiter", delimiter],
  ["made only of delimiters", `${delimiter}${delimiter}${delimiter}`],
])("local media paths when TELEGRAM_UPLOAD_ROOTS is %s", (_label, roots) => {
  // A directory unrelated to the roots the other tests configure.
  let elsewhere: string;
  function outside(relative: string, content: string | Buffer = "data") {
    const path = join(elsewhere, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }
  /** Opens a local path in a batch of its own and returns the verified size. */
  async function openedSize(path: string, limit: number) {
    const uploads = new UploadBatch();
    try {
      return (await uploads.open(path, limit))?.size;
    } finally {
      await uploads.close();
    }
  }
  beforeEach(() => {
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", roots);
    elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "telegram-media-elsewhere-")));
  });
  afterEach(() => {
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("uploads a regular file from any directory", async () => {
    const path = outside("report.pdf", "outside data");
    expect(await resolveMediaInput(path, UPLOAD_LIMIT)).toEqual({ content: "outside data", filename: "report.pdf" });
    expect(await resolveMediaInput(path, UPLOAD_LIMIT, "Shown.pdf")).toEqual({ content: "outside data", filename: "Shown.pdf" });

    let uploaded: Buffer | undefined;
    api.sendDocument.mockImplementationOnce(async (_chat: string, media: { source: unknown }) => {
      uploaded = await readAll(media.source);
      return message({ document: file });
    });
    json(await call("send-document", { chatId: "123", media: path }));
    expect(api.sendDocument).toHaveBeenCalledWith("123", { source: expect.any(Readable), filename: "report.pdf" }, expect.anything());
    expect(uploaded?.toString()).toBe("outside data");
  });
  it("keeps passing URLs and file_ids through", async () => {
    expect(await resolveMediaInput("https://example.com/photo.jpg", UPLOAD_LIMIT)).toBe("https://example.com/photo.jpg");
    expect(await resolveMediaInput("AgACAgIAAxkBAAIB", UPLOAD_LIMIT)).toBe("AgACAgIAAxkBAAIB");
    json(await call("send-document", { chatId: "123", media: "http://example.com/a.pdf" }));
    expect(api.sendDocument).toHaveBeenCalledWith("123", "http://example.com/a.pdf", {});
  });
  it("uploads local files through the voice, video note and media group tools", async () => {
    json(await call("send-voice", { chatId: "123", media: outside("memo.ogg", opusFile) }));
    expect(api.sendVoice).toHaveBeenCalledWith("123", { source: expect.any(Readable), filename: "memo.ogg" }, expect.anything());
    expect(ffmpeg).not.toHaveBeenCalled();
    json(await call("send-voice", { chatId: "123", media: outside("memo.wav", wav()) }));
    expect(ffmpeg).toHaveBeenCalledTimes(1);
    json(await call("send-video-note", { chatId: "123", videoNote: outside("note.mp4", "mp4") }));
    expect(api.sendVideoNote).toHaveBeenCalledWith("123", { source: expect.any(Readable), filename: "note.mp4" }, expect.anything());
    json(await call("send-media-group", { chatId: "123", media: [{ type: "photo", media: outside("a.jpg", "jpeg") }, { type: "video", media: outside("b.mp4", "mp4") }] }));
    expect(api.sendMediaGroup.mock.calls[0][1]).toMatchObject([
      { type: "photo", media: { source: expect.any(Readable), filename: "a.jpg" } },
      { type: "video", media: { source: expect.any(Readable), filename: "b.mp4" } },
    ]);
  });
  it("resolves a symlink to its realpath and applies every check to the file it leads to", async () => {
    const target = outside("real/target.pdf", "target data");
    symlinkSync(target, join(elsewhere, "link.jpg"));
    expect(await resolveMediaInput(join(elsewhere, "link.jpg"), UPLOAD_LIMIT)).toEqual({ content: "target data", filename: "target.pdf" });

    symlinkSync(join(elsewhere, "real"), join(elsewhere, "folder-link"));
    await expect(resolveMediaInput(join(elsewhere, "folder-link"), UPLOAD_LIMIT)).rejects.toThrow(`Local path is not a regular file: ${join(elsewhere, "folder-link")}`);
    symlinkSync(join(elsewhere, "gone.pdf"), join(elsewhere, "dangling.pdf"));
    await expect(resolveMediaInput(join(elsewhere, "dangling.pdf"), UPLOAD_LIMIT)).rejects.toThrow(`Local file not found: ${join(elsewhere, "dangling.pdf")}`);
    const big = outside("big.jpg", "");
    truncateSync(big, PHOTO_UPLOAD_LIMIT + 1);
    symlinkSync(big, join(elsewhere, "small.jpg"));
    await expect(resolveMediaInput(join(elsewhere, "small.jpg"), PHOTO_UPLOAD_LIMIT)).rejects.toThrow("is 10.0 MB (10485761 bytes), which exceeds the 10.0 MB (10485760 bytes) upload limit");
  });
  it("refuses relative, home, file: and dot-segment forms without naming the roots", async () => {
    for (const media of ["~/a.pdf", "./a.pdf", "../a.pdf", "file:///srv/telegram/outbox/a.pdf", "FILE:/srv/x.pdf", "photos/a.jpg", "a\\b.jpg", "  /srv/a.jpg"]) {
      await expect(resolveMediaInput(media, UPLOAD_LIMIT)).rejects.toThrow(new Error(`Local paths must be absolute; got ${media}`));
    }
    outside("sub/a.pdf");
    for (const media of [`${elsewhere}/./sub/a.pdf`, `${elsewhere}/sub/../sub/a.pdf`, `${elsewhere}/sub/.`, `${elsewhere}/sub/..`]) {
      await expect(resolveMediaInput(media, UPLOAD_LIMIT)).rejects.toThrow(`Local path ${media} contains "." or ".." segments; pass the path without them`);
    }

    const result = await call("send-document", { chatId: "123", media: "./a.pdf" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Local paths must be absolute; got ./a.pdf");
    expect(text(result)).not.toContain("TELEGRAM_UPLOAD_ROOTS");
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
  it("refuses a NUL byte", async () => {
    await expect(resolveMediaInput(`${elsewhere}/a\0b.pdf`, UPLOAD_LIMIT)).rejects.toThrow("Local path contains a NUL byte");
  });
  it("refuses a directory and a missing file", async () => {
    mkdirSync(join(elsewhere, "folder"));
    await expect(resolveMediaInput(join(elsewhere, "folder"), UPLOAD_LIMIT)).rejects.toThrow(`Local path is not a regular file: ${join(elsewhere, "folder")}`);
    await expect(resolveMediaInput(elsewhere, UPLOAD_LIMIT)).rejects.toThrow(`Local path is not a regular file: ${elsewhere}`);
    await expect(resolveMediaInput(join(elsewhere, "missing.pdf"), UPLOAD_LIMIT)).rejects.toThrow(`Local file not found: ${join(elsewhere, "missing.pdf")}`);

    const result = await call("send-document", { chatId: "123", media: join(elsewhere, "folder") });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Local path is not a regular file");
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
  it.skipIf(runsAsRoot)("names the path and the code when a file cannot be resolved", async () => {
    const path = outside("locked/photo.jpg");
    const notReadable = `Local file is not readable (EACCES): ${path}`;
    await whileUnreadable(join(elsewhere, "locked"), async () => {
      await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow(new Error(notReadable));
      const result = await call("send-document", { chatId: "123", media: path });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(notReadable);
    });
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
  it("names the path and the code for a symlink loop and a file used as a directory", async () => {
    const loop = join(elsewhere, "loop-a");
    symlinkSync(join(elsewhere, "loop-b"), loop);
    symlinkSync(loop, join(elsewhere, "loop-b"));
    await expect(resolveMediaInput(loop, UPLOAD_LIMIT)).rejects.toThrow(new Error(`Local file is not readable (ELOOP): ${loop}`));
    const below = join(outside("plain.txt"), "photo.jpg");
    await expect(resolveMediaInput(below, UPLOAD_LIMIT)).rejects.toThrow(new Error(`Local file is not readable (ENOTDIR): ${below}`));
  });
  it.skipIf(runsAsRoot)("names the input path and the code when a file cannot be opened", async () => {
    const real = outside("files/photo.jpg");
    symlinkSync(join(elsewhere, "files"), join(elsewhere, "linked"));
    const path = join(elsewhere, "linked", "photo.jpg");
    const notReadable = `Local file is not readable (EACCES): ${path}`;
    await whileUnreadable(real, async () => {
      await expect(resolveMediaInput(path, UPLOAD_LIMIT)).rejects.toThrow(new Error(notReadable));
      const result = await call("send-document", { chatId: "123", media: path });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(notReadable);
      expect(text(result)).not.toContain("EACCES: permission denied, open");
      expect(text(result)).not.toContain(real);
    });
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
  it("enforces 10 MB for photos and 50 MB for other media using sparse files", async () => {
    const photo = outside("big.jpg", "");
    truncateSync(photo, PHOTO_UPLOAD_LIMIT);
    expect(await openedSize(photo, PHOTO_UPLOAD_LIMIT)).toBe(PHOTO_UPLOAD_LIMIT);
    truncateSync(photo, PHOTO_UPLOAD_LIMIT + 1);
    await expect(openedSize(photo, PHOTO_UPLOAD_LIMIT)).rejects.toThrow("is 10.0 MB (10485761 bytes), which exceeds the 10.0 MB (10485760 bytes) upload limit");
    expect(await openedSize(photo, UPLOAD_LIMIT)).toBe(PHOTO_UPLOAD_LIMIT + 1);

    const video = outside("big.mp4", "");
    truncateSync(video, UPLOAD_LIMIT);
    expect(await openedSize(video, UPLOAD_LIMIT)).toBe(UPLOAD_LIMIT);
    truncateSync(video, UPLOAD_LIMIT + 1);
    await expect(openedSize(video, UPLOAD_LIMIT)).rejects.toThrow("is 50.0 MB (52428801 bytes), which exceeds the 50.0 MB (52428800 bytes) upload limit");

    const refusedPhoto = await call("send-photo", { chatId: "123", media: photo });
    expect(refusedPhoto.isError).toBe(true);
    expect(text(refusedPhoto)).toContain("exceeds the 10.0 MB (10485760 bytes) upload limit");
    const refusedVideo = await call("send-video", { chatId: "123", media: video });
    expect(refusedVideo.isError).toBe(true);
    expect(text(refusedVideo)).toContain("exceeds the 50.0 MB (52428800 bytes) upload limit");
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendVideo).not.toHaveBeenCalled();
  });
  it("applies the filename rules", async () => {
    // A default name taken from the file is made safe for the multipart header.
    expect(await resolveMediaInput(outside("we\"ird\\name.pdf"), UPLOAD_LIMIT)).toEqual({ content: "data", filename: "we_ird_name.pdf" });
    const path = outside("a.pdf");
    for (const filename of ["bad\"name.pdf", "bad\\name.pdf", "bad/name.pdf", "bad\nname.pdf", "bad\x7fname.pdf"]) {
      const result = await call("send-document", { chatId: "123", media: path, filename });
      expect(result.isError).toBe(true);
      const group = await call("send-media-group", { chatId: "123", media: [{ type: "document", media: path, filename }, { type: "document", media: "doc-id" }] });
      expect(group.isError).toBe(true);
    }
    expect(api.sendDocument).not.toHaveBeenCalled();
    expect(api.sendMediaGroup).not.toHaveBeenCalled();
  });
});

describe("media input forms on send tools", () => {
  it("passes a local path to Telegram as a stream of the verified file", async () => {
    const real = put("outbox/report.pdf", "%PDF-1.4");
    symlinkSync(real, join(work, "outbox", "latest.pdf"));
    let content: Buffer | undefined;
    api.sendDocument.mockImplementationOnce(async (_chat: string, media: { source: unknown }) => {
      content = await readAll(media.source);
      return message({ document: file });
    });
    const result = json(await call("send-document", { chatId: "123", media: join(work, "outbox", "latest.pdf"), filename: "Q3 report.pdf", caption: "Report" }));
    expect(api.sendDocument).toHaveBeenCalledWith("123", { source: expect.any(Readable), filename: "Q3 report.pdf" }, { caption: "Report" });
    expect(content!.toString()).toBe("%PDF-1.4");
    expect(result).toEqual({ chat_id: 123, message_id: 1, message_ids: [1], date: 1000, ...file });

    const photo = put("photo.jpg");
    json(await call("send-photo", { chatId: "123", media: photo, text: "Look" }));
    expect(api.sendPhoto).toHaveBeenCalledWith("123", { source: expect.any(Readable), filename: "photo.jpg" }, { caption: "Look" });
  });
  it("passes URL and file_id media through as plain strings", async () => {
    await call("send-photo", { chatId: "123", media: "https://example.com/p.jpg", filename: "ignored.jpg" });
    await call("send-document", { chatId: "123", media: "BQACAgIAAxkBAAIC" });
    expect(api.sendPhoto).toHaveBeenCalledWith("123", "https://example.com/p.jpg", {});
    expect(api.sendDocument).toHaveBeenCalledWith("123", "BQACAgIAAxkBAAIC", {});
  });
  it("rejects a filename that could break the upload headers", async () => {
    const result = await call("send-document", { chatId: "123", media: put("a.pdf"), filename: "bad\"name.pdf" });
    expect(result.isError).toBe(true);
    expect(api.sendDocument).not.toHaveBeenCalled();
  });
});

describe("send-media-group", () => {
  const item = (type: string, media = `${type}-id`) => ({ type, media });

  it.each([1, 11])("rejects %i items before calling Telegram", async (count) => {
    const result = await call("send-media-group", { chatId: "123", media: Array.from({ length: count }, () => item("photo")) });
    expect(result.isError).toBe(true);
    expect(api.sendMediaGroup).not.toHaveBeenCalled();
  });
  it("accepts mixed photos and videos with per-item captions, parse modes and group options", async () => {
    const result = json(await call("send-media-group", {
      chatId: "123",
      media: [
        { type: "photo", media: "photo-id", caption: "<b>One</b>", parseMode: "HTML" },
        { type: "video", media: "https://example.com/v.mp4", caption: "Two", parseMode: "none" },
        { type: "photo", media: "photo-id-2" },
      ],
      ...common,
    }));
    expect(api.sendMediaGroup).toHaveBeenCalledWith("123", [
      { type: "photo", media: "photo-id", caption: "<b>One</b>", parse_mode: "HTML" },
      { type: "video", media: "https://example.com/v.mp4", caption: "Two" },
      { type: "photo", media: "photo-id-2" },
    ], extra);
    expect(result).toEqual({
      chat_id: 123,
      message_id: 1,
      message_ids: [1, 2, 3],
      date: 1000,
      items: [
        { message_id: 1, file_id: "photo-0", file_unique_id: "photo-unique-0" },
        { message_id: 2, file_id: "video-1", file_unique_id: "video-unique-1" },
        { message_id: 3, file_id: "photo-2", file_unique_id: "photo-unique-2" },
      ],
    });
  });
  it("uploads local items as InputFiles and applies the photo limit per item", async () => {
    const photo = put("one.jpg");
    const document = put("two.pdf");
    await call("send-media-group", { chatId: "123", media: [{ type: "document", media: document, filename: "Two.pdf" }, { type: "document", media: "doc-id" }] });
    expect(api.sendMediaGroup.mock.calls[0][1]).toEqual([{ type: "document", media: { source: expect.any(Readable), filename: "Two.pdf" } }, { type: "document", media: "doc-id" }]);

    truncateSync(photo, PHOTO_UPLOAD_LIMIT + 1);
    const result = await call("send-media-group", { chatId: "123", media: [{ type: "photo", media: photo }, item("video")] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("exceeds the 10.0 MB");
    expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
  });
  // Every non-empty set of item types; a group needs two items, so a single type is repeated.
  const groupTypes = ["photo", "video", "audio", "document"];
  const typeSets = Array.from({ length: 2 ** groupTypes.length - 1 }, (_, index) => groupTypes.filter((_, bit) => (index + 1) & (1 << bit)))
    .map(types => ({ types, label: types.join("+"), items: types.length === 1 ? [...types, ...types] : types }));
  const allowedSets = ["photo", "video", "photo+video", "document", "audio"];
  const groupMedia = (types: string[]) => types.map((type, index) => item(type, put(`group/${index}-${type}.bin`)));
  it("covers every non-empty type set", () => {
    expect(typeSets).toHaveLength(15);
    expect(typeSets.filter(set => allowedSets.includes(set.label))).toHaveLength(allowedSets.length);
  });
  it.each(typeSets.filter(set => !allowedSets.includes(set.label)))("rejects a group of $label items in either order", async ({ types, items }) => {
    const only = ["document", "audio"].find(type => types.includes(type));
    for (const order of [items, [...items].reverse()]) {
      const result = await call("send-media-group", { chatId: "123", media: groupMedia(order) });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(`A media group with ${only} items can only contain ${only} items`);
    }
    expect(api.sendMediaGroup).not.toHaveBeenCalled();
  });
  it.each(typeSets.filter(set => allowedSets.includes(set.label)))("accepts a group of $label items in either order", async ({ items }) => {
    for (const order of [items, [...items].reverse()]) {
      json(await call("send-media-group", { chatId: "123", media: groupMedia(order) }));
      expect(api.sendMediaGroup.mock.lastCall?.[1].map((sent: { type: string }) => sent.type)).toEqual(order);
    }
    expect(api.sendMediaGroup).toHaveBeenCalledTimes(2);
  });
  it("rejects a caption over 1024 characters instead of splitting it", async () => {
    const result = await call("send-media-group", { chatId: "123", media: [item("photo"), { ...item("photo"), caption: "x".repeat(1025) }] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Caption of item 2 is 1025 characters");
    expect(api.sendMediaGroup).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    json(await call("send-media-group", { chatId: "123", media: [item("photo"), { ...item("photo"), caption: "x".repeat(1024) }] }));
  });
});

describe("send-voice conversion", () => {
  it("detects OGG/Opus from content rather than the extension", async () => {
    expect(await isOggOpus(put("voice.mp3", opusFile))).toBe(true);
    expect(await isOggOpus(put("voice.ogg", vorbisFile))).toBe(false);
    expect(await isOggOpus(put("voice.wav", wav()))).toBe(false);
    expect(await isOggOpus(put("empty.ogg", ""))).toBe(false);
  });
  it("uploads OGG/Opus content as is", async () => {
    const path = put("note.bin", opusFile);
    let content: Buffer | undefined;
    api.sendVoice.mockImplementationOnce(async (_chat: string, media: { source: unknown }) => {
      content = await readAll(media.source);
      return message({ voice: file });
    });
    json(await call("send-voice", { chatId: "123", media: path, duration: 4, caption: "Memo" }));
    expect(ffmpeg).not.toHaveBeenCalled();
    expect(api.sendVoice).toHaveBeenCalledWith("123", { source: expect.any(Readable), filename: "note.ogg" }, { caption: "Memo", duration: 4 });
    expect(content).toEqual(opusFile);
  });
  it("gives an as-is OGG/Opus upload an .ogg name, also when a filename is given", async () => {
    json(await call("send-voice", { chatId: "123", media: put("memo.opus", opusFile), filename: "Memo.mp3" }));
    json(await call("send-voice", { chatId: "123", media: put("raw", opusFile) }));
    expect(ffmpeg).not.toHaveBeenCalled();
    expect(api.sendVoice.mock.calls.map(args => args[1].filename)).toEqual(["Memo.ogg", "raw.ogg"]);
  });
  it("converts OGG/Opus whose channel mapping cannot be sent as is instead of refusing it", async () => {
    const head = (family: number, channels: number) => oggPage(Buffer.concat([Buffer.from("OpusHead", "latin1"), Buffer.from([1, channels, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, family])]));
    json(await call("send-voice", { chatId: "123", media: put("surround.ogg", head(0, 3)) }));
    json(await call("send-voice", { chatId: "123", media: put("untabled.ogg", head(1, 2)) }));
    expect(ffmpeg).toHaveBeenCalledTimes(2);
    expect(ffmpeg.mock.calls.map(([args]) => args.slice(4, 6))).toEqual([["-f", "ogg"], ["-f", "ogg"]]);
    expect(api.sendVoice).toHaveBeenCalledTimes(2);
  });
  it("passes URL and file_id voice input through without conversion", async () => {
    await call("send-voice", { chatId: "123", media: "https://example.com/v.mp3" });
    await call("send-voice", { chatId: "123", media: "AwACAgIAAxkBAAID" });
    expect(ffmpeg).not.toHaveBeenCalled();
    expect(api.sendVoice.mock.calls.map(args => args[1])).toEqual(["https://example.com/v.mp3", "AwACAgIAAxkBAAID"]);
  });
  it("converts other local audio with ffmpeg and removes the temporary directory", async () => {
    const source = put("memo.ogg", vorbisFile);
    let uploaded: { source: string; filename: string } | undefined;
    let existedDuringUpload = false;
    api.sendVoice.mockImplementation(async (_chatId: string, media: { source: string; filename: string }) => {
      uploaded = media;
      existedDuringUpload = existsSync(media.source);
      return message({ voice: file });
    });
    let stagedCopy: Buffer | undefined;
    ffmpeg.mockImplementationOnce(async (args) => {
      stagedCopy = readFileSync(args[args.indexOf("-i") + 1]);
      writeFileSync(args[args.length - 1], opusFile);
    });
    const result = json(await call("send-voice", { chatId: "123", media: source, ...common }));
    expect(result).toMatchObject({ message_ids: [1], ...file });
    expect(ffmpeg).toHaveBeenCalledTimes(1);
    const [args, timeout] = ffmpeg.mock.calls[0];
    const output = args[args.length - 1];
    const input = join(dirname(output), "input");
    expect(args).toEqual(["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", input, "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "48k", "-f", "ogg", output]);
    expect(stagedCopy).toEqual(vorbisFile);
    expect(timeout).toBeGreaterThan(0);
    expect(dirname(output).startsWith(join(tmpdir(), "telegram-voice-"))).toBe(true);
    expect(uploaded).toEqual({ source: output, filename: "memo.ogg" });
    expect(api.sendVoice.mock.calls[0][2]).toEqual({ ...extra, reply_parameters: JSON.stringify(extra.reply_parameters) });
    expect(existedDuringUpload).toBe(true);
    expect(existsSync(dirname(output))).toBe(false);
  });
  it("removes the temporary directory when the upload or the conversion fails", async () => {
    api.sendVoice.mockRejectedValue({ response: { error_code: 400, description: "Bad Request: wrong file" } });
    const failed = await call("send-voice", { chatId: "123", media: put("memo.wav", wav()) });
    expect(failed.isError).toBe(true);
    expect(existsSync(dirname(ffmpeg.mock.calls[0][0].at(-1)!))).toBe(false);

    ffmpeg.mockRejectedValueOnce(new Error("ffmpeg failed to convert the audio to OGG/Opus: Invalid data found"));
    const broken = await call("send-voice", { chatId: "123", media: put("broken.wav", Buffer.concat([wav().subarray(0, 12), Buffer.from("not audio")])) });
    expect(broken.isError).toBe(true);
    expect(text(broken)).toContain("Invalid data found");
    expect(existsSync(dirname(ffmpeg.mock.calls[1][0].at(-1)!))).toBe(false);
  });
  it("applies the 50 MB limit to the converted output", async () => {
    ffmpeg.mockImplementationOnce(async (args) => {
      writeFileSync(args[args.length - 1], "");
      truncateSync(args[args.length - 1], UPLOAD_LIMIT + 1);
    });
    const result = await call("send-voice", { chatId: "123", media: put("long.wav", wav()) });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Converted voice file is 50.0 MB (52428801 bytes), which exceeds the 50.0 MB (52428800 bytes) upload limit");
    expect(api.sendVoice).not.toHaveBeenCalled();
    expect(existsSync(dirname(ffmpeg.mock.calls[0][0].at(-1)!))).toBe(false);
  });
  it("explains that ffmpeg is required when it is not on PATH", async () => {
    const emptyPath = join(work, "empty-bin");
    mkdirSync(emptyPath);
    const before = voiceTempDirs();
    const realRunner = await connect({});
    const source = put("memo.wav", wav());
    vi.stubEnv("PATH", emptyPath);
    const result = await call("send-voice", { chatId: "123", media: source }, realRunner);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("ffmpeg is required to convert non-OGG/Opus audio for send-voice, but it was not found on PATH");
    expect(api.sendVoice).not.toHaveBeenCalled();
    expect(voiceTempDirs()).toEqual(before);
  });
  it.skipIf(!hasFfmpeg)("converts a WAV file to OGG/Opus with the real ffmpeg", async () => {
    const realRunner = await connect({});
    const source = put("memo.wav", wav());
    let converted = Buffer.alloc(0);
    let output = "";
    api.sendVoice.mockImplementation(async (_chatId: string, media: { source: string }) => {
      output = media.source;
      converted = readFileSync(media.source);
      return message({ voice: file });
    });
    json(await call("send-voice", { chatId: "123", media: source }, realRunner));
    expect(converted.subarray(0, 4).toString("latin1")).toBe("OggS");
    expect(await isOggOpus(put("converted.ogg", converted))).toBe(true);
    expect(existsSync(dirname(output))).toBe(false);
  }, 30000);
});

describe("send-video-note", () => {
  it("maps duration, length and common options and returns file identifiers", async () => {
    const result = json(await call("send-video-note", { chatId: "123", videoNote: "note-id", duration: 3, length: 240, ...common }));
    expect(api.sendVideoNote).toHaveBeenCalledWith("123", "note-id", { ...extra, duration: 3, length: 240 });
    expect(result).toEqual({ chat_id: 123, message_id: 1, message_ids: [1], date: 1000, ...file });
  });
  it("uploads a local video note", async () => {
    const path = put("note.mp4");
    json(await call("send-video-note", { chatId: "123", videoNote: path }));
    expect(api.sendVideoNote).toHaveBeenCalledWith("123", { source: expect.any(Readable), filename: "note.mp4" }, {});
  });
});

describe("edit-message-caption", () => {
  it("maps the caption and parse mode and returns message identifiers", async () => {
    const result = json(await call("edit-message-caption", { chatId: "123", messageId: 4, caption: "<i>New</i>", parseMode: "HTML" }));
    expect(api.editMessageCaption).toHaveBeenCalledWith("123", 4, undefined, "<i>New</i>", { parse_mode: "HTML" });
    expect(result).toEqual({ chat_id: 123, message_id: 1, message_ids: [1], date: 1000, ...file });
  });
  it("confirms a true edit response", async () => {
    api.editMessageCaption.mockResolvedValue(true);
    expect(json(await call("edit-message-caption", { chatId: "123", messageId: 4, caption: "New", parseMode: "none" }))).toEqual({ chat_id: "123", message_id: 4, edited: true });
    expect(api.editMessageCaption).toHaveBeenCalledWith("123", 4, undefined, "New", {});
  });
  it("rejects a caption over 1024 characters", async () => {
    const result = await call("edit-message-caption", { chatId: "123", messageId: 4, caption: "x".repeat(1025) });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Caption is 1025 characters");
    expect(api.editMessageCaption).not.toHaveBeenCalled();
  });
  it.each(["HTML", "MarkdownV2"])("passes a long %s caption through for Telegram to measure", async (parseMode) => {
    const caption = "<b>x</b>".repeat(200);
    json(await call("edit-message-caption", { chatId: "123", messageId: 4, caption, parseMode }));
    expect(api.editMessageCaption).toHaveBeenCalledWith("123", 4, undefined, caption, { parse_mode: parseMode });
  });
  it("rejects a long caption with parse mode none", async () => {
    const result = await call("edit-message-caption", { chatId: "123", messageId: 4, caption: "x".repeat(1025), parseMode: "none" });
    expect(result.isError).toBe(true);
    expect(api.editMessageCaption).not.toHaveBeenCalled();
  });
  it("counts UTF-16 code units, so 512 emoji fit and 513 do not", async () => {
    json(await call("edit-message-caption", { chatId: "123", messageId: 4, caption: "\u{1F600}".repeat(512) }));
    const result = await call("edit-message-caption", { chatId: "123", messageId: 4, caption: "\u{1F600}".repeat(513) });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Caption is 1026 characters");
  });
});

describe("formatted captions in media groups", () => {
  const long = "<b>x</b>".repeat(200);
  it("passes long HTML and MarkdownV2 item captions through", async () => {
    json(await call("send-media-group", { chatId: "123", media: [
      { type: "photo", media: "a", caption: long, parseMode: "HTML" },
      { type: "photo", media: "b", caption: long, parseMode: "MarkdownV2" },
    ] }));
    expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "none"])("rejects a long item caption with parse mode %s", async (parseMode) => {
    const result = await call("send-media-group", { chatId: "123", media: [
      { type: "photo", media: "a", caption: long, parseMode: "HTML" },
      { type: "photo", media: "b", caption: long, ...(parseMode && { parseMode }) },
    ] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Caption of item 2 is 1600 characters");
    expect(api.sendMediaGroup).not.toHaveBeenCalled();
  });
});

describe("local paths and filenames on the single-media tools", () => {
  // shown is the filename Telegram receives for the filename "Shown name.bin".
  const tools = [
    { name: "send-photo", method: "sendPhoto", key: "media", limit: PHOTO_UPLOAD_LIMIT, content: "jpeg", shown: "Shown name.bin" },
    { name: "send-document", method: "sendDocument", key: "media", limit: UPLOAD_LIMIT, content: "pdf", shown: "Shown name.bin" },
    { name: "send-video", method: "sendVideo", key: "media", limit: UPLOAD_LIMIT, content: "mp4", shown: "Shown name.bin" },
    { name: "send-audio", method: "sendAudio", key: "media", limit: UPLOAD_LIMIT, content: "mp3", shown: "Shown name.bin" },
    { name: "send-animation", method: "sendAnimation", key: "media", limit: UPLOAD_LIMIT, content: "gif", shown: "Shown name.bin" },
    { name: "send-voice", method: "sendVoice", key: "media", limit: UPLOAD_LIMIT, content: opusFile, shown: "Shown name.ogg" },
    { name: "send-sticker", method: "sendSticker", key: "media", limit: UPLOAD_LIMIT, content: "webp", shown: "Shown name.bin" },
    { name: "send-video-note", method: "sendVideoNote", key: "videoNote", limit: UPLOAD_LIMIT, content: "mp4", shown: "Shown name.bin" },
  ];
  it("covers every media tool that takes a single file", () => {
    expect(tools).toHaveLength(8);
  });
  it.each(tools)("$name uploads a local path under the given filename", async ({ name, method, key, content, shown }) => {
    let uploaded: Buffer | undefined;
    api[method].mockImplementationOnce(async (_chat: string, media: { source: unknown }) => {
      uploaded = await readAll(media.source);
      return message({ document: file });
    });
    json(await call(name, { chatId: "123", [key]: put("outbox/input.bin", content), filename: "Shown name.bin" }));
    expect(api[method]).toHaveBeenCalledWith("123", { source: expect.any(Readable), filename: shown }, expect.anything());
    expect(uploaded).toEqual(Buffer.from(content));
  });
  it.each(tools)("$name refuses a local file one byte over its limit", async ({ name, method, key, limit }) => {
    const path = put("outbox/big.bin", "");
    truncateSync(path, limit + 1);
    const result = await call(name, { chatId: "123", [key]: path });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`which exceeds the ${(limit / 1024 / 1024).toFixed(1)} MB (${limit} bytes) upload limit`);
    expect(api[method]).not.toHaveBeenCalled();
  });
  const badFilenames = [
    ["a quote", "bad\"name.pdf"],
    ["a backslash", "bad\\name.pdf"],
    ["a slash", "bad/name.pdf"],
    ["a control character", "bad\nname.pdf"],
    ["a DEL character", "bad\x7fname.pdf"],
  ];
  describe.each(tools)("$name", ({ name, method, key }) => {
    it.each(badFilenames)("rejects a filename with %s", async (_class, filename) => {
      const result = await call(name, { chatId: "123", [key]: put("a.pdf"), filename });
      expect(result.isError).toBe(true);
      expect(api[method]).not.toHaveBeenCalled();
    });
    it.each(["~/a.pdf", "./a.pdf", "../a.pdf", "file:///srv/telegram/outbox/a.pdf", "photos/a.jpg", "a\\b.jpg", "  /tmp/a.jpg"])("rejects the relative or file: form %j", async (media) => {
      const result = await call(name, { chatId: "123", [key]: media });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Local paths must be absolute and inside TELEGRAM_UPLOAD_ROOTS");
      expect(api[method]).not.toHaveBeenCalled();
    });
    it("passes a plain file_id through", async () => {
      json(await call(name, { chatId: "123", [key]: "AgACAgIAAxkBAAIB-x_9" }));
      expect(api[method].mock.calls[0][1]).toBe("AgACAgIAAxkBAAIB-x_9");
    });
  });
  it.each(badFilenames)("send-media-group rejects an item filename with %s", async (_class, filename) => {
    const result = await call("send-media-group", { chatId: "123", media: [{ type: "document", media: put("a.pdf"), filename }, { type: "document", media: "doc-id" }] });
    expect(result.isError).toBe(true);
    expect(api.sendMediaGroup).not.toHaveBeenCalled();
  });
});

describe("send-voice input checks", () => {
  it("refuses an unsupported container without starting ffmpeg", async () => {
    const before = voiceTempDirs();
    for (const [name, content] of [["list.m3u8", "#EXTM3U\n/srv/telegram/private/secret.wav\n"], ["list.ffconcat", "ffconcat version 1.0\nfile '/srv/telegram/private/secret.wav'\n"], ["notes.txt", "hello"]]) {
      const result = await call("send-voice", { chatId: "123", media: put(name, content) });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Unsupported audio format");
    }
    expect(ffmpeg).not.toHaveBeenCalled();
    expect(api.sendVoice).not.toHaveBeenCalled();
    expect(voiceTempDirs()).toEqual(before);
  });
  it("converts a file whose OpusHead packet is truncated instead of sending it as Opus", async () => {
    json(await call("send-voice", { chatId: "123", media: put("short.ogg", opusFile.subarray(0, 40)) }));
    expect(ffmpeg).toHaveBeenCalledTimes(1);
    expect(ffmpeg.mock.calls[0][0].slice(4, 6)).toEqual(["-f", "ogg"]);
  });
  it("gives the converted upload an .ogg extension even when the filename has another one", async () => {
    json(await call("send-voice", { chatId: "123", media: put("memo.wav", wav()), filename: "Memo.mp3" }));
    expect(api.sendVoice.mock.calls[0][1]).toMatchObject({ filename: "Memo.ogg" });
  });
  it.skipIf(!hasFfmpeg)("refuses in-root HLS and ffconcat files that reference audio outside the roots, with the real ffmpeg", async () => {
    const secret = put("elsewhere/secret.wav", wav());
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", join(work, "outbox"));
    const realFfmpeg = vi.fn<FfmpegRunner>((args, timeout) => runFfmpeg(args, timeout));
    const realRunner = await connect({ runFfmpeg: realFfmpeg });
    const inputs = {
      "outbox/list.m3u8": `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile://${secret}\n#EXT-X-ENDLIST\n`,
      "outbox/list.ffconcat": `ffconcat version 1.0\nfile '${secret}'\n`,
      "outbox/disguised.mp3": `ffconcat version 1.0\nfile '${secret}'\n`,
    };
    for (const [name, content] of Object.entries(inputs)) {
      const result = await call("send-voice", { chatId: "123", media: put(name, content) }, realRunner);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("Unsupported audio format");
    }
    expect(realFfmpeg).not.toHaveBeenCalled();
    expect(api.sendVoice).not.toHaveBeenCalled();
  }, 30000);
});

describe("set-message-reaction", () => {
  it("sets an emoji reaction", async () => {
    expect(json(await call("set-message-reaction", { chatId: "123", messageId: 4, emoji: "\u{1F44D}", isBig: true }))).toEqual({ ok: true });
    expect(api.setMessageReaction).toHaveBeenCalledWith("123", 4, [{ type: "emoji", emoji: "\u{1F44D}" }], true);
  });
  it("removes the reaction when no emoji is given", async () => {
    expect(json(await call("set-message-reaction", { chatId: "123", messageId: 4 }))).toEqual({ ok: true });
    expect(api.setMessageReaction).toHaveBeenCalledWith("123", 4, [], undefined);
  });
});

it("annotates the new tools", async () => {
  const { tools } = await client.listTools();
  const annotations = (name: string) => tools.find(tool => tool.name === name)?.annotations;
  // download-file writes a new file but never replaces one.
  expect(annotations("download-file")).toEqual({ title: "Download File", readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  for (const name of ["send-video-note", "send-media-group", "edit-message-caption", "set-message-reaction"]) {
    expect(annotations(name)).toEqual({ title: expect.any(String), readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  }
});
