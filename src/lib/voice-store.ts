import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";

const VOICE_DIR = path.join(process.cwd(), ".data", "voice");

function extForMime(mime: string): string {
  if (mime.includes("ogg") || mime.includes("opus")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("wav")) return "wav";
  return "bin";
}

/** Persist inbound WhatsApp voice bytes; returns relative path from cwd. */
export async function saveVoiceFile(
  bytes: Buffer,
  mime: string,
): Promise<{ relativePath: string; absPath: string }> {
  await mkdir(VOICE_DIR, { recursive: true });
  const name = `${Date.now()}-${randomBytes(4).toString("hex")}.${extForMime(mime)}`;
  const absPath = path.join(VOICE_DIR, name);
  await writeFile(absPath, bytes);
  return {
    relativePath: path.join(".data", "voice", name),
    absPath,
  };
}

export async function readVoiceFile(
  relativePath: string,
): Promise<{ bytes: Buffer; absPath: string }> {
  const absPath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(/* turbopackIgnore: true */ process.cwd(), relativePath);
  const bytes = await readFile(absPath);
  return { bytes, absPath };
}
