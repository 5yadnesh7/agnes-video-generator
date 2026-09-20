import { pollAgnesKey } from "@/lib/agnes/api-key";
import { abortJobPoller, subscribeJobPoller } from "@/lib/agnes/job-poller";
import { parseStatusQuery } from "@/lib/agnes/upstream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Hobby Fluid max is 300s; 930 was over every Vercel plan and failed deploy after `next build`. */
export const maxDuration = 300;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function encodeEvent(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseStatusQuery(
    url.searchParams.get("video_id"),
    url.searchParams.get("model_name"),
  );
  if (!parsed.ok) {
    return Response.json({ detail: parsed.detail }, { status: 400 });
  }

  const { videoId, modelName } = parsed;
  const resume = url.searchParams.get("resume") === "1";
  const apiKey = pollAgnesKey(request);

  let unsub = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown) => {
        try {
          controller.enqueue(encodeEvent(event, data));
        } catch {
          unsub();
        }
      };
      try {
        controller.enqueue(new TextEncoder().encode(": ok\n\n"));
      } catch {
        return;
      }
      const sub = subscribeJobPoller({
        videoId,
        modelName,
        resume,
        apiKey,
        emit,
      });
      unsub = sub.unsubscribe;
      try {
        await sub.done;
      } finally {
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed or cancelled */
        }
      }
    },
    cancel() {
      unsub();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return Response.json({ detail: "video_id is required." }, { status: 400 });
  }
  const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  const parsed = parseStatusQuery(
    rec && typeof rec.video_id === "string" ? rec.video_id : null,
    rec && typeof rec.model_name === "string" ? rec.model_name : null,
  );
  if (!parsed.ok) {
    return Response.json({ detail: parsed.detail }, { status: 400 });
  }
  abortJobPoller(parsed.videoId, parsed.modelName);
  return Response.json({ ok: true });
}
