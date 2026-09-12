import {
  cookieApiKey,
  envApiKey,
  overrideFromBody,
  setOverrideCookie,
  clearOverrideCookie,
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
import { resolveAgnesMediaUrl, saveUpload } from "@/lib/media/store";

export const runtime = "nodejs";
export const maxDuration = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

function withKeyCookie(res: Response, override: string | null): Response {
  const headers = new Headers(res.headers);
  headers.set("Set-Cookie", override ? setOverrideCookie(override) : clearOverrideCookie());
  return new Response(res.body, { status: res.status, headers });
}

const RATIOS = new Set<string>([...V20_ASPECTS, ...FLASH_ASPECT_RATIOS]);

function castNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim() && !out.includes(item.trim())) out.push(item.trim());
  }
  return out;
}

async function imageUrlForJudge(raw: string): Promise<string | null> {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("data:image/")) return text;
  if (isPublicHttpsUrl(text)) return text;
  if (isAgnesMediaRef(text)) {
    try {
      return await resolveAgnesMediaUrl(text);
    } catch {
      return null;
    }
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
    30_000,
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

  const override = overrideFromBody(json.agnes_api_key);
  const key = override ?? cookieApiKey(request) ?? envApiKey();
  const names = castNames(json.cast);

  if (json.check_only === true) {
    const image = typeof json.image === "string" ? json.image : "";
    const judgedUrl = await imageUrlForJudge(image);
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
      stored = await saveUpload(new Uint8Array(image.bytes), image.contentType, "scene-still.png");
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

    const judgedUrl =
      (await imageUrlForJudge(stored.url)) ??
      `data:${image.contentType};base64,${image.bytes.toString("base64")}`;
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
