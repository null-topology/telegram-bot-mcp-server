import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { redactTransport, startServer } from "../src/server";
import { localPath, UploadBatch } from "../src/uploads";
import { captionLength } from "../src/utils";
import { audioDemuxer, isOggOpus, runFfmpeg, voiceFilename } from "../src/voice";

let work: string;
beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "telegram-hardening-test-")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

const bytes = (...values: (number | string)[]) => Buffer.concat(values.map(value => typeof value === "string" ? Buffer.from(value, "latin1") : Buffer.from([value])));

describe("audio container sniffing", () => {
  it.each([
    ["an ID3-tagged MP3", bytes("ID3", 4, 0, 0, 0, 0, 0, 0), "mp3"],
    ["an MPEG-1 layer III frame", bytes(0xff, 0xfb, 0x90, 0x00), "mp3"],
    ["an MPEG-2 layer III frame", bytes(0xff, 0xf3, 0x90, 0x00), "mp3"],
    ["an MPEG-2.5 layer III frame", bytes(0xff, 0xe3, 0x90, 0x00), "mp3"],
    ["an MPEG-4 ADTS frame", bytes(0xff, 0xf1, 0x50, 0x80), "aac"],
    ["an MPEG-2 ADTS frame without CRC", bytes(0xff, 0xf9, 0x50, 0x80), "aac"],
    ["a RIFF/WAVE file", bytes("RIFF", 0, 0, 0, 0, "WAVEfmt "), "wav"],
    ["a FLAC stream", bytes("fLaC", 0, 0, 0, 34), "flac"],
    ["an Ogg stream", bytes("OggS", 0, 2, 0, 0), "ogg"],
    ["an MP4/M4A file", bytes(0, 0, 0, 0x20, "ftypM4A "), "mov"],
    ["an EBML (Matroska/WebM) file", bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f), "matroska"],
  ])("maps %s to its demuxer", (_name, header, demuxer) => {
    expect(audioDemuxer(header)).toBe(demuxer);
  });
  it.each([
    ["an HLS playlist", bytes("#EXTM3U\n#EXTINF:1,\n/srv/telegram/private/secret.wav\n")],
    ["an ffconcat script", bytes("ffconcat version 1.0\nfile '/srv/telegram/private/secret.wav'\n")],
    ["an MPEG audio frame with the reserved version", bytes(0xff, 0xeb, 0x90, 0x00)],
    ["a RIFF file that is not WAVE", bytes("RIFF", 0, 0, 0, 0, "AVI LIST")],
    ["an SDP description", bytes("v=0\no=- 0 0 IN IP4 127.0.0.1\n")],
    ["plain text", bytes("hello")],
    ["an empty file", Buffer.alloc(0)],
  ])("refuses %s", (_name, header) => {
    expect(audioDemuxer(header)).toBeUndefined();
  });
});

/** An Ogg page header with the given segment table, followed by body. */
function page(lacing: number[], body: Buffer) {
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "latin1");
  header[5] = 2;
  header[26] = lacing.length;
  return Buffer.concat([header, Buffer.from(lacing), body]);
}
const opusHead = (version = 1, channels = 1) => Buffer.concat([Buffer.from("OpusHead", "latin1"), Buffer.from([version, channels, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0])]);

describe("OGG/Opus detection", () => {
  it("accepts a complete first page whose first packet is a valid OpusHead", () => {
    expect(isOggOpus(page([19], opusHead()))).toBe(true);
    expect(isOggOpus(page([19, 4], Buffer.concat([opusHead(), Buffer.from("next")])))).toBe(true);
  });
  it.each([
    ["a segment table longer than the bytes present", page([19], opusHead()).subarray(0, 27)],
    ["a packet cut short", page([19], opusHead()).subarray(0, 40)],
    ["a page body shorter than its segment table says", page([19, 50], opusHead())],
    ["a packet shorter than 19 bytes", page([11], opusHead().subarray(0, 11))],
    ["a version other than 1", page([19], opusHead(2))],
    ["zero channels", page([19], opusHead(1, 0))],
    ["a first packet that continues on the next page", page([255], Buffer.concat([opusHead(), Buffer.alloc(236)]))],
    ["an empty segment table", page([], Buffer.alloc(0))],
    ["a Vorbis header", page([30], Buffer.concat([Buffer.from("\x01vorbis", "latin1"), Buffer.alloc(23)]))],
  ])("refuses %s", (_name, header) => {
    expect(isOggOpus(header)).toBe(false);
  });
});

/** An OpusHead with an explicit mapping family, followed by the given family-specific bytes. */
const mappedHead = (family: number, channels: number, table: number[] = []) =>
  Buffer.concat([Buffer.from("OpusHead", "latin1"), Buffer.from([1, channels, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, family, ...table])]);
const firstPage = (head: Buffer) => page([head.length], head);

describe("OGG/Opus channel mapping", () => {
  it.each([
    ["family 0 with one channel", mappedHead(0, 1)],
    ["family 0 with two channels", mappedHead(0, 2)],
    ["family 1 with a complete stereo table", mappedHead(1, 2, [1, 1, 0, 1])],
    ["family 1 with two uncoupled streams", mappedHead(1, 2, [2, 0, 0, 1])],
    ["family 255 with a silent channel", mappedHead(255, 3, [1, 0, 0, 255, 0])],
  ])("sends %s as is", (_name, head) => {
    expect(isOggOpus(firstPage(head))).toBe(true);
  });
  it.each([
    ["family 0 with three channels", mappedHead(0, 3)],
    ["family 1 with no mapping table in a 19-byte header", mappedHead(1, 2)],
    ["family 1 with a mapping table one byte short", mappedHead(1, 2, [1, 1, 0])],
    ["family 1 with zero streams", mappedHead(1, 1, [0, 0, 0])],
    ["family 1 with more coupled streams than streams", mappedHead(1, 2, [1, 2, 0, 1])],
    ["family 1 with a mapping entry past the decoded channels", mappedHead(1, 2, [1, 0, 0, 1])],
    ["family 1 with zero channels", mappedHead(1, 0, [1, 0])],
  ])("converts %s instead of sending it as is", (_name, head) => {
    expect(isOggOpus(firstPage(head))).toBe(false);
    // Still an Ogg stream, so send-voice converts it with ffmpeg rather than refusing it.
    expect(audioDemuxer(firstPage(head))).toBe("ogg");
  });
});

describe("local path forms", () => {
  it.each(["~/voice.ogg", "./voice.ogg", "../voice.ogg", "file:///srv/telegram/outbox/voice.ogg", "FILE:/srv/x.ogg"])("refuses %s as not absolute", (media) => {
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", work);
    expect(() => localPath(media)).toThrow("Local paths must be absolute and inside TELEGRAM_UPLOAD_ROOTS");
  });
  it.each(["photos/a.jpg", "a\\b.jpg", "  /tmp/a.jpg", "tmp/a.jpg", " AgACAgIAAxkBAAIB", "AgACAgIAAxkBAAIB\n", "AgACAgIAAxkBAAIB\t"])("refuses %j, which is not a file_id", (media) => {
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", work);
    expect(() => localPath(media)).toThrow(`Local paths must be absolute and inside TELEGRAM_UPLOAD_ROOTS; got ${media}`);
  });
  it.each([undefined, "", delimiter, `${delimiter}${delimiter}`])("refuses relative and file: forms without naming the roots when TELEGRAM_UPLOAD_ROOTS is %j", (roots) => {
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", roots);
    for (const media of ["~/voice.ogg", "./voice.ogg", "../voice.ogg", "file:///srv/telegram/outbox/voice.ogg", "FILE:/srv/x.ogg", "photos/a.jpg", "a\\b.jpg", "  /tmp/a.jpg", " AgACAgIAAxkBAAIB"]) {
      expect(() => localPath(media)).toThrow(new Error(`Local paths must be absolute; got ${media}`));
    }
  });
  it("passes file_ids made of letters, digits, _ and - through", () => {
    expect(localPath("AgACAgIAAxkBAAIB-x_9")).toBeUndefined();
    expect(localPath("CAACAgIAAxkBAAIBZ2Z")).toBeUndefined();
  });
  it("refuses a NUL byte", () => {
    expect(() => localPath("/srv/telegram/outbox/a\0b.jpg")).toThrow("Local path contains a NUL byte");
  });
  it("still passes file_ids and URLs through", () => {
    expect(localPath("AgACAgIAAxkBAAIB")).toBeUndefined();
    expect(localPath("https://example.com/a.jpg")).toBeUndefined();
  });
  it("explains when no configured upload root exists", async () => {
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", [join(work, "missing-a"), join(work, "missing-b")].join(delimiter));
    const uploads = new UploadBatch();
    await expect(uploads.open(join(work, "missing-a", "a.jpg"), 1024)).rejects.toThrow("Local file upload is unavailable because none of the TELEGRAM_UPLOAD_ROOTS directories exist");
  });
});

describe("voice file names", () => {
  it("always ends a converted voice file name in .ogg", () => {
    expect(voiceFilename("memo.mp3")).toBe("memo.ogg");
    expect(voiceFilename("memo")).toBe("memo.ogg");
    expect(voiceFilename("memo.ogg")).toBe("memo.ogg");
  });
});

describe("ffmpeg runner errors", () => {
  function fakeFfmpeg(script: string) {
    const bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, "ffmpeg"), 0o755);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
  }
  it("reports output past maxBuffer as such, not as a timeout", async () => {
    fakeFfmpeg("yes 0123456789 | head -c 2000000 >&2");
    const error = await runFfmpeg([], 10_000).catch(error => error);
    expect(String(error)).toContain("ffmpeg wrote more than 1.0 MB (1048576 bytes) of output and was stopped before converting the audio");
    expect(String(error)).not.toContain("did not finish");
  });
  it("reports a timeout", async () => {
    fakeFfmpeg("sleep 5");
    const error = await runFfmpeg([], 200).catch(error => error);
    expect(String(error)).toContain("ffmpeg did not finish converting the audio within 0.2 s");
  });
});

describe("caption counting", () => {
  it("counts UTF-16 code units in one helper", () => {
    expect(captionLength("abc")).toBe(3);
    expect(captionLength("\u{1F600}")).toBe(2);
  });
  it("is used by every caption limit check in the tools", () => {
    const dir = join(__dirname, "..", "src", "tools");
    for (const name of readdirSync(dir)) {
      const source = readFileSync(join(dir, name), "utf8");
      for (const line of source.split("\n").filter(line => line.includes("TELEGRAM_CAPTION_LIMIT") && line.includes(">"))) {
        expect(line).toContain("captionLength(");
      }
    }
  });
});

describe("token redaction at the transport", () => {
  const token = "424242:transport_secret";

  it("removes the token from SDK input validation errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await startServer(token, serverTransport);
    const client = new Client({ name: "test", version: "1" });
    const received: string[] = [];
    const onmessage = (message: JSONRPCMessage) => { received.push(JSON.stringify(message)); };
    await client.connect(clientTransport);
    const original = clientTransport.onmessage!;
    clientTransport.onmessage = (message, extra) => { onmessage(message); original(message, extra); };
    const result = await client.callTool({ name: "send-message", arguments: { chatId: "1", text: "hi", parseMode: token } }).catch(error => error);
    await client.close();
    const all = [...received, JSON.stringify(result), String(result)].join("\n");
    expect(all).toContain("[REDACTED]");
    expect(all).not.toContain(token);
    expect(all).not.toContain("transport_secret");
  });
  it("replaces only the literal token and leaves other bot-like text alone", async () => {
    const sent: JSONRPCMessage[] = [];
    const transport = { send: async (message: JSONRPCMessage) => { sent.push(message); } } as unknown as Transport;
    redactTransport(transport, token);
    await transport.send({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: `bot${token} and bot999:other_value` }] } } as JSONRPCMessage);
    expect(JSON.stringify(sent[0])).toContain("bot[REDACTED] and bot999:other_value");
  });
});

describe("--help", () => {
  it("lists the media input forms and the local path rule", () => {
    const help = spawnSync(process.execPath, [join(__dirname, "..", ".build", "cli.js"), "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Media tools accept three forms of input");
    expect(help.stdout).toContain("a Telegram file_id");
    expect(help.stdout).toContain("an http(s) URL");
    const text = help.stdout.replace(/\s+/g, " ");
    expect(text).toContain("a local file path, which must be absolute; when TELEGRAM_UPLOAD_ROOTS lists at least one directory, it must also be inside one of them (both the path as given and the file it resolves to)");
    expect(text).toContain("uploads are restricted to when it lists at least one directory; unset, empty, or only separators allows any local file the server can read");
    expect(help.stdout).toContain("Video notes are the exception: they take a file_id or a local path, not a URL.");
  });
  it("matches the README on video notes and on who may write to the configured directories", () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8").replace(/\s+/g, " ");
    expect(readme).toContain("`videoNote` is the exception: it takes a `file_id` or a local path, because Telegram does not accept video notes by URL.");
    expect(readme).toContain("When `TELEGRAM_UPLOAD_ROOTS` lists directories, the same applies to those directories and the directories inside them.");
  });
  it("describes both upload modes, root entries and the process environment the same way in the README", () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8").replace(/\s+/g, " ");
    expect(readme).toContain("When `TELEGRAM_UPLOAD_ROOTS` lists at least one directory, the file must also be inside one of them");
    expect(readme).toContain("Empty entries in the list are ignored, and any other entry that is not an absolute path makes every local upload fail.");
    expect(readme).toContain("When it is unset, empty, or only separators, a caller can send any file the server account can read");
    expect(readme).toContain("That includes the server's own process environment, which holds the bot token (for example `/proc/self/environ` on Linux).");
    expect(readme).toContain("When it lists at least one directory, local media uploads are restricted to those directories; when it is unset, empty, or only separators, a caller can send any file the server account can read.");
    expect(readme).not.toMatch(/TELEGRAM_UPLOAD_ROOTS` (is set|when it is set)|Unset or empty lets/);
  });
});
