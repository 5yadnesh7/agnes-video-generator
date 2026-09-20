import "server-only";

import { agnesPollDelayMs, POLL_CAP_MS, STATUS_QUERY_LIMIT_BACKOFF_MS } from "@/lib/agnes/constants";
import { isAgnesStatusQueryLimit } from "@/lib/agnes/errors";
import type { JobStatus, ModelId } from "@/lib/agnes/types";
import { parsePollResponse, pollVideo } from "@/lib/agnes/upstream";

const STREAM_CAP_MS = process.env.VERCEL ? 280_000 : POLL_CAP_MS;

type Subscriber = (event: string, data: unknown) => void;

type RunningJob = {
  subscribers: Set<Subscriber>;
  abort: AbortController;
  done: Promise<void>;
  last?: { event: string; data: unknown };
};

const running = new Map<string, RunningJob>();

function jobKey(videoId: string, modelName: ModelId): string {
  return `${modelName}:${videoId}`;
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

function broadcast(job: RunningJob, event: string, data: unknown): void {
  job.last = { event, data };
  for (const sub of [...job.subscribers]) {
    try {
      sub(event, data);
    } catch {
      job.subscribers.delete(sub);
    }
  }
}

async function runPollLoop(
  job: RunningJob,
  videoId: string,
  modelName: ModelId,
  apiKey: string | null,
  resume: boolean,
): Promise<void> {
  const startedAt = Date.now();
  let pollIndex = 0;
  let delay = agnesPollDelayMs(0, resume);
  let lastStatus: JobStatus | undefined;

  try {
    while (!job.abort.signal.aborted) {
      try {
        if (Date.now() - startedAt >= STREAM_CAP_MS) {
          broadcast(job, "timeout", lastStatus ? { status: lastStatus } : {});
          break;
        }

        if (delay > 0) await sleep(delay, job.abort.signal);

        if (Date.now() - startedAt >= STREAM_CAP_MS) {
          broadcast(job, "timeout", lastStatus ? { status: lastStatus } : {});
          break;
        }

        const result = await parsePollResponse(
          await pollVideo(videoId, modelName, job.abort.signal, apiKey),
        );
        if (job.abort.signal.aborted) break;

        if (result.ok) {
          const st = result.data.status;
          if (st === "completed") {
            broadcast(job, "completed", {
              status: "completed",
              url: result.data.metadata?.url ?? null,
            });
            break;
          }
          if (st === "queued" || st === "in_progress") {
            lastStatus = st;
            const payload: { status: JobStatus; progress?: number } = { status: st };
            if (result.data.progress !== undefined) payload.progress = result.data.progress;
            broadcast(job, "status", payload);
          } else {
            broadcast(job, "retry", { message: "Still checking…" });
          }
          pollIndex += 1;
          delay = agnesPollDelayMs(pollIndex, resume);
          continue;
        }

        if (result.status === 401) {
          broadcast(job, "stream_error", { message: result.detail });
          break;
        }

        if (result.status === 429 || isAgnesStatusQueryLimit(result.detail)) {
          broadcast(job, "retry", {
            message: result.detail || "Too many status checks. Next check in 1 minute.",
          });
          delay = STATUS_QUERY_LIMIT_BACKOFF_MS;
          continue;
        }

        broadcast(job, "retry", { message: result.detail || "Checking again…" });
        pollIndex += 1;
        delay = agnesPollDelayMs(pollIndex, resume);
      } catch (err) {
        if (isAbort(err) || job.abort.signal.aborted) break;
        broadcast(job, "retry", { message: "Checking again…" });
        pollIndex += 1;
        delay = agnesPollDelayMs(pollIndex, resume);
      }
    }
  } catch (err) {
    if (!isAbort(err) && !job.abort.signal.aborted) {
      broadcast(job, "retry", { message: "Checking again…" });
    }
  }
}

function startJob(
  videoId: string,
  modelName: ModelId,
  apiKey: string | null,
  resume: boolean,
): RunningJob {
  const job: RunningJob = {
    subscribers: new Set(),
    abort: new AbortController(),
    done: Promise.resolve(),
  };
  job.done = runPollLoop(job, videoId, modelName, apiKey, resume).finally(() => {
    const current = running.get(jobKey(videoId, modelName));
    if (current === job) running.delete(jobKey(videoId, modelName));
  });
  return job;
}

export function abortJobPoller(videoId: string, modelName: ModelId): void {
  const key = jobKey(videoId, modelName);
  const job = running.get(key);
  if (!job) return;
  job.abort.abort();
  running.delete(key);
}

export function subscribeJobPoller(opts: {
  videoId: string;
  modelName: ModelId;
  resume: boolean;
  apiKey: string | null;
  emit: Subscriber;
}): { unsubscribe: () => void; done: Promise<void> } {
  const key = jobKey(opts.videoId, opts.modelName);
  let job = running.get(key);
  if (!job || job.abort.signal.aborted) {
    job = startJob(opts.videoId, opts.modelName, opts.apiKey, opts.resume);
    running.set(key, job);
  }
  job.subscribers.add(opts.emit);
  if (job.last) opts.emit(job.last.event, job.last.data);
  return {
    unsubscribe: () => {
      job.subscribers.delete(opts.emit);
    },
    done: job.done,
  };
}
