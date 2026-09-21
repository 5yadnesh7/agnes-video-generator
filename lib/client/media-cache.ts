const CACHE_NAME = "agnes-media-v1";
const META_KEY = "agnes-media-v1-meta";
const TTL_MS = 6 * 60 * 60 * 1000;

type Meta = Record<string, number>;

const inflight = new Map<string, Promise<Response>>();

function readMeta(): Meta {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Meta;
  } catch {
    return {};
  }
}

function writeMeta(meta: Meta): void {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

async function drop(cache: Cache, url: string, meta: Meta): Promise<void> {
  await cache.delete(url);
  delete meta[url];
}

async function purgeExpired(cache: Cache, meta: Meta): Promise<void> {
  const now = Date.now();
  for (const [url, savedAt] of Object.entries(meta)) {
    if (typeof savedAt !== "number" || now - savedAt >= TTL_MS) {
      await drop(cache, url, meta);
    }
  }
}

async function cachedResponse(src: string, key: string): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const meta = readMeta();
  await purgeExpired(cache, meta);

  const savedAt = meta[key];
  if (typeof savedAt === "number" && Date.now() - savedAt >= TTL_MS) {
    await drop(cache, key, meta);
  }

  const hit = await cache.match(key);
  if (hit?.ok) {
    writeMeta(meta);
    return hit;
  }

  let pending = inflight.get(key);
  if (!pending) {
    pending = fetch(src, { cache: "no-store" }).then(async (res) => {
      if (res.ok) {
        await cache.put(key, res.clone());
        meta[key] = Date.now();
        writeMeta(meta);
      } else {
        writeMeta(meta);
      }
      return res;
    });
    inflight.set(key, pending);
  }
  try {
    const res = await pending;
    if (res.ok) {
      const stored = await cache.match(key);
      if (stored) return stored;
    }
    return res;
  } finally {
    inflight.delete(key);
  }
}

/**
 * First miss: one same-origin fetch → one R2 read on the server.
 * Later: Cache API blob, no R2.
 * After 6 hours the file is deleted; next view pays one read again.
 */
export async function localMediaUrl(src: string): Promise<string> {
  if (!src) return src;
  if (src.startsWith("blob:") || src.startsWith("data:")) return src;
  if (typeof caches === "undefined") return src;

  const key = new URL(src, window.location.origin).href;
  try {
    const res = await cachedResponse(src, key);
    if (!res.ok) return src;
    const blob = await res.blob();
    if (!blob.size) return src;
    return URL.createObjectURL(blob);
  } catch {
    return src;
  }
}
