import { readUpload } from "@/lib/media/store";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const stored = await readUpload(id);
  if (!stored) {
    return Response.json({ detail: "Not found." }, { status: 404 });
  }

  return new Response(new Uint8Array(stored.bytes), {
    headers: {
      "Content-Type": stored.contentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=300",
    },
  });
}
