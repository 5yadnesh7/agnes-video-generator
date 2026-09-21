import "server-only";

import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import ffmpegStatic from "ffmpeg-static";

import { parseFfmpegVideoProbe, type VideoProbe } from "@/lib/media/concat-filter";

export { concatFilterArgs, parseFfmpegVideoProbe } from "@/lib/media/concat-filter";
export type { ConcatScale, VideoProbe } from "@/lib/media/concat-filter";

export const FFMPEG_MISSING = "FFmpeg is not available on this server.";

const STDERR_CAP = 16_384;

let resolvedBin: string | null | undefined;

async function ffmpegBin(): Promise<string | null> {
  if (resolvedBin !== undefined) return resolvedBin;
  const src = typeof ffmpegStatic === "string" ? ffmpegStatic : null;
  if (!src) {
    resolvedBin = null;
    return null;
  }
  try {
    await chmod(src, 0o755);
    resolvedBin = src;
    return src;
  } catch {
    const dest = path.join(tmpdir(), "agnes-ffmpeg");
    try {
      await copyFile(src, dest);
      await chmod(dest, 0o755);
      resolvedBin = dest;
      return dest;
    } catch {
      resolvedBin = src;
      return src;
    }
  }
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agnes-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function spawnFfmpeg(args: string[]): Promise<{ missing: boolean; code: number | null; stderr: string }> {
  const bin = await ffmpegBin();
  if (!bin) return { missing: true, code: null, stderr: "" };
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length >= STDERR_CAP) return;
      stderr += chunk.toString("utf8").slice(0, STDERR_CAP - stderr.length);
    });
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolve({ missing: code === "ENOENT", code: null, stderr });
    });
    child.on("close", (code) => {
      resolve({ missing: false, code, stderr });
    });
  });
}

export async function runFfmpeg(
  args: string[],
): Promise<{ ok: true } | { ok: false; missing: boolean; stderr: string }> {
  const result = await spawnFfmpeg(args);
  if (result.missing) return { ok: false, missing: true, stderr: result.stderr };
  if (result.code === 0) return { ok: true };
  return { ok: false, missing: false, stderr: result.stderr };
}

export async function probeVideo(
  inputPath: string,
): Promise<{ ok: true } & VideoProbe | { ok: false; missing: boolean; stderr: string }> {
  const result = await spawnFfmpeg(["-hide_banner", "-i", inputPath]);
  if (result.missing) return { ok: false, missing: true, stderr: result.stderr };
  const parsed = parseFfmpegVideoProbe(result.stderr);
  if (!parsed) return { ok: false, missing: false, stderr: result.stderr };
  return { ok: true, ...parsed };
}

export function extractLastFrameArgs(inputPath: string, outputPath: string): string[] {
  return ["-y", "-sseof", "-1", "-i", inputPath, "-frames:v", "1", "-q:v", "2", outputPath];
}

export function concatCopyArgs(listPath: string, outputPath: string): string[] {
  return ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath];
}

export function concatListBody(filePaths: string[]): string {
  return filePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
}
