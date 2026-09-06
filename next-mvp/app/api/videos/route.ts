import { MODEL_V20 } from "@/lib/agnes/constants";
import { buildCreateBody, parseCreateRequest } from "@/lib/agnes/payloads";
import { createVideo } from "@/lib/agnes/upstream";
import type { CreateRequest } from "@/lib/agnes/types";
import { isAgnesMediaRef, purgeExpiredUploads, resolveAgnesMediaUrl } from "@/lib/media/store";

export const maxDuration = 30;

async function resolveOne(value: string): Promise<string> {
  if (isAgnesMediaRef(value)) return resolveAgnesMediaUrl(value);
  return value;
}

async function resolveRequestMedia(req: CreateRequest): Promise<void> {
  if (req.model === MODEL_V20) {
    if (req.image !== undefined) req.image = await resolveOne(req.image);
    if (req.keyframe_images !== undefined) {
      req.keyframe_images = await Promise.all(req.keyframe_images.map(resolveOne));
    }
    return;
  }
  if (req.first_frame !== undefined) req.first_frame = await resolveOne(req.first_frame);
  if (req.last_frame !== undefined) req.last_frame = await resolveOne(req.last_frame);
  if (req.images !== undefined) {
    req.images = await Promise.all(req.images.map(resolveOne));
  }
  if (req.audios !== undefined) {
    req.audios = await Promise.all(req.audios.map(resolveOne));
  }
}

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ detail: "Invalid JSON." }, { status: 400 });
  }

  const parsed = parseCreateRequest(json);
  if (!parsed.ok) {
    return Response.json({ detail: parsed.detail }, { status: 400 });
  }

  await purgeExpiredUploads();

  try {
    await resolveRequestMedia(parsed.value);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "File is gone. Upload again.";
    return Response.json({ detail }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = buildCreateBody(parsed.value);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Invalid request.";
    return Response.json({ detail }, { status: 400 });
  }

  return createVideo(body, parsed.value.model);
}
