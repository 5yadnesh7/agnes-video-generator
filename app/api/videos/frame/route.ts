import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertSafeHttpsUrl, downloadHttpsToFile } from "@/lib/media/safe-download";
import {
  extractLastFrameArgs,
  FFMPEG_MISSING,
  runFfmpeg,
  withTempDir,
} from "@/lib/media/ffmpeg";
import { saveUpload } from "@/lib/media/store";

export const runtime = "nodejs";
export const maxDuration = 120;

const DOWNLOAD_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

async function downloadHttps(url: string, dest: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  return downloadHttpsToFile(url, dest, DOWNLOAD_MS, "Could not download the clip to extract a frame.");
}

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON.");
  }
  if (!isRecord(json) || typeof json.url !== "string") {
    return jsonError(400, "url is required.");
  }
  const url = json.url.trim();
  try {
    await assertSafeHttpsUrl(url);
  } catch {
    return jsonError(400, "url must be a public https:// address.");
  }

  try {
    return await withTempDir(async (dir) => {
      const inputPath = path.join(dir, "clip.mp4");
      const outputPath = path.join(dir, "last.jpg");
      const downloaded = await downloadHttps(url, inputPath);
      if (!downloaded.ok) return jsonError(502, downloaded.detail);

      const result = await runFfmpeg(extractLastFrameArgs(inputPath, outputPath));
      if (!result.ok) {
        if (result.missing) return jsonError(502, FFMPEG_MISSING);
        return jsonError(502, "Could not extract the last frame.");
      }

      const jpeg = await readFile(outputPath);
      const stored = await saveUpload(new Uint8Array(jpeg), "image/jpeg", "last-frame.jpg");
      return Response.json({ id: stored.id, url: stored.url });
    });
  } catch {
    return jsonError(502, "Could not extract the last frame.");
  }
}
