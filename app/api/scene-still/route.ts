import {
  cookieApiKey,
  envApiKey,
  overrideFromBody,
  setOverrideCookie,
  clearOverrideCookie,
} from "@/lib/agnes/api-key";
import { DEFAULT_IMAGE_MODEL, FLASH_ASPECT_RATIOS, isImageModelId, V20_ASPECTS } from "@/lib/agnes/constants";
import { generateImagePng } from "@/lib/agnes/upstream";
import { saveUpload } from "@/lib/media/store";

export const runtime = "nodejs";
export const maxDuration = 90;

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

  const prompt = typeof json.prompt === "string" ? json.prompt.trim() : "";
  if (!prompt) return jsonError(400, "Need a scene description to draw the still.");

  const ratioRaw = typeof json.ratio === "string" ? json.ratio.trim() : "16:9";
  const ratio = RATIOS.has(ratioRaw) ? ratioRaw : "16:9";
  const model = isImageModelId(json.model) ? json.model : DEFAULT_IMAGE_MODEL;

  const image = await generateImagePng(prompt, key, { ratio, model });
  if (!image.ok) {
    return withKeyCookie(jsonError(image.status, image.detail), override);
  }

  const id = await saveUpload(new Uint8Array(image.bytes), image.contentType, "scene-still.png");
  return withKeyCookie(Response.json({ id, url: `agnes-media:${id}` }), override);
}
