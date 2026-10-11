import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { format } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Telegraf } from "telegraf";
import { registerAllTools } from "../src/tools";
import { DOWNLOAD_LIMIT, DOWNLOAD_TIMEOUTS, downloadFile, downloadName } from "../src/downloads";

// Seams around the file system calls of the download code: a test can change the directory right
// before or after a file is opened, make link or rm fail, and see which files were written to.
const fsHooks = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: string) => void) | undefined,
  afterOpen: undefined as ((path: string) => void) | undefined,
  linkError: undefined as string | undefined,
  rmFails: undefined as ((path: string) => boolean) | undefined,
  writes: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      fsHooks.beforeOpen?.(path);
      const handle = await actual.open(...args);
      const write = handle.write.bind(handle) as (...rest: unknown[]) => unknown;
      Object.assign(handle, { write: (...rest: unknown[]) => { fsHooks.writes.push(path); return write(...rest); } });
      fsHooks.afterOpen?.(path);
      return handle;
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (fsHooks.linkError) throw Object.assign(new Error(`${fsHooks.linkError}: link refused`), { code: fsHooks.linkError });
      return actual.link(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (fsHooks.rmFails?.(String(args[0]))) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      return actual.rm(...args);
    },
  };
});

const token = "123456:fake_token";
const unredacted = /(?:bot|user)\d+:(?!\[REDACTED\])/;
const chunk = Buffer.alloc(1024 * 1024, 7);

/** Streams more than the download limit, stopping once the client goes away. */
function oversized(res: ServerResponse, headers: Record<string, string | number> = {}) {
  res.writeHead(200, { "Content-Type": "video/mp4", ...headers });
  res.on("error", () => {});
  let sent = 0;
  let closed = false;
  res.on("close", () => { closed = true; });
  const pump = () => {
    while (!closed && sent < DOWNLOAD_LIMIT + 5 * chunk.length) {
      sent += chunk.length;
      if (!res.write(chunk)) return void res.once("drain", pump);
    }
    if (!closed) res.end();
  };
  pump();
}

// Each fake file has getFile metadata and an optional body served under its basename.
const files: Record<string, { meta: Record<string, unknown>; body?: (res: ServerResponse) => void; getFileDelayMs?: number }> = {
  // getFile answers only after a delay; the body itself is immediate.
  slow: {
    meta: { file_id: "slow", file_unique_id: "AgADslow", file_size: 4, file_path: "documents/slow.txt" },
    body: res => { res.writeHead(200); res.end("slow"); },
    getFileDelayMs: 1_500,
  },
  doc: {
    meta: { file_id: "doc", file_unique_id: "AgADdoc", file_size: 11, file_path: "documents/report.pdf" },
    body: res => { res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": 11 }); res.end("hello world"); },
  },
  huge: {
    meta: { file_id: "huge", file_unique_id: "AgADhuge", file_size: DOWNLOAD_LIMIT + 1, file_path: "videos/huge.mp4" },
    body: res => oversized(res),
  },
  stream: {
    meta: { file_id: "stream", file_unique_id: "AgADstream", file_path: "videos/stream.mp4" },
    body: res => oversized(res),
  },
  declared: {
    meta: { file_id: "declared", file_unique_id: "AgADdeclared", file_size: 10, file_path: "videos/declared.mp4" },
    body: res => oversized(res, { "Content-Length": DOWNLOAD_LIMIT + 5 * chunk.length }),
  },
  escape: {
    meta: { file_id: "escape", file_unique_id: "AgADescape", file_size: 6, file_path: "../../../outside.txt" },
    body: res => { res.writeHead(200); res.end("escape"); },
  },
  backslash: {
    meta: { file_id: "backslash", file_unique_id: "AgADback", file_size: 4, file_path: "..\\..\\evil.txt" },
    body: res => { res.writeHead(200); res.end("evil"); },
  },
  broken: {
    meta: { file_id: "broken", file_unique_id: "AgADbroken", file_size: 4, file_path: "documents/broken.bin" },
    body: res => { res.writeHead(500); res.end("upstream failure"); },
  },
  local: {
    meta: { file_id: "local", file_unique_id: "AgADlocal", file_size: 4, file_path: "/srv/telegram-bot-api/documents/local.pdf" },
  },
  long: {
    meta: { file_id: "long", file_unique_id: "AgADlong", file_size: 4, file_path: `documents/${"n".repeat(250)}.pdf` },
    body: res => { res.writeHead(200); res.end("long"); },
  },
  // Sends a few bytes, then nothing, keeping the connection open.
  stall: {
    meta: { file_id: "stall", file_unique_id: "AgADstall", file_path: "videos/stall.mp4" },
    body: res => { res.writeHead(200); res.write("partial"); },
  },
  // Keeps sending a byte every 20 ms, so it never idles but never finishes either.
  trickle: {
    meta: { file_id: "trickle", file_unique_id: "AgADtrickle", file_path: "videos/trickle.mp4" },
    body: res => {
      res.writeHead(200);
      const timer = setInterval(() => res.write("x"), 20);
      res.on("close", () => clearInterval(timer));
    },
  },
  // Runs the test's hook before finishing the body, so a test can change the directory mid-download.
  hooked: {
    meta: { file_id: "hooked", file_unique_id: "AgADhooked", file_size: 6, file_path: "documents/hooked.txt" },
    body: res => {
      res.writeHead(200);
      res.write("hoo");
      Promise.resolve(beforeBodyEnd?.()).then(() => res.end("ked"));
    },
  },
};
let beforeBodyEnd: (() => void | Promise<void>) | undefined;

let http: Server;
let apiRoot: string;
let requests: string[];
let work: string;
let inbox: string;
let stderr: string[];
let outputs: string[];
let server: McpServer;
let client: Client;

async function download(fileId: string) {
  const result = await client.callTool({ name: "download-file", arguments: { fileId } });
  const text = (result.content as { text: string }[])[0].text;
  outputs.push(text);
  return { isError: result.isError === true, text };
}

beforeAll(async () => {
  http = createServer((req, res) => {
    requests.push(req.url ?? "");
    let raw = "";
    req.on("data", data => { raw += data; });
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === `/bot${token}/getFile`) {
        const entry = files[JSON.parse(raw).file_id];
        const respond = () => {
          if (res.destroyed) return;
          res.writeHead(entry ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(entry ? { ok: true, result: entry.meta } : { ok: false, error_code: 400, description: "Bad Request: invalid file_id" }));
        };
        if (entry?.getFileDelayMs) setTimeout(respond, entry.getFileDelayMs);
        else respond();
        return;
      }
      const entry = Object.values(files).find(file => posix.basename(String(file.meta.file_path).replaceAll("\\", "/")) === posix.basename(path));
      if (entry?.body) entry.body(res);
      else { res.writeHead(404); res.end(); }
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
  beforeBodyEnd = undefined;
  fsHooks.beforeOpen = undefined;
  fsHooks.afterOpen = undefined;
  fsHooks.linkError = undefined;
  fsHooks.rmFails = undefined;
  fsHooks.writes = [];
  requests = [];
  outputs = [];
  stderr = [];
  work = realpathSync(mkdtempSync(join(tmpdir(), "telegram-download-test-")));
  inbox = join(work, "inbox");
  vi.stubEnv("TELEGRAM_DOWNLOAD_DIR", inbox);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { stderr.push(format(...args)); });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; });
  server = new McpServer({ name: "test", version: "1" });
  registerAllTools(server, new Telegraf(token, { telegram: { apiRoot } }));
  client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});
afterEach(async () => {
  await client.close();
  await server.close();
  // No tool result or stderr line may carry the bot token or the token-bearing file URL.
  for (const text of [...outputs, ...stderr]) {
    expect(text).not.toContain(token);
    expect(text).not.toContain("fake_token");
    expect(text).not.toMatch(unredacted);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});

it("saves the file inside the download directory and reports path, size and mime", async () => {
  const { isError, text } = await download("doc");
  expect(isError).toBe(false);
  const target = join(inbox, "AgADdoc-report.pdf");
  expect(JSON.parse(text)).toEqual({ path: target, size: 11, mime: "application/pdf", file_id: "doc", file_unique_id: "AgADdoc" });
  expect(readFileSync(target, "utf8")).toBe("hello world");
  expect(readdirSync(inbox)).toEqual(["AgADdoc-report.pdf"]);
  expect(requests).toContain(`/file/bot${token}/documents/report.pdf`);
});

it("refuses when TELEGRAM_DOWNLOAD_DIR is unset", async () => {
  vi.stubEnv("TELEGRAM_DOWNLOAD_DIR", undefined);
  const { isError, text } = await download("doc");
  expect(isError).toBe(true);
  expect(text).toContain("download-file is disabled because TELEGRAM_DOWNLOAD_DIR is not set");
  expect(requests).toEqual([]);
});

it("refuses a file whose reported size exceeds 20 MB without downloading it", async () => {
  const { isError, text } = await download("huge");
  expect(isError).toBe(true);
  expect(text).toContain("bots can download files of up to 20.0 MB (20971520 bytes)");
  expect(requests.some(url => url.includes("huge.mp4"))).toBe(false);
  expect(readdirSync(inbox)).toEqual([]);
});

it.each(["stream", "declared"])("aborts a %s body past 20 MB and leaves no partial file", async (fileId) => {
  const { isError, text } = await download(fileId);
  expect(isError).toBe(true);
  expect(text).toContain("Download exceeded the 20.0 MB (20971520 bytes) limit and was aborted");
  expect(readdirSync(inbox)).toEqual([]);
});

it.each([
  ["escape", "AgADescape-outside.txt", "escape"],
  ["backslash", "AgADback-.._.._evil.txt", "evil"],
])("keeps a %s file_path inside the download directory", async (fileId, name, content) => {
  const { isError, text } = await download(fileId);
  expect(isError).toBe(false);
  expect(JSON.parse(text).path).toBe(join(inbox, name));
  expect(readdirSync(inbox)).toEqual([name]);
  expect(readFileSync(join(inbox, name), "utf8")).toBe(content);
  expect(existsSync(join(work, "outside.txt"))).toBe(false);
  expect(existsSync(join(work, "evil.txt"))).toBe(false);
});

it("reports HTTP and Telegram failures without leaking the token", async () => {
  const broken = await download("broken");
  expect(broken.isError).toBe(true);
  expect(broken.text).toContain("Downloading the file failed with HTTP 500");
  expect(readdirSync(inbox)).toEqual([]);

  const missing = await download("missing");
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain("invalid file_id");
  expect(stderr.join("\n")).toContain("download-file");
});

it("refuses a file: link from a local Bot API server without reading the path", async () => {
  const { isError, text } = await download("local");
  expect(isError).toBe(true);
  expect(text).toContain("Files stored on a local Bot API server are not supported by download-file");
  expect(requests.filter(url => !url.endsWith("/getFile"))).toEqual([]);
  expect(readdirSync(inbox)).toEqual([]);
});

it("never overwrites an existing file and returns the numbered name it wrote", async () => {
  mkdirSync(inbox);
  writeFileSync(join(inbox, "AgADdoc-report.pdf"), "older file");
  const first = await download("doc");
  expect(first.isError).toBe(false);
  expect(JSON.parse(first.text).path).toBe(join(inbox, "AgADdoc-report-1.pdf"));
  const second = await download("doc");
  expect(JSON.parse(second.text).path).toBe(join(inbox, "AgADdoc-report-2.pdf"));
  expect(readFileSync(join(inbox, "AgADdoc-report.pdf"), "utf8")).toBe("older file");
  expect(readFileSync(join(inbox, "AgADdoc-report-1.pdf"), "utf8")).toBe("hello world");
  expect(readdirSync(inbox).sort()).toEqual(["AgADdoc-report-1.pdf", "AgADdoc-report-2.pdf", "AgADdoc-report.pdf"]);
});

it("does not write through a symlink planted at the target name", async () => {
  mkdirSync(inbox);
  const victim = join(work, "victim.txt");
  writeFileSync(victim, "keep me");
  symlinkSync(victim, join(inbox, "AgADdoc-report.pdf"));
  const { isError, text } = await download("doc");
  expect(isError).toBe(false);
  expect(JSON.parse(text).path).toBe(join(inbox, "AgADdoc-report-1.pdf"));
  expect(readFileSync(victim, "utf8")).toBe("keep me");
});

it("gives up after a bounded number of numbered names", async () => {
  mkdirSync(inbox);
  writeFileSync(join(inbox, "AgADdoc-report.pdf"), "");
  for (let index = 1; index <= 100; index++) writeFileSync(join(inbox, `AgADdoc-report-${index}.pdf`), "");
  const { isError, text } = await download("doc");
  expect(isError).toBe(true);
  expect(text).toContain("AgADdoc-report.pdf and 100 numbered alternatives already exist in TELEGRAM_DOWNLOAD_DIR");
  expect(readdirSync(inbox).filter(name => name.endsWith(".part"))).toEqual([]);
});

it("discards the download when TELEGRAM_DOWNLOAD_DIR is replaced while it is being saved", async () => {
  mkdirSync(inbox);
  const moved = join(work, "inbox-moved");
  const decoy = join(work, "decoy");
  mkdirSync(decoy);
  beforeBodyEnd = async () => {
    // Wait until the temporary file exists, then move the directory and plant a symlink in its place.
    for (let i = 0; i < 200 && !readdirSync(inbox).some(name => name.endsWith(".part")); i++) await new Promise(resolve => setTimeout(resolve, 5));
    renameSync(inbox, moved);
    symlinkSync(decoy, inbox);
  };
  const { isError, text } = await download("hooked");
  expect(isError).toBe(true);
  expect(text).toContain("TELEGRAM_DOWNLOAD_DIR changed while the file was being saved, so the download was discarded");
  expect(readdirSync(decoy)).toEqual([]);
  // The moved directory keeps no published file and no data in the temporary file.
  const left = readdirSync(moved);
  expect(left.filter(name => !name.endsWith(".part"))).toEqual([]);
  for (const name of left) expect(readFileSync(join(moved, name))).toHaveLength(0);
});

it("keeps the extension when a long name is cut and derives the mime type from it", async () => {
  const name = downloadName("AgADlong", `documents/${"n".repeat(250)}.pdf`);
  expect(name).toHaveLength(200);
  expect(name.endsWith(".pdf")).toBe(true);
  const { isError, text } = await download("long");
  expect(isError).toBe(false);
  const result = JSON.parse(text);
  expect(result.path).toBe(join(inbox, name));
  expect(result.mime).toBe("application/pdf");
  expect(downloadName("AgADx", `a.${"e".repeat(40)}`)).toBe("AgADx-a." + "e".repeat(40));
  expect(downloadName("AgADx", `${"a".repeat(300)}.${"e".repeat(40)}`)).toHaveLength(200);
});

it("keeps a long extension whenever it fits after the file_unique_id and one stem character", () => {
  const extension = `.${"e".repeat(40)}`;
  const kept = downloadName("AgADx", `${"a".repeat(300)}${extension}`);
  expect(kept).toHaveLength(200);
  expect(kept).toBe(`AgADx-${"a".repeat(200 - 6 - extension.length)}${extension}`);
  // "AgADx-" + one stem character + a 193-character extension is exactly 200.
  const widest = `.${"e".repeat(192)}`;
  expect(downloadName("AgADx", `${"a".repeat(300)}${widest}`)).toBe(`AgADx-a${widest}`);
  // One character more and the name is cut as is, without the extension.
  const tooWide = `.${"e".repeat(193)}`;
  expect(downloadName("AgADx", `${"a".repeat(300)}${tooWide}`)).toBe(`AgADx-${"a".repeat(194)}`);
});

it("discards the download when TELEGRAM_DOWNLOAD_DIR is replaced before the temporary file is created", async () => {
  mkdirSync(inbox);
  const moved = join(work, "inbox-moved");
  const decoy = join(work, "decoy");
  mkdirSync(decoy);
  let swapped = false;
  fsHooks.beforeOpen = (path) => {
    if (swapped || !path.endsWith(".part")) return;
    swapped = true;
    renameSync(inbox, moved);
    symlinkSync(decoy, inbox);
  };
  const { isError, text } = await download("doc");
  expect(swapped).toBe(true);
  expect(isError).toBe(true);
  expect(text).toContain("TELEGRAM_DOWNLOAD_DIR changed while the file was being saved, so the download was discarded");
  // Not a byte reached the temporary file, and the file this call created in the decoy is gone.
  expect(fsHooks.writes).toEqual([]);
  expect(readdirSync(decoy)).toEqual([]);
  expect(readdirSync(moved)).toEqual([]);
});

it("discards the download and keeps a file that replaced the temporary name before writing", async () => {
  let replaced: string | undefined;
  fsHooks.afterOpen = (path) => {
    if (replaced || !path.endsWith(".part")) return;
    replaced = path;
    renameSync(path, join(work, "taken.part"));
    writeFileSync(path, "not ours");
  };
  const { isError, text } = await download("doc");
  expect(isError).toBe(true);
  expect(text).toContain("TELEGRAM_DOWNLOAD_DIR changed while the file was being saved, so the download was discarded");
  expect(fsHooks.writes).toEqual([]);
  // Only what this call created is removed; the file now at the temporary name is left alone.
  expect(readFileSync(replaced!, "utf8")).toBe("not ours");
  expect(readdirSync(inbox).filter(name => !name.endsWith(".part"))).toEqual([]);
});

it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"])("copies the file under a free numbered name when link fails with %s", async (code) => {
  mkdirSync(inbox);
  writeFileSync(join(inbox, "AgADdoc-report.pdf"), "older file");
  const victim = join(work, "victim.txt");
  writeFileSync(victim, "keep me");
  symlinkSync(victim, join(inbox, "AgADdoc-report-1.pdf"));
  fsHooks.linkError = code;
  const { isError, text } = await download("doc");
  expect(isError).toBe(false);
  const target = join(inbox, "AgADdoc-report-2.pdf");
  expect(JSON.parse(text).path).toBe(target);
  expect(lstatSync(target).isFile()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("hello world");
  expect(readFileSync(join(inbox, "AgADdoc-report.pdf"), "utf8")).toBe("older file");
  expect(readFileSync(victim, "utf8")).toBe("keep me");
  expect(readdirSync(inbox).sort()).toEqual(["AgADdoc-report-1.pdf", "AgADdoc-report-2.pdf", "AgADdoc-report.pdf"]);
});

it("reports other link failures and leaves nothing behind", async () => {
  fsHooks.linkError = "EIO";
  const { isError, text } = await download("doc");
  expect(isError).toBe(true);
  expect(text).toContain("EIO: link refused");
  expect(readdirSync(inbox)).toEqual([]);
});

it("keeps the saved file when the temporary name cannot be removed afterwards", async () => {
  fsHooks.rmFails = path => path.endsWith(".part");
  const { isError, text } = await download("doc");
  expect(isError).toBe(false);
  const target = join(inbox, "AgADdoc-report.pdf");
  expect(JSON.parse(text).path).toBe(target);
  expect(readFileSync(target, "utf8")).toBe("hello world");
});

it("uses a 30 s idle timeout and a 5 minute overall deadline by default", () => {
  expect(DOWNLOAD_TIMEOUTS).toEqual({ idleMs: 30_000, totalMs: 300_000 });
});

it("aborts a download that stops sending data and removes the partial file", async () => {
  const bot = new Telegraf(token, { telegram: { apiRoot } });
  await expect(downloadFile(bot, "stall", inbox, { idleMs: 200, totalMs: 10_000 })).rejects.toThrow("Download received no data for 0.2 s and was aborted");
  expect(readdirSync(inbox)).toEqual([]);
});

it("aborts a download that runs past the overall deadline and removes the partial file", async () => {
  const bot = new Telegraf(token, { telegram: { apiRoot } });
  await expect(downloadFile(bot, "trickle", inbox, { idleMs: 5_000, totalMs: 300 })).rejects.toThrow("Download did not finish within 0.3 s and was aborted");
  expect(readdirSync(inbox)).toEqual([]);
});

it("counts a slow getFile against the overall deadline and aborts that request", async () => {
  const bot = new Telegraf(token, { telegram: { apiRoot } });
  const started = Date.now();
  await expect(downloadFile(bot, "slow", inbox, { idleMs: 5_000, totalMs: 300 })).rejects.toThrow("Download did not finish within 0.3 s and was aborted");
  expect(Date.now() - started).toBeLessThan(1_200);
  expect(requests.filter(url => !url.endsWith("/getFile"))).toEqual([]);
  expect(readdirSync(inbox)).toEqual([]);
});
