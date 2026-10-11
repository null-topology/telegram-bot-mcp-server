import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline, type Readable, Transform } from "node:stream";
import { Input, type Telegram } from "telegraf";
import type { InputFile } from "telegraf/types";

/** Telegram's multipart upload limits for bots. */
export const PHOTO_UPLOAD_LIMIT = 10 * 1024 * 1024;
export const UPLOAD_LIMIT = 50 * 1024 * 1024;

/**
 * A local file handed to Telegraf: a stream read from a verified descriptor, or the path of a
 * file this server created itself (a converted voice message).
 */
export type LocalUpload = InputFile;
export type MediaSource = string | LocalUpload;

/** A local file opened and checked against its realpath, inside the upload roots when they are set. */
export interface VerifiedFile {
  /** The path as the caller passed it, used in messages. */
  label: string;
  /** The realpath that was checked, against the roots when they are set. */
  path: string;
  handle: FileHandle;
  size: number;
}

export function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB (${bytes} bytes)`;
}

/** Keeps a file name usable inside the multipart Content-Disposition header. */
export function safeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f"\\/]/g, "_") || "file";
}

/** True when target lies strictly below root; path.relative avoids /srv/a matching /srv/ab. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Passes bytes through and fails with overflow() once more than limit bytes have passed. */
export function limitStream(limit: number, overflow: () => Error): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) callback(overflow());
      else callback(null, chunk);
    },
  });
}

function tooLarge(label: string, size: number, limit: number): Error {
  return new Error(`Local file ${label} is ${formatSize(size)}, which exceeds the ${formatSize(limit)} upload limit`);
}

function changed(label: string): Error {
  return new Error(`Local file ${label} changed while it was being opened; try again`);
}

/**
 * The TELEGRAM_UPLOAD_ROOTS entries, read on every call. Only empty entries are dropped: an entry
 * made of whitespace is kept, so it fails the absolute-path check instead of lifting the restriction.
 */
function configuredRoots(): string[] {
  return (process.env.TELEGRAM_UPLOAD_ROOTS ?? "").split(delimiter).filter(Boolean);
}

/**
 * Resolves the upload roots, or returns undefined when TELEGRAM_UPLOAD_ROOTS lists no directory
 * (unset, empty, or only delimiters): then any local file the server can read may be uploaded.
 */
async function uploadRoots(): Promise<{ lexical: string; real: string }[] | undefined> {
  const configured = configuredRoots();
  if (!configured.length) return undefined;
  const roots = [];
  for (const root of configured) {
    if (!isAbsolute(root)) throw new Error(`TELEGRAM_UPLOAD_ROOTS entries must be absolute paths: ${JSON.stringify(root)}`);
    try {
      roots.push({ lexical: resolve(root), real: await realpath(root) });
    } catch {
      // A root that does not exist cannot contain any file.
    }
  }
  if (!roots.length) {
    throw new Error(`Local file upload is unavailable because none of the TELEGRAM_UPLOAD_ROOTS directories exist: ${configured.join(delimiter)}`);
  }
  return roots;
}

/**
 * Returns the local path a media input names, or undefined for file_ids and http(s) URLs.
 * Relative forms are refused instead of being passed to Telegram as a file_id: file_ids use only
 * letters, digits, "_" and "-", so an input with a path separator or surrounding whitespace is
 * a path.
 */
export function localPath(media: string): string | undefined {
  if (/^https?:\/\//i.test(media)) return undefined;
  const notAbsolute = () => new Error(configuredRoots().length
    ? `Local paths must be absolute and inside TELEGRAM_UPLOAD_ROOTS; got ${media}`
    : `Local paths must be absolute; got ${media}`);
  if (/^(~|\.\.?\/|file:)/i.test(media)) throw notAbsolute();
  if (!isAbsolute(media)) {
    if (/[\\/]|^\s|\s$/.test(media)) throw notAbsolute();
    return undefined;
  }
  if (media.includes("\0")) throw new Error("Local path contains a NUL byte");
  if (media.split(sep === "\\" ? /[\\/]/ : "/").some(segment => segment === "." || segment === "..")) {
    throw new Error(`Local path ${media} contains "." or ".." segments; pass the path without them`);
  }
  return media;
}

/**
 * Opens path without following a final symlink and checks that the descriptor is the same
 * regular file as expected (the stat of the checked realpath) and is within limit.
 */
export async function openVerified(path: string, expected: BigIntStats, limit: number, label = path): Promise<{ handle: FileHandle; size: number }> {
  let handle: FileHandle;
  try {
    // O_NONBLOCK keeps a FIFO swapped in after the check from blocking the open.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error: any) {
    if (error?.code === "ELOOP" || error?.code === "ENOENT") throw changed(label);
    // EACCES and the like: the raw error names the realpath, so name the input and the code instead.
    if (typeof error?.code === "string") throw new Error(`Local file is not readable (${error.code}): ${label}`);
    throw error;
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (info.dev !== expected.dev || info.ino !== expected.ino) throw changed(label);
    if (!info.isFile()) throw new Error(`Local path is not a regular file: ${label}`);
    if (info.size > BigInt(limit)) throw tooLarge(label, Number(info.size), limit);
    return { handle, size: Number(info.size) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Owns the local files of one tool call: it opens and verifies them, streams them to Telegraf,
 * aborts the request when a stream fails, and closes every descriptor in close().
 */
export class UploadBatch {
  private readonly handles = new Set<FileHandle>();
  private readonly streams = new Set<Readable>();
  private readonly controller = new AbortController();
  private failure: Error | undefined;
  private closed = false;

  /**
   * Opens a local media path whose given path and realpath both lie inside TELEGRAM_UPLOAD_ROOTS,
   * or any local file when it lists no directory. Returns undefined for file_ids and http(s) URLs.
   */
  async open(media: string, limit: number): Promise<VerifiedFile | undefined> {
    const path = localPath(media);
    if (path === undefined) return undefined;
    const roots = await uploadRoots();
    // Without roots only the containment checks are skipped; every other check below still runs.
    const allowed = (target: string) => roots === undefined || roots.some(root => isInside(root.real, target));
    const outside = () => new Error(`Local file ${media} is outside the directories allowed by TELEGRAM_UPLOAD_ROOTS`);
    // Check the path as written first so paths outside the roots are never probed.
    if (roots && !roots.some(root => isInside(root.lexical, path) || isInside(root.real, path))) throw outside();
    let real: string;
    try {
      real = await realpath(path);
    } catch (error: any) {
      if (error?.code === "ENOENT") throw new Error(`Local file not found: ${media}`);
      // EACCES, ENOTDIR, ELOOP and the like: name the input and the code instead of the raw error.
      if (typeof error?.code === "string") throw new Error(`Local file is not readable (${error.code}): ${media}`);
      throw error;
    }
    // The realpath check rejects symlinks that lead out of every root.
    if (!allowed(real)) throw outside();
    const info = await stat(real, { bigint: true });
    if (!info.isFile()) throw new Error(`Local path is not a regular file: ${media}`);
    if (info.size > BigInt(limit)) throw tooLarge(media, Number(info.size), limit);
    const { handle, size } = await openVerified(real, info, limit, media);
    try {
      // O_NOFOLLOW covers only the last component. An intermediate directory replaced by a symlink
      // between the realpath and the open makes both the stat and the descriptor describe a file
      // elsewhere, so the path must still resolve to the same realpath, and that realpath must
      // still be the opened file. Once again equals real, allowed(again) cannot fail, because real
      // already passed allowed() above; the check is redundant and kept only as defence in depth.
      const again = await realpath(path).catch(() => undefined);
      if (again !== real || !allowed(again)) throw changed(media);
      const current = await stat(real, { bigint: true }).catch(() => undefined);
      const opened = await handle.stat({ bigint: true });
      if (!current || current.dev !== opened.dev || current.ino !== opened.ino) throw changed(media);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    this.handles.add(handle);
    return { label: media, path: real, handle, size };
  }

  /** Streams a verified file; the stream fails, and the request is aborted, past limit bytes. */
  upload(file: VerifiedFile, limit: number, filename: string): LocalUpload {
    const overflow = () => this.fail(new Error(`Local file ${file.label} grew past the ${formatSize(limit)} upload limit while it was being uploaded`));
    const limiter = limitStream(limit, overflow);
    // Both streams are destroyed in close(): a stream over a FileHandle keeps handle.close() waiting.
    const input = file.handle.createReadStream({ start: 0, autoClose: false });
    this.streams.add(input);
    this.streams.add(limiter);
    pipeline(input, limiter, error => {
      if (error && !this.closed) this.fail(error);
    });
    return Input.fromReadableStream(limiter, filename) as LocalUpload;
  }

  /** Resolves a media input: file_ids and URLs pass through, local paths become verified uploads. */
  async resolve(media: string, limit: number, filename?: string): Promise<MediaSource> {
    const file = await this.open(media, limit);
    return file ? this.upload(file, limit, filename ?? safeFilename(basename(file.path))) : media;
  }

  /** A view of telegram whose API calls are aborted when an upload stream of this batch fails. */
  telegram(telegram: Telegram): Telegram {
    const signal = this.controller.signal;
    return Object.create(telegram, {
      callApi: {
        value: (method: any, payload: any, options: { signal?: AbortSignal } = {}) =>
          // Telegraf types the signal with its abort-controller shim; node-fetch accepts the native one.
          telegram.callApi(method, payload, { ...options, signal: options.signal ?? signal } as any),
      },
    });
  }

  /** Runs work, reporting an upload failure in place of the abort error it caused. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.failure ?? error;
    }
  }

  /** Destroys every stream and closes every descriptor this batch opened. */
  async close(): Promise<void> {
    this.closed = true;
    for (const stream of this.streams) stream.destroy();
    await Promise.all([...this.handles].map(handle => handle.close().catch(() => undefined)));
    this.streams.clear();
    this.handles.clear();
  }

  private fail(error: Error): Error {
    this.failure ??= error;
    this.controller.abort();
    return error;
  }
}

/** Opens, uses and always closes an upload batch. */
export async function withUploads<T>(work: (uploads: UploadBatch) => Promise<T>): Promise<T> {
  const uploads = new UploadBatch();
  try {
    return await uploads.run(() => work(uploads));
  } finally {
    await uploads.close();
  }
}
