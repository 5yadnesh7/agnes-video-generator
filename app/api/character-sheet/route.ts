import {
  cookieApiKey,
  envApiKey,
  overrideFromBody,
  setOverrideCookie,
  clearOverrideCookie,
} from "@/lib/agnes/api-key";
import { DEFAULT_IMAGE_MODEL, isImageModelId } from "@/lib/agnes/constants";
import { characterModelSheetPrompt } from "@/lib/agnes/storyboard";
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

  const appearance = typeof json.appearance === "string" ? json.appearance.trim() : "";
  const style = typeof json.style === "string" ? json.style.trim() : "";
  const name = typeof json.name === "string" ? json.name.trim() : "";
  const sheetPrompt = typeof json.sheet_prompt === "string" ? json.sheet_prompt.trim() : "";
  const extraPrompt = typeof json.prompt === "string" ? json.prompt.trim() : "";
  const model = isImageModelId(json.model) ? json.model : DEFAULT_IMAGE_MODEL;
  const sample =
    typeof json.image === "string"
      ? json.image.trim()
      : typeof json.sample === "string"
        ? json.sample.trim()
        : "";
  if (!appearance && !sheetPrompt && !extraPrompt && !sample) {
    return jsonError(400, "Need a character description or sample image to draw the sheet.");
  }

  const prompt = characterModelSheetPrompt({
    name,
    appearance,
    style,
    extra: [extraPrompt, sheetPrompt].filter(Boolean).join(" "),
    sample: Boolean(sample),
  });

  const image = await generateImagePng(prompt, key, {
    model,
    ratio: "3:4",
    images: sample ? [sample] : undefined,
  });
  if (!image.ok) {
    return withKeyCookie(jsonError(image.status, image.detail), override);
  }

  const id = await saveUpload(new Uint8Array(image.bytes), image.contentType, "character-sheet.png");
  return withKeyCookie(Response.json({ id, url: `agnes-media:${id}` }), override);
}
