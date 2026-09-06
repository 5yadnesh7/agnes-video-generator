import { pollVideo, parseStatusQuery } from "@/lib/agnes/upstream";

export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseStatusQuery(
    url.searchParams.get("video_id"),
    url.searchParams.get("model_name"),
  );
  if (!parsed.ok) {
    return Response.json({ detail: parsed.detail }, { status: 400 });
  }
  return pollVideo(parsed.videoId, parsed.modelName);
}
