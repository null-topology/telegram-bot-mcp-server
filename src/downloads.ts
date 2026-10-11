import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, posix } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Telegraf } from "telegraf";
import { formatSize } from "./uploads";

/** Bots can download files of up to 20 MB through the Bot API. */
export const DOWNLOAD_LIMIT = 20 * 1024 * 1024;

/** A download is aborted when no bytes arrive for idleMs or when it runs longer than totalMs. */
export interface DownloadTimeouts {
  idleMs: number;
  totalMs: number;
}
export const DOWNLOAD_TIMEOUTS: DownloadTimeouts = { idleMs: 30_000, totalMs: 5 * 60_000 };

/** Saved names are cut to this length; numbered alternatives for taken names add a few characters. */
const NAME_LIMIT = 200;
/** How many numbered alternatives are tried when a name is already taken. */
const NAME_ATTEMPTS = 100;
/** link() errors from file systems that cannot hard-link; the file is copied instead. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

const mimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
  ".wav": "audio/wav", ".flac": "audio/flac",
  ".pdf": "application/pdf", ".zip": "application/zip", ".json": "application/json", ".tgs": "application/x-tgsticker",
  ".txt": "text/plain", ".csv": "text/csv",
};

export interface DownloadedFile {
  path: string;
  size: number;
  mime: string;
  file_id: string;
  file_unique_id: string;
}

interface Identity {
  dev: bigint;
  ino: bigint;
}

/** A saved file and the identity it was saved with. */
interface Published {
  path: string;
  identity: Identity;
}

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
}

/**
 * `<file_unique_id>-<basename>` with unsafe characters replaced, cut to NAME_LIMIT. The extension
 * is kept whenever it fits after the `<file_unique_id>-` prefix and at least one stem character.
 */
export function downloadName(fileUniqueId: string, filePath: string): string {
  const prefix = sanitizeName(`${fileUniqueId}-`);
  const name = sanitizeName(`${fileUniqueId}-${posix.basename(filePath)}`);
  if (name.length <= NAME_LIMIT) return name;
  const extension = extname(name);
  const kept = prefix.length + 1 + extension.length <= NAME_LIMIT ? extension : "";
  return name.slice(0, NAME_LIMIT - kept.length) + kept;
}

async function identity(path: string): Promise<Identity> {
  const { dev, ino } = await stat(path, { bigint: true });
  return { dev, ino };
}

/** True while directory still resolves to root and root is still the same directory. */
async function unchanged(directory: string, root: string, expected: Identity): Promise<boolean> {
  try {
    if (await realpath(directory) !== root) return false;
    const current = await identity(root);
    return current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

/** True when the entry at path itself, not a symlink target, is the file with identity own. */
async function isOwn(path: string, own: Identity): Promise<boolean> {
  try {
    const { dev, ino } = await lstat(path, { bigint: true });
    return dev === own.dev && ino === own.ino;
  } catch {
    return false;
  }
}

/** Removes path only when it is still the file this call wrote. */
async function removeOwn(path: string, own: Identity): Promise<void> {
  try {
    if (await isOwn(path, own)) await rm(path, { force: true });
  } catch {
    // Best effort: the file is already gone or cannot be removed.
  }
}

/**
 * Writes into a descriptor that stays open after the stream ends, so a failed download can
 * still be emptied through it. fs write streams close or hold the descriptor themselves.
 */
function handleWriter(handle: FileHandle): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      (async () => {
        for (let offset = 0; offset < chunk.length;) offset += (await handle.write(chunk, offset)).bytesWritten;
      })().then(() => callback(), callback);
    },
  });
}

/** Copies everything in source into a new file at target; an existing entry, even a symlink, fails with EEXIST. */
async function copyInto(source: FileHandle, target: string): Promise<Identity> {
  const output = await open(target, "wx", 0o600);
  let own: Identity | undefined;
  try {
    const { dev, ino } = await output.stat({ bigint: true });
    own = { dev, ino };
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; ;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      for (let offset = 0; offset < bytesRead;) offset += (await output.write(buffer, offset, bytesRead - offset)).bytesWritten;
      position += bytesRead;
    }
    return own;
  } catch (error) {
    if (own) await removeOwn(target, own);
    throw error;
  } finally {
    await output.close().catch(() => undefined);
  }
}

/**
 * Saves partial under name, or name-1, name-2 and so on, without replacing an existing file.
 * The file is hard-linked; where the file system cannot do that, it is copied from handle.
 */
async function publish(partial: string, handle: FileHandle, own: Identity, root: string, name: string): Promise<Published> {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let linking = true;
  const place = async (candidate: string): Promise<Identity> => {
    if (linking) {
      try {
        await link(partial, candidate);
        return own;
      } catch (error: any) {
        if (!NO_HARD_LINKS.has(error?.code)) throw error;
        linking = false;
      }
    }
    return copyInto(handle, candidate);
  };
  for (let attempt = 0; attempt <= NAME_ATTEMPTS; attempt++) {
    const candidate = join(root, attempt === 0 ? name : `${stem}-${attempt}${extension}`);
    try {
      return { path: candidate, identity: await place(candidate) };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`${name} and ${NAME_ATTEMPTS} numbered alternatives already exist in TELEGRAM_DOWNLOAD_DIR`);
}

/**
 * Saves a Telegram file into TELEGRAM_DOWNLOAD_DIR. The file URL embeds the bot token,
 * so it never leaves this function, not even inside error messages.
 */
export async function downloadFile(
  bot: Telegraf,
  fileId: string,
  directory = process.env.TELEGRAM_DOWNLOAD_DIR,
  timeouts: DownloadTimeouts = DOWNLOAD_TIMEOUTS,
): Promise<DownloadedFile> {
  if (!directory) throw new Error("download-file is disabled because TELEGRAM_DOWNLOAD_DIR is not set");
  if (!isAbsolute(directory)) throw new Error("TELEGRAM_DOWNLOAD_DIR must be an absolute path");
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  const rootIdentity = await identity(root);
  const swapped = () => new Error("TELEGRAM_DOWNLOAD_DIR changed while the file was being saved, so the download was discarded");

  // The overall deadline covers the getFile call as well as the transfer.
  const controller = new AbortController();
  let timedOut: Error | undefined;
  const stop = (error: Error) => {
    timedOut ??= error;
    controller.abort();
  };
  const deadline = setTimeout(() => stop(new Error(`Download did not finish within ${timeouts.totalMs / 1000} s and was aborted`)), timeouts.totalMs);
  let idle: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => stop(new Error(`Download received no data for ${timeouts.idleMs / 1000} s and was aborted`)), timeouts.idleMs);
  };

  let partial: string | undefined;
  let handle: FileHandle | undefined;
  let partialIdentity: Identity | undefined;
  let published: Published | undefined;
  try {
    const getFile = async () => {
      try {
        // Telegraf types the signal with its abort-controller shim; node-fetch accepts the native one.
        return await bot.telegram.callApi("getFile", { file_id: fileId }, { signal: controller.signal } as any);
      } catch (error) {
        throw timedOut ?? error;
      }
    };
    const file = await getFile();
    if (file.file_size !== undefined && file.file_size > DOWNLOAD_LIMIT) {
      throw new Error(`File is ${formatSize(file.file_size)}; bots can download files of up to ${formatSize(DOWNLOAD_LIMIT)}`);
    }
    if (!file.file_path) throw new Error("Telegram returned no file_path, so the file cannot be downloaded");
    const name = downloadName(file.file_unique_id, file.file_path);
    if (dirname(join(root, name)) !== root) throw new Error("Refusing to write outside TELEGRAM_DOWNLOAD_DIR");

    const url = await bot.telegram.getFileLink(file);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Files stored on a local Bot API server are not supported by download-file");
    }

    touch();
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (error: any) {
      throw timedOut ?? new Error(`Downloading the file failed: ${error?.cause?.code ?? error?.cause?.message ?? error?.message ?? "network error"}`);
    }
    if (!response.ok || !response.body) {
      controller.abort();
      throw new Error(`Downloading the file failed with HTTP ${response.status}`);
    }
    const tooLarge = () => new Error(`Download exceeded the ${formatSize(DOWNLOAD_LIMIT)} limit and was aborted`);
    if (Number(response.headers.get("content-length")) > DOWNLOAD_LIMIT) {
      controller.abort();
      throw tooLarge();
    }

    // Stream into a temporary name inside the directory so a failed download leaves no partial file.
    let size = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        touch();
        size += chunk.length;
        if (size > DOWNLOAD_LIMIT) callback(tooLarge());
        else callback(null, chunk);
      },
    });
    // Exclusive create: an existing file or symlink at the temporary name is never opened. The
    // descriptor is opened for reading too, so the file can be copied where hard links fail.
    partial = join(root, `.${name}.${randomUUID()}.part`);
    handle = await open(partial, "wx+", 0o600);
    const { dev, ino } = await handle.stat({ bigint: true });
    partialIdentity = { dev, ino };
    // The directory may have been replaced before the temporary file was created; check that the
    // file is in the recorded directory before a single byte is written into it.
    if (!await unchanged(directory, root, rootIdentity) || !await isOwn(partial, partialIdentity)) throw swapped();
    try {
      await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), limiter, handleWriter(handle));
    } catch (error) {
      throw timedOut ?? error;
    }

    if (!await unchanged(directory, root, rootIdentity)) throw swapped();
    published = await publish(partial, handle, partialIdentity, root, name);
    if (!await unchanged(directory, root, rootIdentity)) throw swapped();
    // The file is saved at this point; a temporary name that cannot be removed does not undo that.
    await rm(partial, { force: true }).catch(() => undefined);
    return {
      path: published.path,
      size,
      mime: mimeTypes[extname(published.path).toLowerCase()] ?? "application/octet-stream",
      file_id: file.file_id,
      file_unique_id: file.file_unique_id,
    };
  } catch (error) {
    controller.abort();
    if (partial && partialIdentity) {
      // Empty the file through the descriptor first, so nothing is left behind even when the
      // directory was moved and the paths below no longer reach it.
      await handle?.truncate(0).catch(() => undefined);
      if (published) await removeOwn(published.path, published.identity);
      await removeOwn(partial, partialIdentity);
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(idle);
    await handle?.close().catch(() => undefined);
  }
}
