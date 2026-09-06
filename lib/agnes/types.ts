import {
  FLASH_ASPECT_RATIOS,
  MODEL_FLASH,
  MODEL_V20,
  V20_ASPECTS,
} from "./constants";

export type ModelId = typeof MODEL_V20 | typeof MODEL_FLASH;
export type V20Mode = "text" | "image" | "keyframes";
export type FlashMode = "text" | "keyframe" | "reference";
export type FlashAspectRatio = (typeof FLASH_ASPECT_RATIOS)[number];
export type V20FrameSizeId = (typeof V20_ASPECTS)[number];
export type ThemeId = "light" | "dark";
export type JobStatus = "queued" | "in_progress" | "completed" | "failed";

export type V20CreateRequest = {
  model: typeof MODEL_V20;
  mode: V20Mode;
  prompt: string;
  width: number;
  height: number;
  num_frames: number;
  frame_rate: number;
  image?: string;
  keyframe_images?: string[];
  negative_prompt?: string;
  num_inference_steps?: number;
  seed?: number;
};

export type FlashCreateRequest = {
  model: typeof MODEL_FLASH;
  mode: FlashMode;
  prompt: string;
  seconds: string;
  aspect_ratio: FlashAspectRatio;
  first_frame?: string;
  last_frame?: string;
  images?: string[];
  audios?: string[];
  seed?: number;
};

export type CreateRequest = V20CreateRequest | FlashCreateRequest;

export type CreateSuccess = {
  id: string;
  task_id?: string;
  video_id: string;
  object?: string;
  model: ModelId;
  status?: string;
  progress?: number;
  created_at?: number;
  seconds?: string;
  size?: string;
};

export type StatusSuccess = {
  id?: string;
  task_id?: string;
  video_id?: string;
  model?: string;
  status: JobStatus;
  progress?: number;
  seconds?: string;
  size?: string;
  metadata: { url: string } | null;
  error: { message: string } | null;
};

export type ApiErrorBody = {
  detail: string;
};

const AGNES_MEDIA_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isAgnesMediaRef(value: string): boolean {
  const prefix = "agnes-media:";
  if (!value.startsWith(prefix)) return false;
  return AGNES_MEDIA_UUID_RE.test(value.slice(prefix.length));
}

export function isModelId(value: unknown): value is ModelId {
  return value === MODEL_V20 || value === MODEL_FLASH;
}

export function isFlashAspectRatio(value: unknown): value is FlashAspectRatio {
  return (
    typeof value === "string" &&
    (FLASH_ASPECT_RATIOS as readonly string[]).includes(value)
  );
}

export function isJobStatus(value: unknown): value is JobStatus {
  return (
    value === "queued" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed"
  );
}
