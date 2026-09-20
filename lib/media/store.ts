import "server-only";

import { AwsClient } from "aws4fetch";

import { isPublicHttpsUrl } from "@/lib/agnes/types";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMAGE_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const AUDIO_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/x-aac",
  "video/mp4",
]);

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  mp4: "audio/mp4",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

export type StoredUpload = { id: string; url: string };

export type R2Folder = "uploads" | "generated";

type R2Config = {
  client: AwsClient;
  bucket: string;
  endpoint: string;
  publicBase: string;
};

const R2_MISSING =
  "Set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, and R2_PUBLIC_BASE_URL in .env, then restart.";

function trimEnv(name: string): string {
  return (process.env[name] ?? "").trim();
}

function r2Config(): R2Config {
  const accessKeyId = trimEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = trimEnv("R2_SECRET_ACCESS_KEY");
  const bucket = trimEnv("R2_BUCKET");
  const publicBase = trimEnv("R2_PUBLIC_BASE_URL").replace(/\/+$/, "");
  const accountId = trimEnv("R2_ACCOUNT_ID");
  const endpoint = (
    trimEnv("R2_ENDPOINT") ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "")
  ).replace(/\/+$/, "");
  if (!accessKeyId || !secretAccessKey || !bucket || !publicBase || !endpoint) {
    throw new Error(R2_MISSING);
  }
  if (!isPublicHttpsUrl(publicBase)) {
    throw new Error("R2_PUBLIC_BASE_URL must be a public https:// URL (the r2.dev or custom domain).");
  }
  return {
    client: new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: "s3",
      region: "auto",
    }),
    bucket,
    endpoint,
    publicBase,
  };
}

function objectKey(folder: R2Folder | "agnes", id: string): string {
  return `${folder}/${id}`;
}

function publicUrlFor(cfg: R2Config, folder: R2Folder | "agnes", id: string): string {
  return `${cfg.publicBase}/${objectKey(folder, id)}`;
}

function objectUrl(cfg: R2Config, key: string): string {
  return `${cfg.endpoint}/${cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function extOf(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

function isMediaId(id: string): boolean {
  return UUID_RE.test(id);
}

export function getPublicAppOrigin(): { ok: true; origin: string } | { ok: false; detail: string } {
  const raw = process.env.PUBLIC_APP_URL;
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      detail: "Set PUBLIC_APP_URL to a public https origin Agnes can fetch (not localhost).",
    };
  }
  const origin = raw.trim().replace(/\/+$/, "");
  if (!isPublicHttpsUrl(origin)) {
    return {
      ok: false,
      detail: "Set PUBLIC_APP_URL to a public https origin Agnes can fetch (not localhost).",
    };
  }
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return {
        ok: false,
        detail: "Set PUBLIC_APP_URL to a public https origin Agnes can fetch (not localhost).",
      };
    }
  } catch {
    return {
      ok: false,
      detail: "Set PUBLIC_APP_URL to a public https origin Agnes can fetch (not localhost).",
    };
  }
  return { ok: true, origin };
}

export function classifyUpload(
  mime: string,
  filename: string,
): { ok: true; contentType: string } | { ok: false; detail: string } {
  const type = mime.trim().toLowerCase();
  if (IMAGE_MIME.has(type) || AUDIO_MIME.has(type)) {
    const contentType = type === "image/jpg" ? "image/jpeg" : type === "audio/mp3" ? "audio/mpeg" : type;
    return { ok: true, contentType };
  }
  const mapped = EXT_MIME[extOf(filename)];
  if (mapped) return { ok: true, contentType: mapped };
  return {
    ok: false,
    detail: "File type must be jpeg, png, webp, mp3, wav, mp4, m4a, or aac.",
  };
}

function asciiMeta(value: string, max = 180): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "file").slice(0, max);
}

export async function saveUpload(
  bytes: Uint8Array,
  contentType: string,
  filename: string,
  folder: R2Folder,
): Promise<StoredUpload> {
  const cfg = r2Config();
  const id = crypto.randomUUID();
  const key = objectKey(folder, id);
  const createdAt = new Date().toISOString();
  const body = Buffer.from(bytes);
  const res = await cfg.client.fetch(objectUrl(cfg, key), {
    method: "PUT",
    body,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=3600",
      "x-amz-meta-folder": folder,
      "x-amz-meta-created-at": createdAt,
      "x-amz-meta-filename": asciiMeta(filename),
    },
  });
  if (!res.ok) {
    throw new Error(`Could not store this file on Cloudflare R2 (${res.status}).`);
  }
  return { id, url: publicUrlFor(cfg, folder, id) };
}

export function isAgnesMediaRef(value: string): boolean {
  if (!value.startsWith("agnes-media:")) return false;
  return isMediaId(value.slice("agnes-media:".length));
}

export async function resolveAgnesMediaUrl(ref: string): Promise<string> {
  if (isPublicHttpsUrl(ref)) return ref;
  if (!isAgnesMediaRef(ref)) {
    throw new Error("File is gone. Upload again.");
  }
  const id = ref.slice("agnes-media:".length);
  const stored = await readUpload(id);
  if (!stored?.publicUrl || !isPublicHttpsUrl(stored.publicUrl)) {
    throw new Error("File is gone. Upload again.");
  }
  return stored.publicUrl;
}

export async function readUpload(
  id: string,
): Promise<{ bytes: Buffer; contentType: string; publicUrl?: string } | null> {
  if (!isMediaId(id)) return null;
  let cfg: R2Config;
  try {
    cfg = r2Config();
  } catch {
    return null;
  }
  const folders: Array<R2Folder | "agnes"> = ["uploads", "generated", "agnes"];
  for (const folder of folders) {
    const res = await cfg.client.fetch(objectUrl(cfg, objectKey(folder, id)), { method: "HEAD" });
    if (!res.ok) continue;
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    return { bytes: Buffer.alloc(0), contentType, publicUrl: publicUrlFor(cfg, folder, id) };
  }
  return null;
}

export async function readUploadBytes(
  id: string,
): Promise<{ bytes: Buffer; contentType: string; publicUrl?: string } | null> {
  if (!isMediaId(id)) return null;
  let cfg: R2Config;
  try {
    cfg = r2Config();
  } catch {
    return null;
  }
  const folders: Array<R2Folder | "agnes"> = ["uploads", "generated", "agnes"];
  for (const folder of folders) {
    const res = await cfg.client.fetch(objectUrl(cfg, objectKey(folder, id)), { method: "GET" });
    if (!res.ok) continue;
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) continue;
    return { bytes, contentType, publicUrl: publicUrlFor(cfg, folder, id) };
  }
  return null;
}
