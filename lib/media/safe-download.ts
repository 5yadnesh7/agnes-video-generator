import "server-only";

import { lookup } from "node:dns/promises";
import { writeFile } from "node:fs/promises";
import { isIP } from "node:net";

export const MAX_CLIP_BYTES = 40 * 1024 * 1024;

function failPublic(): Error {
  return new Error("url must be a public https:// address.");
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = parts[0];
  const b = parts[1];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const n = ip.toLowerCase();
  if (n === "::1" || n === "::") return true;
  if (n.startsWith("fe80:") || n.startsWith("fc") || n.startsWith("fd")) return true;
  if (n.startsWith("::ffff:")) {
    const v4 = n.slice("::ffff:".length);
    return isIP(v4) === 4 ? isPrivateIPv4(v4) : true;
  }
  return false;
}

export async function assertSafeHttpsUrl(raw: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw failPublic();
  }
  if (parsed.protocol !== "https:") throw failPublic();
  if (parsed.username || parsed.password) throw failPublic();

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  ) {
    throw failPublic();
  }

  const kind = isIP(host);
  if (kind === 4 && isPrivateIPv4(host)) throw failPublic();
  if (kind === 6 && isPrivateIPv6(host)) throw failPublic();
  if (kind === 0) {
    const { address, family } = await lookup(host);
    if (family === 4 && isPrivateIPv4(address)) throw failPublic();
    if (family === 6 && isPrivateIPv6(address)) throw failPublic();
  }
  return parsed.href;
}

async function fetchNoPrivateRedirect(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    current = await assertSafeHttpsUrl(current);
    const res = await fetch(current, { signal, cache: "no-store", redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("Could not download the clip.");
      current = new URL(loc, current).href;
      continue;
    }
    return res;
  }
  throw new Error("Could not download the clip.");
}

export async function downloadHttpsToFile(
  url: string,
  dest: string,
  timeoutMs: number,
  failDetail: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchNoPrivateRedirect(url, ac.signal);
    if (!res.ok || !res.body) {
      return { ok: false, detail: failDetail };
    }
    const declared = res.headers.get("content-length");
    if (declared && Number(declared) > MAX_CLIP_BYTES) {
      return { ok: false, detail: "Clip is too large to download." };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_CLIP_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, detail: "Clip is too large to download." };
      }
      chunks.push(value);
    }
    await writeFile(dest, Buffer.concat(chunks));
    return { ok: true };
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      return { ok: false, detail: "Timed out downloading the clip." };
    }
    if (err instanceof Error && err.message === "url must be a public https:// address.") {
      return { ok: false, detail: err.message };
    }
    return { ok: false, detail: failDetail };
  } finally {
    clearTimeout(timer);
  }
}
