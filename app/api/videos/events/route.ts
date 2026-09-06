import { agnesPollDelayMs, POLL_CAP_MS } from "@/lib/agnes/constants";
import { pollAgnesKey } from "@/lib/agnes/api-key";
import type { JobStatus } from "@/lib/agnes/types";
import { parseStatusQuery, parsePollResponse, pollVideo } from "@/lib/agnes/upstream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Hobby Fluid max is 300s; 930 was over every Vercel plan and failed deploy after `next build`. */
export const maxDuration = 300;

const STREAM_CAP_MS = process.env.VERCEL ? 280_000 : POLL_CAP_MS;

const BACKOFF_MS = [3000, 6000, 8000] as const;
const NET_RETRY_LIMIT = 3;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function backoffMs(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[i];
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort);
  });
}

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
  const ac = new AbortController();
  const onClientAbort = () => ac.abort();
  request.signal.addEventListener("abort", onClientAbort);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown) => {
        if (ac.signal.aborted) return;
        controller.enqueue(encodeEvent(event, data));
      };

      try {
        controller.enqueue(new TextEncoder().encode(": ok\n\n"));
        const startedAt = Date.now();
        let pollIndex = 0;
        let delay = agnesPollDelayMs(0);
        let rateFails = 0;
        let netFails = 0;
        let lastStatus: JobStatus | undefined;

        while (!ac.signal.aborted) {
          if (Date.now() - startedAt >= STREAM_CAP_MS) {
            emit("timeout", lastStatus ? { status: lastStatus } : {});
            break;
          }

          if (delay > 0) await sleep(delay, ac.signal);

          if (Date.now() - startedAt >= STREAM_CAP_MS) {
            emit("timeout", lastStatus ? { status: lastStatus } : {});
            break;
          }

          const result = await parsePollResponse(
            await pollVideo(videoId, modelName, ac.signal, pollAgnesKey(request)),
          );
          if (ac.signal.aborted) break;

          if (result.ok) {
            rateFails = 0;
            netFails = 0;
            const st = result.data.status;
            if (st === "completed") {
              emit("completed", {
                status: "completed",
                url: result.data.metadata?.url ?? null,
              });
              break;
            }
            if (st === "failed") {
              emit("failed", {
                status: "failed",
                message: result.data.error?.message ?? "Generation failed.",
              });
              break;
            }
            lastStatus = st;
            const payload: { status: JobStatus; progress?: number } = { status: st };
            if (result.data.progress !== undefined) payload.progress = result.data.progress;
            emit("status", payload);
            pollIndex += 1;
            delay = agnesPollDelayMs(pollIndex);
            continue;
          }

          if (result.status === 429) {
            rateFails += 1;
            delay = agnesPollDelayMs(pollIndex) + backoffMs(rateFails);
            continue;
          }

          if (result.status === 502 || result.status === 503) {
            netFails += 1;
            if (netFails >= NET_RETRY_LIMIT) {
              emit("stream_error", { message: "Status check failed. You can check status." });
              break;
            }
            delay = backoffMs(netFails);
            continue;
          }

          emit("stream_error", { message: result.detail });
          break;
        }
      } catch (err) {
        if (!isAbort(err) && !ac.signal.aborted) {
          controller.enqueue(
            encodeEvent("stream_error", { message: "Status check failed. You can check status." }),
          );
        }
      } finally {
        request.signal.removeEventListener("abort", onClientAbort);
        try {
          controller.close();
        } catch {
          /* already closed or cancelled */
        }
      }
    },
    cancel() {
      ac.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
