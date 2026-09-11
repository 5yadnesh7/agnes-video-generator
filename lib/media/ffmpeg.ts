import "server-only";

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const FFMPEG_MISSING = "Install ffmpeg locally to extract frames and merge.";

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "agnes-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function runFfmpeg(
  args: string[],
): Promise<{ ok: true } | { ok: false; missing: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { windowsHide: true, stdio: "ignore" });
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolve({ ok: false, missing: code === "ENOENT" });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      resolve({ ok: false, missing: false });
    });
  });
}

export function extractLastFrameArgs(inputPath: string, outputPath: string): string[] {
  return ["-y", "-sseof", "-1", "-i", inputPath, "-frames:v", "1", "-q:v", "2", outputPath];
}

export function concatCopyArgs(listPath: string, outputPath: string): string[] {
  return ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath];
}

export function concatReencodeArgs(listPath: string, outputPath: string): string[] {
  return [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-s",
    "1280x720",
    "-r",
    "24",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

export function concatListBody(filePaths: string[]): string {
  return filePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
}
