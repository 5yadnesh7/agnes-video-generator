import "server-only";

export const AGNES_KEY_COOKIE = "agnes_key";

function trimKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length < 512 ? trimmed : null;
}

export function envVideoKey(): string | null {
  return trimKey(process.env.AGNES_API_KEY);
}

export function envStoryKey(): string | null {
  return trimKey(process.env.AGNES_API_KEY2);
}

/** Video create / poll. */
export function envApiKey(): string | null {
  return envVideoKey();
}

export function missingVideoKeyCopy(): string {
  return "Add an Agnes API key in the header, or set AGNES_API_KEY in .env and restart.";
}

export function missingStoryKeyCopy(): string {
  return "Set AGNES_API_KEY2 in .env for storyboard, character sheets, and stills, then restart.";
}

export function overrideFromBody(value: unknown): string | null {
  return trimKey(value);
}

export function cookieApiKey(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.split("=");
    if (rawName?.trim() !== AGNES_KEY_COOKIE) continue;
    try {
      return trimKey(decodeURIComponent(rest.join("=").trim()));
    } catch {
      return null;
    }
  }
  return null;
}

/** Status/SSE: pasted key cookie, else env. */
export function pollAgnesKey(request: Request): string | null {
  return cookieApiKey(request) ?? envApiKey();
}

function cookieFlags(): string {
  const secure = process.env.VERCEL ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function setOverrideCookie(key: string): string {
  return `${AGNES_KEY_COOKIE}=${encodeURIComponent(key)}; ${cookieFlags()}; Max-Age=3600`;
}

export function clearOverrideCookie(): string {
  return `${AGNES_KEY_COOKIE}=; ${cookieFlags()}; Max-Age=0`;
}
