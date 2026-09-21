/** Operator-facing copy for Agnes error strings. Safe for client and server. */
export function isAgnesStatusQueryLimit(detail: string): boolean {
  const lower = detail.toLowerCase();
  return lower.includes("too many video status") || lower.includes("too many status quer");
}

/** CREATE reject: Agnes video queue is full / try again after 1 minute. Matches raw and humanized copy. */
export function isAgnesCreateQueueFull(detail: string): boolean {
  const lower = detail.toLowerCase();
  return (
    lower.includes("queue is full") ||
    (lower.includes("video queue") && lower.includes("retry")) ||
    lower.includes("try again after 1 minute") ||
    lower.includes("retry later") ||
    lower.includes("try again later")
  );
}

export function humanizeAgnesDetail(detail: string): string {
  const text = detail.trim();
  const lower = text.toLowerCase();
  if (text.includes("无效的令牌")) {
    return "Agnes rejected the API token (401) and reported a database error on their side. Wait, then retry. If it keeps failing, check AGNES_API_KEY.";
  }
  if (isAgnesStatusQueryLimit(text)) {
    return "Too many status checks. Next check in 1 minute.";
  }
  if (isAgnesCreateQueueFull(text)) {
    if (
      lower.includes("retry later") ||
      lower.includes("try again later") ||
      lower.includes("agnes is busy")
    ) {
      return "Agnes is busy. Try again after 1 minute.";
    }
    return "Video queue is full. Try again after 1 minute.";
  }
  return text;
}
