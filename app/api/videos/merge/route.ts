import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { STORY_SCENE_HARD_MAX, STORY_SCENE_MIN } from "@/lib/agnes/constants";
import { concatCopyArgs, concatListBody, concatReencodeArgs, FFMPEG_MISSING, runFfmpeg, withTempDir } from "@/lib/media/ffmpeg";
import { assertSafeHttpsUrl, downloadHttpsToFile } from "@/lib/media/safe-download";
import { saveUpload } from "@/lib/media/store";

export const runtime = "nodejs";
export const maxDuration = 300;

const DOWNLOAD_MS = 60_000;

function isRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON.");
  }
  if (!isRecord(json) || !Array.isArray((json as { urls?: unknown }).urls)) {
    return jsonError(400, "urls must be an array of https:// clip URLs.");
  }

  const urls: string[] = [];
  for (const item of (json as { urls: unknown[] }).urls) {
    if (typeof item !== "string") {
      return jsonError(400, "urls must be an array of https:// clip URLs.");
    }
    const url = item.trim();
    try {
      await assertSafeHttpsUrl(url);
    } catch {
      return jsonError(400, "Each url must be a public https:// address.");
    }
    urls.push(url);
  }
  if (urls.length < STORY_SCENE_MIN) {
    return jsonError(400, `Merge needs at least ${STORY_SCENE_MIN} clips.`);
  }
  if (urls.length > STORY_SCENE_HARD_MAX) {
    return jsonError(400, "Too many clips to merge for a 10 min film.");
  }

  try {
    return await withTempDir(async (dir) => {
      const clipPaths: string[] = [];
      for (let i = 0; i < urls.length; i += 1) {
        const dest = path.join(dir, `clip-${i}.mp4`);
        const downloaded = await downloadHttpsToFile(
          urls[i],
          dest,
          DOWNLOAD_MS,
          "Could not download a clip to merge.",
        );
        if (!downloaded.ok) return jsonError(502, downloaded.detail);
        clipPaths.push(dest);
      }

      const listPath = path.join(dir, "concat.txt");
      await writeFile(listPath, concatListBody(clipPaths), "utf8");
      const outputPath = path.join(dir, "merged.mp4");

      const copied = await runFfmpeg(concatCopyArgs(listPath, outputPath));
      if (!copied.ok && copied.missing) {
        return jsonError(502, FFMPEG_MISSING);
      }
      if (!copied.ok) {
        const reencoded = await runFfmpeg(concatReencodeArgs(listPath, outputPath));
        if (!reencoded.ok) {
          if (reencoded.missing) return jsonError(502, FFMPEG_MISSING);
          return jsonError(502, "Could not merge these clips.");
        }
      }

      const mp4 = await readFile(outputPath);
      const id = await saveUpload(new Uint8Array(mp4), "video/mp4", "merged.mp4");
      return Response.json({ id, url: `/api/media/${id}` });
    });
  } catch {
    return jsonError(502, "Could not merge these clips.");
  }
}
