import "server-only";

const DEFAULT_ORIGIN = "https://apihub.agnes-ai.com";

/** Host origin for Agnes create/poll. OpenAI-style `/v1` on AGNES_BASE_URL is stripped once. */
export function getAgnesOrigin(): string {
  const raw = process.env.AGNES_BASE_URL;
  if (typeof raw !== "string") return DEFAULT_ORIGIN;
  let origin = raw.trim();
  if (origin.length === 0) return DEFAULT_ORIGIN;
  origin = origin.replace(/\/+$/, "");
  if (origin.endsWith("/v1")) {
    origin = origin.slice(0, -3).replace(/\/+$/, "");
  }
  if (!origin.startsWith("https://")) {
    return DEFAULT_ORIGIN;
  }
  return origin.length > 0 ? origin : DEFAULT_ORIGIN;
}
