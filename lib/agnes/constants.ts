export const MODEL_V20 = "agnes-video-v2.0" as const;
export const MODEL_FLASH = "agnes-video-2.5-flash" as const;

export const POLL_CAP_MS = 15 * 60 * 1000;

/** Sleep before the Agnes status call at this 0-based index. First call is at 30s, not t=0. */
export function agnesPollDelayMs(pollIndex: number): number {
  const i = Math.max(0, pollIndex);
  if (i <= 1) return 30_000;
  if (i <= 4) return 20_000;
  return 10_000;
}

export const UPSTREAM_TIMEOUT_MS = 20_000;

export const MIN_FRAMES = 9;
/** Absolute Agnes v2.0 ceiling (480p). Per-request cap is V20_MAX_FRAMES[resolution]. */
export const MAX_FRAMES = 961;

export const V20_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export type V20Resolution = (typeof V20_RESOLUTIONS)[number];

export const V20_MAX_FRAMES: Record<V20Resolution, number> = {
  "480p": 961,
  "720p": 481,
  "1080p": 241,
};

export const V20_FPS_OPTIONS = [24, 30, 45, 60] as const;
export type V20Fps = (typeof V20_FPS_OPTIONS)[number];
export const DEFAULT_FRAME_RATE: V20Fps = 24;

/** Catalog of duration pills; invalid ones for the current res×fps are hidden. */
export const V20_DURATION_OPTIONS = [3, 4, 5, 6, 8, 10, 12, 15, 16, 18, 20, 24, 30, 32, 40] as const;
export type V20Duration = (typeof V20_DURATION_OPTIONS)[number];
export const DEFAULT_DURATION_SEC: V20Duration = 5;

export const DEFAULT_V20_RESOLUTION: V20Resolution = "720p";
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;
export const DEFAULT_NUM_FRAMES = 121;
/** Agnes: mode=keyframes requires extra_body.image length >= 2. */
export const V20_KEYFRAME_MIN = 2;
/** Agnes: mode=keyframes supports at most 3 images. */
export const V20_KEYFRAME_MAX = 3;
/** Agnes: ti2vid supports at most 1 image. */
export const V20_I2V_MAX = 1;

/** Default v2.0 `negative_prompt` — avoid treating a character sheet as the video. Editable. */
export const DEFAULT_V20_NEGATIVE_PROMPT =
  "spritesheet, character sheet, turnaround sheet, model sheet, pose grid, comic panels, split screen, collage, slideshow of stills, different character than reference, outfit change, extra limbs, warped face, extra characters, text overlay, watermark, logo, blurry, low quality";

/** Shown under v2.0 image / keyframes pickers. Positive instruction, not a negative. */
export const V20_REFERENCE_HINT =
  "Keep identity from the reference; the sheet is not the video.";

export const FLASH_SECONDS_MIN = 4;
export const FLASH_SECONDS_MAX = 12;
export const FLASH_DEFAULT_SECONDS = "5";
export const FLASH_SIZE = "720P" as const;
/** Agnes Flash reference: images length must not exceed 5. */
export const FLASH_IMAGE_MAX = 5;
/** Agnes Flash reference: audios length must not exceed 3. */
export const FLASH_AUDIO_MAX = 3;

export const THEME_STORAGE_KEY = "agnes-theme";

export const V20_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

export const V20_PIXELS: Record<
  V20Resolution,
  Record<(typeof V20_ASPECTS)[number], { width: number; height: number }>
> = {
  "480p": {
    "16:9": { width: 854, height: 480 },
    "9:16": { width: 480, height: 854 },
    "1:1": { width: 480, height: 480 },
    "4:3": { width: 640, height: 480 },
    "3:4": { width: 480, height: 640 },
  },
  "720p": {
    "16:9": { width: 1280, height: 720 },
    "9:16": { width: 720, height: 1280 },
    "1:1": { width: 720, height: 720 },
    "4:3": { width: 960, height: 720 },
    "3:4": { width: 720, height: 960 },
  },
  "1080p": {
    "16:9": { width: 1920, height: 1080 },
    "9:16": { width: 1080, height: 1920 },
    "1:1": { width: 1080, height: 1080 },
    "4:3": { width: 1440, height: 1080 },
    "3:4": { width: 1080, height: 1440 },
  },
};

export function v20Size(
  resolution: V20Resolution,
  aspect: (typeof V20_ASPECTS)[number],
): { width: number; height: number } {
  return V20_PIXELS[resolution][aspect];
}

/** Infer Agnes v2.0 frame cap from the shorter side (480p / 720p / 1080p). */
export function maxFramesForPixels(width: number, height: number): number {
  const short = Math.min(width, height);
  if (short >= 1080) return V20_MAX_FRAMES["1080p"];
  if (short >= 720) return V20_MAX_FRAMES["720p"];
  return V20_MAX_FRAMES["480p"];
}

export const FLASH_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;

export function snapNumFrames(raw: number, maxFrames: number = MAX_FRAMES): number {
  const cap = Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, maxFrames));
  const clamped = Math.max(MIN_FRAMES, Math.min(cap, raw));
  const n = Math.round((clamped - 1) / 8);
  let frames = 8 * n + 1;
  if (frames < MIN_FRAMES) frames = MIN_FRAMES;
  if (frames > cap) {
    const down = Math.floor((cap - 1) / 8);
    frames = 8 * down + 1;
  }
  return frames;
}

export function framesForDuration(
  durationSec: number,
  fps: number,
  maxFrames: number = MAX_FRAMES,
): number {
  return snapNumFrames(durationSec * fps, maxFrames);
}

export function isDurationAllowed(
  durationSec: number,
  fps: number,
  maxFrames: number,
): boolean {
  return durationSec * fps <= maxFrames;
}

export function allowedV20Durations(fps: number, maxFrames: number): V20Duration[] {
  return V20_DURATION_OPTIONS.filter((sec) => isDurationAllowed(sec, fps, maxFrames));
}

export function clampV20Duration(
  durationSec: number,
  fps: number,
  maxFrames: number,
): V20Duration {
  const allowed = allowedV20Durations(fps, maxFrames);
  if (allowed.length === 0) return DEFAULT_DURATION_SEC;
  if (allowed.includes(durationSec as V20Duration) && isDurationAllowed(durationSec, fps, maxFrames)) {
    return durationSec as V20Duration;
  }
  return allowed[allowed.length - 1] ?? DEFAULT_DURATION_SEC;
}

export function isValidNumFrames(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_FRAMES && value <= MAX_FRAMES && (value - 1) % 8 === 0;
}

export function formatTimingReadout(frames: number, fps: number): string {
  const actual = frames / fps;
  return `≈ ${actual.toFixed(2)} s · ${frames} frames @ ${fps} fps`;
}
