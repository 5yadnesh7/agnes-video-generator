import {
  classifyUpload,
  getPublicAppOrigin,
  MAX_UPLOAD_BYTES,
  saveUpload,
} from "@/lib/media/store";

export const maxDuration = 30;

function jsonError(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "Expected a multipart file upload.");
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return jsonError(400, "Choose a file.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonError(400, "File must be 15 MB or smaller.");
  }

  const classified = classifyUpload(file.type, file.name);
  if (!classified.ok) {
    return jsonError(400, classified.detail);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return jsonError(400, "File must be 15 MB or smaller.");
  }

  try {
    const id = await saveUpload(bytes, classified.contentType, file.name);
    const origin = getPublicAppOrigin();
    const url = origin.ok ? `${origin.origin}/api/media/${id}` : `agnes-media:${id}`;
    return Response.json({ id, url });
  } catch {
    return jsonError(502, "Could not store this file. Try again, or paste a public https:// URL.");
  }
}
