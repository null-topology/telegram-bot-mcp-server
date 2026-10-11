import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Input } from "telegraf";
import { formatSize, limitStream, LocalUpload, MediaSource, safeFilename, UPLOAD_LIMIT, UploadBatch, VerifiedFile } from "./uploads";

export const FFMPEG_TIMEOUT_MS = 120_000;
const FFMPEG_MAX_BUFFER = 1024 * 1024;

/** The largest first Ogg page: a 27-byte header, a 255-entry segment table and 255 segments of 255 bytes. */
const HEADER_BYTES = 27 + 255 + 255 * 255;

/** Runs ffmpeg with an argument array and rejects when it cannot start or fails. */
export type FfmpegRunner = (args: string[], timeoutMs: number) => Promise<void>;

export const runFfmpeg: FfmpegRunner = (args, timeoutMs) => new Promise((resolve, reject) => {
  // No shell and piped stdio: stdout is the JSON-RPC channel.
  execFile("ffmpeg", args, { timeout: timeoutMs, maxBuffer: FFMPEG_MAX_BUFFER, windowsHide: true }, (error, _stdout, stderr) => {
    if (!error) return resolve();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return reject(new Error("ffmpeg is required to convert non-OGG/Opus audio for send-voice, but it was not found on PATH; install ffmpeg or send an OGG/Opus file"));
    }
    // Node kills ffmpeg when its output passes maxBuffer, so this check must come before the timeout one.
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return reject(new Error(`ffmpeg wrote more than ${formatSize(FFMPEG_MAX_BUFFER)} of output and was stopped before converting the audio`));
    }
    if (error.killed) return reject(new Error(`ffmpeg did not finish converting the audio within ${timeoutMs / 1000} s`));
    const detail = String(stderr).trim().slice(-500);
    reject(new Error(`ffmpeg failed to convert the audio to OGG/Opus${detail ? `: ${detail}` : ""}`));
  });
});

/**
 * Detects OGG/Opus that can be sent as is from the leading bytes of a file. The first Ogg page's
 * segment table must fit in the bytes present, and its first packet must be a complete OpusHead
 * with version 1: either mapping family 0 with one or two channels, or another family with a full
 * channel mapping table (at least one stream, no more coupled streams than streams, and every
 * entry naming a decoded channel or 255 for silence). Anything else is converted instead.
 */
export function isOggOpus(header: Buffer): boolean {
  if (header.length < 27 || header.toString("latin1", 0, 4) !== "OggS" || header[4] !== 0) return false;
  const segments = header[26];
  const tableEnd = 27 + segments;
  if (segments === 0 || header.length < tableEnd) return false;
  let body = 0;
  for (let index = 27; index < tableEnd; index++) body += header[index];
  if (header.length < tableEnd + body) return false;
  // A packet ends at the first lacing value below 255; a packet without one continues on the next page.
  let packet = 0;
  let index = 27;
  for (; index < tableEnd; index++) {
    packet += header[index];
    if (header[index] < 255) break;
  }
  if (index === tableEnd || packet < 19) return false;
  const head = header.subarray(tableEnd, tableEnd + packet);
  if (head.toString("latin1", 0, 8) !== "OpusHead" || head[8] !== 1) return false;
  const channels = head[9];
  const family = head[18];
  if (family === 0) return channels >= 1 && channels <= 2;
  // Other families carry a stream count, a coupled stream count and one mapping byte per channel.
  if (channels < 1 || packet < 21 + channels) return false;
  const streams = head[19];
  const coupled = head[20];
  if (streams < 1 || coupled > streams) return false;
  for (let entry = 21; entry < 21 + channels; entry++) {
    if (head[entry] !== 255 && head[entry] >= streams + coupled) return false;
  }
  return true;
}

/**
 * Maps the leading bytes of an audio file to the ffmpeg demuxer used to read it, or undefined
 * when the container is not one send-voice converts. Pinning the demuxer keeps ffmpeg from
 * treating the file as a playlist or concat script that references other files.
 */
export function audioDemuxer(header: Buffer): string | undefined {
  const ascii = (start: number, end: number) => header.length >= end ? header.toString("latin1", start, end) : "";
  if (ascii(0, 3) === "ID3") return "mp3";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(4, 8) === "ftyp") return "mov";
  if (header.length >= 4 && header.readUInt32BE(0) === 0x1a45dfa3) return "matroska";
  if (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0) {
    const layer = (header[1] >> 1) & 0x03;
    // MPEG audio frames use layers 1-3 and a version other than the reserved 01.
    if (layer !== 0) return ((header[1] >> 3) & 0x03) === 0x01 ? undefined : "mp3";
    // ADTS has a 12-bit sync word and layer 00.
    if ((header[1] & 0xf0) === 0xf0) return "aac";
  }
  return undefined;
}

/** File name for a converted voice message: the given or source name with an .ogg extension. */
export function voiceFilename(name: string): string {
  return safeFilename(`${basename(name, extname(name))}.ogg`);
}

/** Copies a verified file into target, failing once more than the upload limit has been read. */
async function stage(file: VerifiedFile, target: string): Promise<void> {
  // Destroying the stream releases its reference on the descriptor, which the upload batch closes later.
  const input = file.handle.createReadStream({ start: 0, autoClose: false });
  try {
    await pipeline(
      input,
      limitStream(UPLOAD_LIMIT, () => new Error(`Local file ${file.label} grew past the ${formatSize(UPLOAD_LIMIT)} upload limit while it was being read`)),
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
  } finally {
    input.destroy();
  }
}

export interface PreparedVoice {
  media: MediaSource;
  cleanup: () => Promise<void>;
}

/**
 * Resolves send-voice media. Local OGG/Opus is streamed as is; other supported audio is copied
 * from the verified descriptor into a private temporary directory and converted with ffmpeg.
 */
export async function prepareVoice(uploads: UploadBatch, media: string, filename?: string, ffmpeg: FfmpegRunner = runFfmpeg): Promise<PreparedVoice> {
  const nothing = async () => {};
  const file = await uploads.open(media, UPLOAD_LIMIT);
  if (!file) return { media, cleanup: nothing };
  const buffer = Buffer.alloc(HEADER_BYTES);
  const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, 0);
  const header = buffer.subarray(0, bytesRead);
  if (isOggOpus(header)) {
    return { media: uploads.upload(file, UPLOAD_LIMIT, voiceFilename(filename ?? basename(file.path))), cleanup: nothing };
  }
  const demuxer = audioDemuxer(header);
  if (!demuxer) {
    throw new Error(`Unsupported audio format in ${media}; send-voice converts MP3, WAV, FLAC, Ogg, MP4/M4A, AAC (ADTS) and Matroska/WebM audio and sends OGG/Opus as is`);
  }
  const directory = await mkdtemp(join(tmpdir(), "telegram-voice-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const input = join(directory, "input");
    await stage(file, input);
    const output = join(directory, "voice.ogg");
    await ffmpeg(["-nostdin", "-hide_banner", "-loglevel", "error", "-f", demuxer, "-i", input, "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "48k", "-f", "ogg", output], FFMPEG_TIMEOUT_MS);
    const { size } = await stat(output);
    if (size > UPLOAD_LIMIT) {
      throw new Error(`Converted voice file is ${formatSize(size)}, which exceeds the ${formatSize(UPLOAD_LIMIT)} upload limit`);
    }
    return { media: Input.fromLocalFile(output, voiceFilename(filename ?? basename(file.path))) as LocalUpload, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
