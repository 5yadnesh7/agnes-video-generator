import {
  envStoryKey,
  missingStoryKeyCopy,
} from "@/lib/agnes/api-key";
import { DEFAULT_IMAGE_MODEL, FLASH_ASPECT_RATIOS, isImageModelId, V20_ASPECTS } from "@/lib/agnes/constants";
import {
  parseStillVerdict,
  SCENE_STILL_MAX_ATTEMPTS,
  SCENE_STILL_RETRY_TAIL,
  sceneStillJudgeSystem,
} from "@/lib/agnes/story-format";
import { isAgnesMediaRef, isPublicHttpsUrl } from "@/lib/agnes/types";
import { chatCompletion, generateImagePng } from "@/lib/agnes/upstream";
import { readUploadBytes, saveUpload } from "@/lib/media/store";

export const runtime = "nodejs";
export const maxDuration = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

function withKeyCookie(res: Response, _override: string | null): Response {
  return res;
}

const RATIOS = new Set<string>([...V20_ASPECTS, ...FLASH_ASPECT_RATIOS]);
const MEDIA_UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const JUDGE_TIMEOUT_MS = 45_000;
const FETCH_TIMEOUT_MS = 20_000;

function castNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim() && !out.includes(item.trim())) out.push(item.trim());
  }
  return out;
}

function toDataUrl(bytes: Buffer, contentType: string): string {
  const mime = contentType.split(";")[0].trim() || "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function bytesFromPublicUrl(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) return null;
    return { bytes, contentType: res.headers.get("content-type") || "image/png" };
  } catch {
    return null;
  }
}

async function imageDataUrlForJudge(raw: string, imageId?: string): Promise<string | null> {
  const text = raw.trim();
  if (text.startsWith("data:image/")) return text;

  const idHint = imageId?.trim() || (isAgnesMediaRef(text) ? text.slice("agnes-media:".length) : "");
  const uuid = idHint || text.match(MEDIA_UUID_RE)?.[0] || "";
  if (uuid) {
    const stored = await readUploadBytes(uuid);
    if (stored && stored.bytes.length > 0) return toDataUrl(stored.bytes, stored.contentType);
  }

  if (isPublicHttpsUrl(text)) {
    const fetched = await bytesFromPublicUrl(text);
    if (fetched) return toDataUrl(fetched.bytes, fetched.contentType);
  }
  return null;
}

async function judgeStill(
  imageUrl: string,
  names: string[],
  key: string | null,
): Promise<{ pass: boolean; reasons: string[]; judged: boolean }> {
  const who = names.length > 0 ? names.join(", ") : "the named cast described in the prompt";
  const chat = await chatCompletion(
    [
      { role: "system", content: sceneStillJudgeSystem() },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Named cast (each must appear exactly once): ${who}. Judge this still against the rules.`,
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    key,
    JUDGE_TIMEOUT_MS,
  );
  if (!chat.ok) {
    return { pass: false, reasons: ["Could not judge this still."], judged: false };
  }
  return { ...parseStillVerdict(chat.content), judged: true };
}

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON.");
  }
  if (!isRecord(json)) return jsonError(400, "Invalid JSON.");

  const key = envStoryKey();
  if (!key) return jsonError(401, missingStoryKeyCopy());
  const override = null;
  const names = castNames(json.cast);

  if (json.check_only === true) {
    const image = typeof json.image === "string" ? json.image : "";
    const imageId = typeof json.image_id === "string" ? json.image_id : "";
    const judgedUrl = await imageDataUrlForJudge(image, imageId);
    if (!judgedUrl) return jsonError(400, "Need a still image to check.");
    const verdict = await judgeStill(judgedUrl, names, key);
    return withKeyCookie(Response.json(verdict), override);
  }

  const prompt = typeof json.prompt === "string" ? json.prompt.trim() : "";
  if (!prompt) return jsonError(400, "Need a scene description to draw the still.");

  const ratioRaw = typeof json.ratio === "string" ? json.ratio.trim() : "16:9";
  const ratio = RATIOS.has(ratioRaw) ? ratioRaw : "16:9";
  const model = isImageModelId(json.model) ? json.model : DEFAULT_IMAGE_MODEL;
  const validate = json.validate !== false;

  let lastFail: string[] = [];
  for (let attempt = 0; attempt < SCENE_STILL_MAX_ATTEMPTS; attempt += 1) {
    const retryBits = lastFail.length > 0 ? ` Last fail: ${lastFail.join("; ")}.` : "";
    const attemptPrompt =
      attempt === 0 ? prompt : `${prompt} ${SCENE_STILL_RETRY_TAIL}${retryBits}`;
    const image = await generateImagePng(attemptPrompt, key, { ratio, model });
    if (!image.ok) {
      return withKeyCookie(jsonError(image.status, image.detail), override);
    }

    let stored: { id: string; url: string };
    try {
      stored = await saveUpload(new Uint8Array(image.bytes), image.contentType, "scene-still.png", "generated");
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Could not store this file.";
      return withKeyCookie(jsonError(502, detail), override);
    }

    if (!validate) {
      return withKeyCookie(
        Response.json({ id: stored.id, url: stored.url, check: { pass: true, reasons: [], attempts: attempt + 1 } }),
        override,
      );
    }

    const judgedUrl = `data:${image.contentType};base64,${image.bytes.toString("base64")}`;
    const verdict = await judgeStill(judgedUrl, names, key);
    if (!verdict.judged) {
      return withKeyCookie(
        Response.json({
          id: stored.id,
          url: stored.url,
          check: { pass: false, reasons: verdict.reasons, attempts: attempt + 1, judged: false },
        }),
        override,
      );
    }
    if (verdict.pass) {
      return withKeyCookie(
        Response.json({
          id: stored.id,
          url: stored.url,
          check: { pass: true, reasons: [], attempts: attempt + 1, judged: true },
        }),
        override,
      );
    }
    lastFail = verdict.reasons;
    if (attempt === SCENE_STILL_MAX_ATTEMPTS - 1) {
      return withKeyCookie(
        Response.json({
          id: stored.id,
          url: stored.url,
          check: { pass: false, reasons: lastFail, attempts: attempt + 1, judged: true },
        }),
        override,
      );
    }
  }

  return withKeyCookie(jsonError(502, lastFail[0] || "Could not draw this end still."), override);
}
