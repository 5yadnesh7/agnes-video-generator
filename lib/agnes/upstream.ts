import "server-only";

import { DEFAULT_IMAGE_MODEL, isImageModelId, UPSTREAM_TIMEOUT_MS, MODEL_FLASH, MODEL_V20 } from "./constants";
import { getAgnesOrigin } from "./origin";
import {
  isJobStatus,
  isModelId,
  isPublicHttpsUrl,
  type CreateSuccess,
  type JobStatus,
  type ModelId,
  type StatusSuccess,
} from "./types";
import { assertSafeHttpsUrl } from "@/lib/media/safe-download";
import { isAgnesMediaRef, resolveAgnesMediaUrl } from "@/lib/media/store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function peelJsonString(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function quotedMessages(value: string): string[] {
  const out: string[] = [];
  const re = /"message"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    try {
      out.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      out.push(match[1]);
    }
  }
  return out;
}

/** Innermost Agnes/LiteLLM error string. Their 400s often nest JSON inside `message`. */
function extractDetail(parsed: unknown): string | undefined {
  const texts: string[] = [];

  function walk(value: unknown, depth: number): void {
    if (value == null || depth > 10) return;
    if (typeof value === "string") {
      const nested = peelJsonString(value);
      if (nested !== null) {
        walk(nested, depth + 1);
        return;
      }
      const quoted = quotedMessages(value);
      if (quoted.length > 0) {
        for (const item of quoted) walk(item, depth + 1);
        return;
      }
      const trimmed = value.trim();
      if (trimmed) texts.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    if ("msg" in value) walk(value.msg, depth + 1);
    if ("detail" in value) walk(value.detail, depth + 1);
    if ("error" in value) walk(value.error, depth + 1);
    if ("message" in value) walk(value.message, depth + 1);
  }

  walk(parsed, 0);
  const human = texts.filter((t) => t.length > 0 && t.length < 400 && !t.startsWith("{"));
  return human.at(-1);
}

function jsonError(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

function mapHttpStatus(agnesStatus: number): number {
  if (agnesStatus === 400) return 400;
  if (agnesStatus === 401) return 401;
  if (agnesStatus === 403) return 403;
  if (agnesStatus === 404) return 404;
  if (agnesStatus === 429) return 429;
  if (agnesStatus === 503) return 503;
  return 502;
}

function defaultErrorCopy(status: number): string {
  if (status === 400) return "Bad request.";
  if (status === 401 || status === 403) return "Agnes rejected the API key.";
  if (status === 429) return "Agnes rate limit (429). Wait and try again.";
  return "Agnes is unavailable or the job was not found.";
}

/** Agnes 401s often say 无效的令牌 even when their DB lookup is broken. */
function humanizeDetail(detail: string): string {
  if (detail.includes("无效的令牌")) {
    return "Agnes rejected the API token (401) and reported a database error on their side. Wait, then retry. If it keeps failing, check AGNES_API_KEY.";
  }
  return detail;
}

function missingKeyCopy(): string {
  return "Add an Agnes API key in the header, or set AGNES_API_KEY in .env and restart.";
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function agnesFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const outer = init.signal;
  const onOuterAbort = () => controller.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  if (outer?.aborted) {
    clearTimeout(timer);
    outer.removeEventListener("abort", onOuterAbort);
    throw new DOMException("Aborted", "AbortError");
  }
  try {
    return await fetch(`${getAgnesOrigin()}${path}`, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

function shapeCreateSuccess(parsed: unknown, pollModel: ModelId): CreateSuccess | null {
  if (!isRecord(parsed)) return null;
  const video_id = asString(parsed.video_id);
  if (!video_id) return null;

  const out: CreateSuccess = {
    id: asString(parsed.id) ?? video_id,
    video_id,
    model: pollModel,
  };
  const task_id = asString(parsed.task_id);
  if (task_id) out.task_id = task_id;
  const object = asString(parsed.object);
  if (object) out.object = object;
  const status = asString(parsed.status);
  if (status) out.status = status;
  const progress = asNumber(parsed.progress);
  if (progress !== undefined) out.progress = progress;
  const created_at = asNumber(parsed.created_at);
  if (created_at !== undefined) out.created_at = created_at;
  const seconds = asString(parsed.seconds);
  if (seconds) out.seconds = seconds;
  const size = asString(parsed.size);
  if (size) out.size = size;
  return out;
}

function publicHttps(value: unknown): string | null {
  const url = asString(value);
  if (!url || !isPublicHttpsUrl(url)) return null;
  return url;
}

function completedUrl(parsed: Record<string, unknown>, status: JobStatus): string | null {
  if (status !== "completed") return null;
  const metadata = parsed.metadata;
  const fromMeta = isRecord(metadata) ? publicHttps(metadata.url) : null;
  if (fromMeta) return fromMeta;
  return publicHttps(parsed.url);
}

function shapeStatusSuccess(parsed: unknown): StatusSuccess | null {
  if (!isRecord(parsed)) return null;
  if (!isJobStatus(parsed.status)) return null;

  const errorObj = isRecord(parsed.error) ? parsed.error : null;
  const errorMessage = errorObj ? asString(errorObj.message) : undefined;
  const url = completedUrl(parsed, parsed.status);

  const out: StatusSuccess = {
    status: parsed.status,
    metadata: url ? { url } : null,
    error: errorMessage ? { message: errorMessage } : null,
  };
  const id = asString(parsed.id);
  if (id) out.id = id;
  const task_id = asString(parsed.task_id);
  if (task_id) out.task_id = task_id;
  const video_id = asString(parsed.video_id);
  if (video_id) out.video_id = video_id;
  const model = asString(parsed.model);
  if (model) out.model = model;
  const progress = asNumber(parsed.progress);
  if (progress !== undefined) out.progress = progress;
  const seconds = asString(parsed.seconds);
  if (seconds) out.seconds = seconds;
  const size = asString(parsed.size);
  if (size) out.size = size;
  return out;
}

async function mapAgnesResponse(
  res: Response,
  kind: "create" | "status",
  pollModel?: ModelId,
): Promise<Response> {
  const parsed = await parseJsonSafe(res);

  if (!res.ok) {
    const mapped = mapHttpStatus(res.status);
    return jsonError(
      mapped,
      humanizeDetail(extractDetail(parsed) ?? defaultErrorCopy(mapped)),
    );
  }

  if (kind === "create") {
    if (!pollModel) {
      return jsonError(502, "Agnes is unavailable or the job was not found.");
    }
    const body = shapeCreateSuccess(parsed, pollModel);
    if (!body) return jsonError(502, "Agnes is unavailable or the job was not found.");
    return Response.json(body);
  }

  const body = shapeStatusSuccess(parsed);
  if (!body) return jsonError(502, "Agnes is unavailable or the job was not found.");
  return Response.json(body);
}

function networkError(err: unknown): Response {
  if (err instanceof DOMException && err.name === "AbortError") {
    return jsonError(502, "Agnes is unavailable or the job was not found.");
  }
  if (err instanceof Error && err.name === "AbortError") {
    return jsonError(502, "Agnes is unavailable or the job was not found.");
  }
  return jsonError(502, "Agnes is unavailable or the job was not found.");
}

export async function createVideo(
  body: Record<string, unknown>,
  pollModel: ModelId,
  apiKey: string | null,
): Promise<Response> {
  const key = apiKey;
  if (!key) {
    return jsonError(401, missingKeyCopy());
  }

  try {
    const res = await agnesFetch("/v1/videos", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return await mapAgnesResponse(res, "create", pollModel);
  } catch (err) {
    return networkError(err);
  }
}

export async function pollVideo(
  videoId: string,
  modelName: ModelId,
  signal?: AbortSignal,
  apiKey?: string | null,
): Promise<Response> {
  const key = apiKey ?? null;
  if (!key) {
    return jsonError(401, missingKeyCopy());
  }

  const params = new URLSearchParams({
    video_id: videoId,
    model_name: modelName,
  });

  try {
    const res = await agnesFetch(`/agnesapi?${params.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
      },
      signal,
    });
    return await mapAgnesResponse(res, "status");
  } catch (err) {
    return networkError(err);
  }
}

export async function parsePollResponse(
  res: Response,
): Promise<
  | { ok: true; data: StatusSuccess }
  | { ok: false; status: number; detail: string }
> {
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      detail: humanizeDetail(extractDetail(parsed) ?? defaultErrorCopy(res.status)),
    };
  }
  const data = shapeStatusSuccess(parsed);
  if (!data) {
    return {
      ok: false,
      status: 502,
      detail: "Agnes is unavailable or the job was not found.",
    };
  }
  return { ok: true, data };
}

const CHAT_TIMEOUT_MS = 90_000;
const STORYBOARD_CHAT_MODEL = "agnes-2.5-flash";

function shapeChatContent(parsed: unknown): string | null {
  if (!isRecord(parsed)) return null;
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (isRecord(message) && typeof message.content === "string") {
    const content = message.content.trim();
    return content.length > 0 ? content : null;
  }
  if (typeof first.text === "string") {
    const text = first.text.trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

export async function chatCompletion(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  apiKey: string | null,
  timeoutMs: number = CHAT_TIMEOUT_MS,
): Promise<{ ok: true; content: string } | { ok: false; status: number; detail: string }> {
  const key = apiKey;
  if (!key) {
    return { ok: false, status: 401, detail: missingKeyCopy() };
  }

  try {
    const res = await agnesFetch(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: STORYBOARD_CHAT_MODEL,
          messages,
        }),
      },
      timeoutMs,
    );
    const parsed = await parseJsonSafe(res);
    if (!res.ok) {
      const mapped = mapHttpStatus(res.status);
      return {
        ok: false,
        status: mapped,
        detail: humanizeDetail(extractDetail(parsed) ?? defaultErrorCopy(mapped)),
      };
    }
    const content = shapeChatContent(parsed);
    if (!content) {
      return { ok: false, status: 502, detail: "Agnes is unavailable or the job was not found." };
    }
    return { ok: true, content };
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      return { ok: false, status: 502, detail: "Agnes is unavailable or the job was not found." };
    }
    return { ok: false, status: 502, detail: "Agnes is unavailable or the job was not found." };
  }
}

const IMAGE_TIMEOUT_MS = 90_000;

async function resolveImageInputs(raw: string[]): Promise<string[] | { error: string }> {
  const out: string[] = [];
  for (const item of raw) {
    const text = item.trim();
    if (!text) continue;
    if (text.startsWith("data:")) {
      return { error: "Sample image must be a stored file or a public https:// URL." };
    }
    if (isAgnesMediaRef(text)) {
      try {
        out.push(await resolveAgnesMediaUrl(text));
      } catch {
        return { error: "Sample image is gone. Upload it again." };
      }
      continue;
    }
    if (isPublicHttpsUrl(text)) {
      out.push(text);
      continue;
    }
    return { error: "Sample image must be a stored file or a public https:// URL." };
  }
  return out;
}

function shapeImageB64(parsed: unknown): { mime: string; b64: string } | { url: string } | null {
  if (!isRecord(parsed)) return null;
  const data = parsed.data;
  const first = Array.isArray(data) ? data[0] : null;
  if (!isRecord(first)) return null;
  const b64 = typeof first.b64_json === "string" ? first.b64_json.trim() : "";
  if (b64) {
    const raw = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
    return { mime: "image/png", b64: raw };
  }
  const url = typeof first.url === "string" ? first.url.trim() : "";
  if (url.startsWith("https://")) return { url };
  return null;
}

export async function generateImagePng(
  prompt: string,
  apiKey: string | null,
  opts?: { ratio?: string; model?: string; images?: string[] },
): Promise<
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; status: number; detail: string }
> {
  const key = apiKey;
  if (!key) {
    return { ok: false, status: 401, detail: missingKeyCopy() };
  }
  const ratio = opts?.ratio?.trim() || "1:1";
  const model = isImageModelId(opts?.model) ? opts.model : DEFAULT_IMAGE_MODEL;
  const extraBody: Record<string, unknown> = { response_format: "b64_json" };
  if (opts?.images && opts.images.length > 0) {
    const resolved = await resolveImageInputs(opts.images);
    if ("error" in resolved) {
      return { ok: false, status: 400, detail: resolved.error };
    }
    if (resolved.length > 0) extraBody.image = resolved;
  }
  try {
    const res = await agnesFetch(
      "/v1/images/generations",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt,
          size: "1K",
          ratio,
          return_base64: extraBody.image ? undefined : true,
          extra_body: extraBody,
        }),
      },
      IMAGE_TIMEOUT_MS,
    );
    const parsed = await parseJsonSafe(res);
    if (!res.ok) {
      const mapped = mapHttpStatus(res.status);
      return {
        ok: false,
        status: mapped,
        detail: humanizeDetail(extractDetail(parsed) ?? defaultErrorCopy(mapped)),
      };
    }
    const shaped = shapeImageB64(parsed);
    if (!shaped) {
      return { ok: false, status: 502, detail: "Character sheet did not return an image." };
    }
    if ("b64" in shaped) {
      return {
        ok: true,
        bytes: Buffer.from(shaped.b64, "base64"),
        contentType: shaped.mime,
      };
    }
    await assertSafeHttpsUrl(shaped.url);
    const dl = await fetch(shaped.url, { cache: "no-store", redirect: "error" });
    if (!dl.ok) {
      return { ok: false, status: 502, detail: "Could not download the character sheet." };
    }
    const buf = Buffer.from(await dl.arrayBuffer());
    return { ok: true, bytes: buf, contentType: "image/png" };
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      return { ok: false, status: 502, detail: "Character sheet timed out." };
    }
    return { ok: false, status: 502, detail: "Could not generate the character sheet." };
  }
}

export function parseStatusQuery(
  videoId: string | null,
  modelName: string | null,
): { ok: true; videoId: string; modelName: ModelId } | { ok: false; detail: string } {
  if (!videoId || videoId.trim() === "") {
    return { ok: false, detail: "video_id is required." };
  }
  if (!isModelId(modelName)) {
    return {
      ok: false,
      detail: `model_name must be ${MODEL_V20} or ${MODEL_FLASH}.`,
    };
  }
  return { ok: true, videoId: videoId.trim(), modelName };
}
