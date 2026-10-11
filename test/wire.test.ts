import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Telegraf } from "telegraf";
import { registerAllTools } from "../src/tools";
import { openVerified, UploadBatch } from "../src/uploads";

const token = "123456:wire_token";

// Seams around realpath and open, so a test can change the file system at an exact point
// between the checks the upload code runs and the open that follows them.
const fsHooks = vi.hoisted(() => ({
  afterRealpath: undefined as ((path: string) => void) | undefined,
  beforeOpen: undefined as ((path: string) => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const result = await actual.realpath(...args);
      fsHooks.afterRealpath?.(String(args[0]));
      return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      fsHooks.beforeOpen?.(String(args[0]));
      return actual.open(...args);
    },
  };
});

interface Part { name: string; filename?: string; value: string }
interface Request { method: string; type: string; fields: Map<string, Part>; complete: boolean }

/** Splits a multipart/form-data body into named parts. */
function parseMultipart(body: Buffer, type: string): Map<string, Part> {
  const boundary = /boundary=([^;]+)/.exec(type)?.[1];
  const parts = new Map<string, Part>();
  if (!boundary) return parts;
  for (const chunk of body.toString("latin1").split(`--${boundary}`)) {
    const split = chunk.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const headers = chunk.slice(0, split);
    const name = /name="([^"]*)"/.exec(headers)?.[1];
    if (!name) continue;
    parts.set(name, { name, filename: /filename="([^"]*)"/.exec(headers)?.[1], value: chunk.slice(split + 4).replace(/\r\n$/, "") });
  }
  return parts;
}

let http: Server;
let apiRoot: string;
let requests: Request[];
let work: string;
let server: McpServer;
let client: Client;
let nextId = 1;

function message() {
  return { chat: { id: 1 }, message_id: nextId++, date: 1000, document: { file_id: "f", file_unique_id: "u" }, voice: { file_id: "f", file_unique_id: "u" } };
}
function put(name: string, content: string | Buffer) {
  const path = join(work, name);
  writeFileSync(path, content);
  return path;
}
/**
 * Records every FileHandle the upload code stats after opening it. Returns a check that at least
 * one handle was opened and that each one has been closed (a closed FileHandle reports fd -1).
 */
async function trackHandles() {
  const probe = await open(put("probe", ""), "r");
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const stat = vi.spyOn(prototype, "stat");
  return () => {
    const handles = stat.mock.contexts as FileHandle[];
    expect(handles.length).toBeGreaterThan(0);
    expect(handles.map(handle => handle.fd)).toEqual(handles.map(() => -1));
  };
}
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, text: (result.content as { text: string }[])[0].text };
}

const opusFile = (() => {
  const head = Buffer.concat([Buffer.from("OpusHead", "latin1"), Buffer.from([1, 1, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0])]);
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "latin1");
  header[5] = 2;
  header[26] = 1;
  return Buffer.concat([header, Buffer.from([head.length]), head]);
})();

beforeAll(async () => {
  http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    const entry: Request = { method: (req.url ?? "").split("/").pop() ?? "", type: String(req.headers["content-type"]), fields: new Map(), complete: false };
    requests.push(entry);
    req.on("data", data => chunks.push(data));
    req.on("error", () => {});
    req.on("end", () => {
      entry.complete = true;
      const body = Buffer.concat(chunks);
      if (entry.type.startsWith("multipart/form-data")) entry.fields = parseMultipart(body, entry.type);
      else for (const [name, value] of Object.entries(JSON.parse(body.toString() || "{}"))) entry.fields.set(name, { name, value: typeof value === "string" ? value : JSON.stringify(value) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: entry.method === "sendMediaGroup" ? [message(), message()] : message() }));
    });
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  apiRoot = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  http.closeAllConnections();
  await new Promise(resolve => http.close(resolve));
});

beforeEach(async () => {
  requests = [];
  fsHooks.afterRealpath = undefined;
  fsHooks.beforeOpen = undefined;
  work = realpathSync(mkdtempSync(join(tmpdir(), "telegram-wire-test-")));
  vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", work);
  vi.spyOn(console, "error").mockImplementation(() => {});
  server = new McpServer({ name: "test", version: "1" });
  registerAllTools(server, new Telegraf(token, { telegram: { apiRoot } }));
  client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});
afterEach(async () => {
  await client.close();
  await server.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});

const reply = { message_id: 7, allow_sending_without_reply: true };

describe("multipart requests keep reply_parameters", () => {
  it("send-document with a local file", async () => {
    const result = await call("send-document", { chatId: "1", media: put("report.pdf", "%PDF-1.4"), caption: "Report", replyToMessageId: 7 });
    expect(result.isError).toBe(false);
    const [request] = requests;
    expect(request.type).toMatch(/^multipart\/form-data/);
    expect(JSON.parse(request.fields.get("reply_parameters")!.value)).toEqual(reply);
    expect(request.fields.get("document")).toMatchObject({ filename: "report.pdf", value: "%PDF-1.4" });
  });
  it("send-media-group with local items", async () => {
    const result = await call("send-media-group", {
      chatId: "1",
      media: [{ type: "document", media: put("one.pdf", "first") }, { type: "document", media: put("two.pdf", "second") }],
      replyToMessageId: 7,
    });
    expect(result.isError).toBe(false);
    const [request] = requests;
    expect(request.type).toMatch(/^multipart\/form-data/);
    expect(JSON.parse(request.fields.get("reply_parameters")!.value)).toEqual(reply);
    expect([...request.fields.values()].filter(part => part.filename).map(part => part.value).sort()).toEqual(["first", "second"]);
  });
  it("send-voice with a local file", async () => {
    const result = await call("send-voice", { chatId: "1", media: put("note.ogg", opusFile), replyToMessageId: 7 });
    expect(result.isError).toBe(false);
    const [request] = requests;
    expect(request.type).toMatch(/^multipart\/form-data/);
    expect(JSON.parse(request.fields.get("reply_parameters")!.value)).toEqual(reply);
    expect(request.fields.get("voice")?.filename).toBe("note.ogg");
  });
  it("leaves JSON requests for file_id and URL media unchanged", async () => {
    await call("send-document", { chatId: "1", media: "BQACAgIAAxkBAAIC", replyToMessageId: 7 });
    const [request] = requests;
    expect(request.type).toMatch(/^application\/json/);
    expect(JSON.parse(request.fields.get("reply_parameters")!.value)).toEqual(reply);
  });
});

describe("local uploads read from the verified descriptor", () => {
  it("uploads the file that was opened, not one swapped in at the path afterwards", async () => {
    const path = put("photo.jpg", "original");
    const replacement = put("replacement.jpg", "swapped in");
    const uploads = new UploadBatch();
    try {
      const file = (await uploads.open(path, 1024))!;
      renameSync(replacement, path);
      const telegram = uploads.telegram(new Telegraf(token, { telegram: { apiRoot } }).telegram);
      await uploads.run(() => telegram.sendDocument("1", uploads.upload(file, 1024, "photo.jpg")));
    } finally {
      await uploads.close();
    }
    expect(requests[0].fields.get("document")?.value).toBe("original");
  });
  it("refuses a descriptor that is not the file whose realpath was checked", async () => {
    const path = put("photo.jpg", "original");
    const checked = statSync(path, { bigint: true });
    renameSync(put("other.jpg", "other"), path);
    await expect(openVerified(path, checked, 1024)).rejects.toThrow("changed while it was being opened");
    // A symlink swapped in at the checked realpath is not followed.
    rmSync(path);
    symlinkSync(put("target.jpg", "target"), path);
    await expect(openVerified(path, checked, 1024)).rejects.toThrow("changed while it was being opened");
  });
  it("aborts the request when the file grows past the limit during the upload", async () => {
    const path = put("grow.bin", "0123456789");
    const allClosed = await trackHandles();
    const uploads = new UploadBatch();
    let failure: unknown;
    try {
      const file = (await uploads.open(path, 16))!;
      appendFileSync(path, Buffer.alloc(1024 * 1024, "G"));
      const telegram = uploads.telegram(new Telegraf(token, { telegram: { apiRoot } }).telegram);
      await uploads.run(() => telegram.sendDocument("1", uploads.upload(file, 16, "grow.bin")));
    } catch (error) {
      failure = error;
    } finally {
      await uploads.close();
    }
    expect(String(failure)).toContain("grew past the 0.0 MB (16 bytes) upload limit while it was being uploaded");
    // No request that reached the server carried the appended bytes.
    expect(requests.filter(request => request.complete && [...request.fields.values()].some(part => part.value.includes("G")))).toEqual([]);
    allClosed();
  }, 10_000);
  it("closes the descriptors of earlier media group items when a later item fails", async () => {
    const first = put("one.pdf", "first");
    const allClosed = await trackHandles();
    const result = await call("send-media-group", { chatId: "1", media: [{ type: "document", media: first }, { type: "document", media: join(work, "missing.pdf") }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Local file not found");
    // The request the previous test aborted can reach the server late, so only this call's method is checked.
    expect(requests.filter(request => request.method === "sendMediaGroup")).toEqual([]);
    allClosed();
  });
  it("closes descriptors after successful uploads", async () => {
    const allClosed = await trackHandles();
    expect((await call("send-document", { chatId: "1", media: put("a.pdf", "a") })).isError).toBe(false);
    expect((await call("send-voice", { chatId: "1", media: put("b.ogg", opusFile) })).isError).toBe(false);
    allClosed();
  });
  it("closes the descriptor when the file fails the checks after opening", async () => {
    const allClosed = await trackHandles();
    const path = put("photo.jpg", "original");
    const checked = statSync(path, { bigint: true });
    renameSync(put("other.jpg", "other"), path);
    await expect(openVerified(path, checked, 1024)).rejects.toThrow("changed while it was being opened");
    allClosed();
  });
});

describe("an intermediate directory replaced by a symlink while a local file is opened", () => {
  it.each(["afterRealpath", "beforeOpen"] as const)("refuses the upload when the swap happens at %s", async (moment) => {
    const root = join(work, "root");
    const outside = join(work, "outside");
    mkdirSync(join(root, "dir"), { recursive: true });
    mkdirSync(outside);
    const path = join(root, "dir", "a.txt");
    writeFileSync(path, "inside");
    writeFileSync(join(outside, "a.txt"), "outside secret");
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", root);
    let swapped = false;
    fsHooks[moment] = (target) => {
      if (swapped || target !== path) return;
      swapped = true;
      // The directory the checked realpath runs through now leads outside the root.
      renameSync(join(root, "dir"), join(root, "dir-moved"));
      symlinkSync(outside, join(root, "dir"));
    };
    const allClosed = await trackHandles();
    const result = await call("send-document", { chatId: "1", media: path });
    expect(swapped).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`Local file ${path} changed while it was being opened; try again`);
    expect(requests.filter(request => [...request.fields.values()].some(part => part.value.includes("outside secret")))).toEqual([]);
    expect(requests).toEqual([]);
    allClosed();
  });
});

describe("local uploads without TELEGRAM_UPLOAD_ROOTS", () => {
  beforeEach(() => {
    vi.stubEnv("TELEGRAM_UPLOAD_ROOTS", undefined);
  });
  it("uploads the file that was opened, not one swapped in at the path afterwards", async () => {
    const path = put("photo.jpg", "original");
    const replacement = put("replacement.jpg", "swapped in");
    const uploads = new UploadBatch();
    try {
      const file = (await uploads.open(path, 1024))!;
      renameSync(replacement, path);
      const telegram = uploads.telegram(new Telegraf(token, { telegram: { apiRoot } }).telegram);
      await uploads.run(() => telegram.sendDocument("1", uploads.upload(file, 1024, "photo.jpg")));
    } finally {
      await uploads.close();
    }
    expect(requests[0].fields.get("document")?.value).toBe("original");
  });
  it("refuses a file replaced between the checks and the open", async () => {
    const path = put("photo.jpg", "original");
    const other = put("other.jpg", "other");
    let swapped = false;
    fsHooks.beforeOpen = (target) => {
      if (swapped || target !== path) return;
      swapped = true;
      renameSync(other, path);
    };
    const allClosed = await trackHandles();
    const result = await call("send-document", { chatId: "1", media: path });
    expect(swapped).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`Local file ${path} changed while it was being opened; try again`);
    expect(requests).toEqual([]);
    allClosed();
  });
  it.each(["afterRealpath", "beforeOpen"] as const)("refuses the upload when an intermediate directory is replaced by a symlink at %s", async (moment) => {
    const parent = join(work, "parent");
    const elsewhere = join(work, "elsewhere");
    mkdirSync(join(parent, "dir"), { recursive: true });
    mkdirSync(elsewhere);
    const path = join(parent, "dir", "a.txt");
    writeFileSync(path, "checked");
    writeFileSync(join(elsewhere, "a.txt"), "never checked");
    let swapped = false;
    fsHooks[moment] = (target) => {
      if (swapped || target !== path) return;
      swapped = true;
      renameSync(join(parent, "dir"), join(parent, "dir-moved"));
      symlinkSync(elsewhere, join(parent, "dir"));
    };
    const allClosed = await trackHandles();
    const result = await call("send-document", { chatId: "1", media: path });
    expect(swapped).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`Local file ${path} changed while it was being opened; try again`);
    expect(requests).toEqual([]);
    allClosed();
  });
  it("aborts the request when the file grows past the limit during the upload", async () => {
    const path = put("grow.bin", "0123456789");
    const allClosed = await trackHandles();
    const uploads = new UploadBatch();
    let failure: unknown;
    try {
      const file = (await uploads.open(path, 16))!;
      appendFileSync(path, Buffer.alloc(1024 * 1024, "G"));
      const telegram = uploads.telegram(new Telegraf(token, { telegram: { apiRoot } }).telegram);
      await uploads.run(() => telegram.sendDocument("1", uploads.upload(file, 16, "grow.bin")));
    } catch (error) {
      failure = error;
    } finally {
      await uploads.close();
    }
    expect(String(failure)).toContain("grew past the 0.0 MB (16 bytes) upload limit while it was being uploaded");
    expect(requests.filter(request => request.complete && [...request.fields.values()].some(part => part.value.includes("G")))).toEqual([]);
    allClosed();
  }, 10_000);
});
