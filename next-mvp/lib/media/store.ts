import "server-only";

import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { isPublicHttpsUrl } from "@/lib/agnes/types";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/** Local upload bytes + meta are deleted this long after last write. */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;

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

type Meta = { contentType: string; filename: string };

function uploadsDir(): string {
  return path.resolve(process.cwd(), ".data", "uploads");
}

function extOf(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

function safeFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "file";
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 200);
  return cleaned.length > 0 ? cleaned : "file";
}

function isMediaId(id: string): boolean {
  return UUID_RE.test(id);
}

function mediaIdFromName(name: string): string | null {
  const id = name.endsWith(".json") ? name.slice(0, -5) : name;
  return isMediaId(id) ? id : null;
}

let sweepInFlight: Promise<void> | null = null;

/** Delete UUID uploads (file + `.json`) whose mtime is older than `UPLOAD_TTL_MS`. */
export async function purgeExpiredUploads(): Promise<void> {
  if (!sweepInFlight) {
    sweepInFlight = runPurge().finally(() => {
      sweepInFlight = null;
    });
  }
  try {
    await sweepInFlight;
  } catch {
    /* sweep must not break upload or generate */
  }
}

async function runPurge(): Promise<void> {
  const dir = uploadsDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return;
    throw err;
  }

  const ids = new Set<string>();
  for (const name of names) {
    const id = mediaIdFromName(name);
    if (id) ids.add(id);
  }

  const cutoff = Date.now() - UPLOAD_TTL_MS;
  await Promise.all(
    [...ids].map(async (id) => {
      const filePath = resolveUploadPath(id);
      if (!filePath) return;
      const metaPath = `${filePath}.json`;
      let newest = 0;
      for (const p of [filePath, metaPath]) {
        try {
          const st = await stat(p);
          newest = Math.max(newest, st.mtimeMs);
        } catch {
          /* missing half of a pair */
        }
      }
      if (newest === 0 || newest > cutoff) return;
      await unlink(filePath).catch(() => undefined);
      await unlink(metaPath).catch(() => undefined);
    }),
  );
}

function resolveUploadPath(id: string): string | null {
  if (!isMediaId(id)) return null;
  const root = uploadsDir();
  const filePath = path.resolve(root, id);
  const rel = path.relative(root, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return filePath;
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

export async function saveUpload(
  bytes: Uint8Array,
  contentType: string,
  filename: string,
): Promise<string> {
  await purgeExpiredUploads();
  const id = crypto.randomUUID();
  const dir = uploadsDir();
  await mkdir(dir, { recursive: true });
  const filePath = resolveUploadPath(id);
  if (!filePath) throw new Error("Could not store this file.");
  const metaPath = `${filePath}.json`;
  const meta: Meta = { contentType, filename: safeFilename(filename) };
  try {
    await writeFile(filePath, bytes);
    await writeFile(metaPath, JSON.stringify(meta));
  } catch (err) {
    await unlink(filePath).catch(() => undefined);
    await unlink(metaPath).catch(() => undefined);
    throw err;
  }
  return id;
}

export function isAgnesMediaRef(value: string): boolean {
  if (!value.startsWith("agnes-media:")) return false;
  return isMediaId(value.slice("agnes-media:".length));
}

export async function resolveAgnesMediaUrl(ref: string): Promise<string> {
  if (!isAgnesMediaRef(ref)) {
    throw new Error("File is gone. Upload again.");
  }
  const id = ref.slice("agnes-media:".length);
  const stored = await readUpload(id);
  if (!stored) {
    throw new Error("File is gone. Upload again.");
  }
  return `data:${stored.contentType};base64,${stored.bytes.toString("base64")}`;
}

export async function readUpload(
  id: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  await purgeExpiredUploads();
  const filePath = resolveUploadPath(id);
  if (!filePath) return null;
  try {
    const [bytes, metaRaw] = await Promise.all([
      readFile(filePath),
      readFile(`${filePath}.json`, "utf8"),
    ]);
    const parsed: unknown = JSON.parse(metaRaw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Meta).contentType !== "string" ||
      (parsed as Meta).contentType.length === 0
    ) {
      return null;
    }
    return { bytes, contentType: (parsed as Meta).contentType };
  } catch {
    return null;
  }
}
