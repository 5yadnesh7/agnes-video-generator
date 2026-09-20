import { isJobStatus, type JobStatus, type ModelId } from "@/lib/agnes/types";

function parseEventPayload(raw: string): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    /* ignore malformed event bodies */
  }
  return null;
}

export type JobSseHandlers = {
  onStatus: (status: JobStatus, progress?: number) => void;
  onCompleted: (url: string | null) => void;
  onAuthError: (message: string) => void;
};

export function openJobSse(
  videoId: string,
  modelName: ModelId,
  signal: AbortSignal,
  handlers: JobSseHandlers,
  resume = false,
): void {
  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let useResume = resume;
  let stopped = false;

  const cleanupEs = () => {
    es?.close();
    es = null;
  };

  const stopAll = () => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanupEs();
    document.removeEventListener("visibilitychange", onShow);
    window.removeEventListener("pageshow", onShow);
  };

  const scheduleReconnect = () => {
    if (stopped || signal.aborted) return;
    cleanupEs();
    useResume = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
  };

  const onShow = () => {
    if (stopped || signal.aborted) return;
    if (document.visibilityState === "hidden") return;
    if (es && es.readyState !== EventSource.CLOSED) return;
    scheduleReconnect();
  };

  const connect = () => {
    if (stopped || signal.aborted) return;
    cleanupEs();
    const params = new URLSearchParams({
      video_id: videoId,
      model_name: modelName,
    });
    if (useResume) params.set("resume", "1");
    const next = new EventSource(`/api/videos/events?${params.toString()}`);
    es = next;

    next.addEventListener("status", (e: MessageEvent) => {
      if (stopped) return;
      const data = parseEventPayload(e.data);
      if (!data || !isJobStatus(data.status)) return;
      if (data.status !== "queued" && data.status !== "in_progress") return;
      handlers.onStatus(
        data.status,
        typeof data.progress === "number" && Number.isFinite(data.progress)
          ? data.progress
          : undefined,
      );
    });

    next.addEventListener("completed", (e: MessageEvent) => {
      if (stopped) return;
      const data = parseEventPayload(e.data);
      const url = data && typeof data.url === "string" ? data.url : null;
      stopAll();
      handlers.onCompleted(url);
    });

    next.addEventListener("timeout", () => {
      if (stopped) return;
      scheduleReconnect();
    });

    next.addEventListener("stream_error", (e: MessageEvent) => {
      if (stopped) return;
      const data = parseEventPayload(e.data);
      const message =
        data && typeof data.message === "string" && data.message.length > 0
          ? data.message
          : "Add an Agnes API key.";
      stopAll();
      handlers.onAuthError(message);
    });

    next.addEventListener("error", () => {
      if (stopped) return;
      scheduleReconnect();
    });
  };

  signal.addEventListener("abort", stopAll);
  if (signal.aborted) {
    stopAll();
    return;
  }
  document.addEventListener("visibilitychange", onShow);
  window.addEventListener("pageshow", onShow);
  connect();
}

export async function abortServerJob(videoId: string, modelName: ModelId): Promise<void> {
  try {
    await fetch("/api/videos/events", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId, model_name: modelName }),
    });
  } catch {
    /* ignore */
  }
}
