import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { format } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Telegraf } from "telegraf";
import { registerAllTools } from "../src/tools";
import { formatErrorForMCP, logError } from "../src/utils";

const token = "123456:fake_token";
const unredacted = /(?:bot|user)\d+:(?!\[REDACTED\])/;

type Failure = (res: ServerResponse) => void;
const failures: [string, Failure][] = [
  ["a 403 HTML body", res => {
    res.writeHead(403, { "Content-Type": "text/html" });
    res.end("<html><body>Forbidden</body></html>");
  }],
  ["a body aborted mid-read", res => {
    // A chunked body cut before its terminating chunk fails while the client reads it.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"ok":true,"result":');
    setTimeout(() => res.destroy(), 20);
  }],
];
const toolCalls: [string, Record<string, unknown>][] = [
  ["send-message", { chatId: "123", text: "Hello" }],
  ["get-file", { fileId: "file" }],
  // The photo succeeds and the caption overflow fails, so the partial-delivery text is included.
  ["send-photo", { chatId: "123", media: "file", text: "x".repeat(1100) }],
];
const photoMessage = { chat: { id: 123 }, message_id: 1, date: 1000, photo: [{ file_id: "file", file_unique_id: "unique", width: 1, height: 1 }] };

let http: Server;
let apiRoot: string;
let failure: Failure;

function expectRedacted(text: string) {
  expect(text).not.toContain(token);
  expect(text).not.toContain("fake_token");
  expect(text).not.toMatch(unredacted);
}

beforeAll(async () => {
  http = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.endsWith("/sendPhoto")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: photoMessage }));
      } else failure(res);
    });
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  apiRoot = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  http.closeAllConnections();
  await new Promise(resolve => http.close(resolve));
});

describe.each(["test", "development"])("bot token redaction with NODE_ENV=%s", (nodeEnv) => {
  let server: McpServer;
  let client: Client;
  let stderr: string[];

  beforeEach(async () => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    stderr = [];
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
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe.each(failures)("on %s", (_label, respond) => {
    it.each(toolCalls)("keeps the token out of %s output and stderr", async (name, args) => {
      failure = respond;
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text: string }[])[0].text;
      expect(result.isError).toBe(true);
      expectRedacted(text);
      for (const line of stderr) expectRedacted(line);
      // The error still names the redacted request URL, so the failing path was exercised.
      expect(text).toContain("bot123456:[REDACTED]");
      expect(stderr.join("\n")).toContain("bot123456:[REDACTED]");
      if (name === "send-photo") expect(text).toContain("media was delivered");
      if (nodeEnv === "development") expect(stderr.some(line => line.includes("Original error"))).toBe(true);
    });
  });
});

it("redacts the configured token wherever it appears in error text", () => {
  const secret = "987654:literal-secret";
  vi.stubEnv("TELEGRAM_BOT_API_TOKEN", secret);
  vi.stubEnv("NODE_ENV", "development");
  const stderr: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { stderr.push(format(...args)); });
  try {
    const error = { description: `token ${secret} and user42:abc`, context: `retry with ${secret}`, originalError: new Error(`failed: ${secret}`) };
    const text = formatErrorForMCP(error);
    logError(error, "test");
    for (const output of [text, ...stderr]) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain("literal-secret");
      expect(output).not.toMatch(unredacted);
    }
    expect(text).toContain("user42:[REDACTED]");
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
