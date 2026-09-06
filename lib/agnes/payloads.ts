import "server-only";

import {
  DEFAULT_FRAME_RATE,
  DEFAULT_HEIGHT,
  DEFAULT_NUM_FRAMES,
  DEFAULT_WIDTH,
  FLASH_AUDIO_MAX,
  FLASH_DEFAULT_SECONDS,
  FLASH_IMAGE_MAX,
  FLASH_SECONDS_MAX,
  FLASH_SECONDS_MIN,
  FLASH_SIZE,
  isValidNumFrames,
  maxFramesForPixels,
  MODEL_FLASH,
  MODEL_V20,
  V20_I2V_MAX,
  V20_KEYFRAME_MAX,
  V20_KEYFRAME_MIN,
} from "./constants";
import {
  isAgnesMediaRef,
  isFlashAspectRatio,
  isPublicHttpsUrl,
  type CreateRequest,
  type FlashCreateRequest,
  type FlashMode,
  type V20CreateRequest,
  type V20Mode,
} from "./types";

type ParseOk = { ok: true; value: CreateRequest };
type ParseFail = { ok: false; detail: string };
export type ParseResult = ParseOk | ParseFail;

function fail(detail: string): ParseFail {
  return { ok: false, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function asInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

function asHttpsUrl(value: unknown): string | null {
  const text = asNonEmptyString(value);
  if (!text || text.startsWith("data:")) return null;
  if (isAgnesMediaRef(text) || isPublicHttpsUrl(text)) return text;
  return null;
}

function asHttpsUrlList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const urls: string[] = [];
  for (const item of value) {
    const url = asHttpsUrl(item);
    if (!url) return null;
    urls.push(url);
  }
  return urls;
}

function parseV20Mode(value: unknown): V20Mode | null {
  if (value === "text" || value === "image" || value === "keyframes") return value;
  return null;
}

function parseFlashMode(value: unknown): FlashMode | null {
  if (value === "text" || value === "keyframe" || value === "reference") return value;
  return null;
}

function parseV20(input: Record<string, unknown>): ParseResult {
  const mode = parseV20Mode(input.mode);
  if (!mode) return fail("Invalid mode for v2.0.");

  const prompt = asNonEmptyString(input.prompt);
  if (!prompt) return fail("Enter a prompt.");

  const width = input.width === undefined ? DEFAULT_WIDTH : asInteger(input.width);
  const height = input.height === undefined ? DEFAULT_HEIGHT : asInteger(input.height);
  const num_frames =
    input.num_frames === undefined ? DEFAULT_NUM_FRAMES : asInteger(input.num_frames);
  const frame_rate =
    input.frame_rate === undefined ? DEFAULT_FRAME_RATE : asInteger(input.frame_rate);

  if (width === null || width < 1) return fail("Invalid width.");
  if (height === null || height < 1) return fail("Invalid height.");
  if (num_frames === null || !isValidNumFrames(num_frames)) {
    return fail("num_frames must be 8n+1 between 9 and 961.");
  }
  const frameCap = maxFramesForPixels(width, height);
  if (num_frames > frameCap) {
    return fail(`num_frames exceeds ${frameCap} for this resolution.`);
  }
  if (frame_rate === null || frame_rate < 1 || frame_rate > 60) {
    return fail("frame_rate must be an integer from 1 to 60.");
  }

  const req: V20CreateRequest = {
    model: MODEL_V20,
    mode,
    prompt,
    width,
    height,
    num_frames,
    frame_rate,
  };

  if (mode === "image") {
    let raw: unknown = input.image;
    if (Array.isArray(raw)) {
      if (raw.length !== V20_I2V_MAX) return fail("Image-to-video allows 1 image.");
      raw = raw[0];
    }
    const image = asHttpsUrl(raw);
    if (!image) return fail("Use a public https:// URL.");
    req.image = image;
  }

  if (mode === "keyframes") {
    const keyframe_images = asHttpsUrlList(input.keyframe_images);
    if (!keyframe_images || keyframe_images.length < V20_KEYFRAME_MIN) {
      return fail("Add at least two keyframe images.");
    }
    if (keyframe_images.length > V20_KEYFRAME_MAX) {
      return fail("Use at most 3 keyframe images.");
    }
    req.keyframe_images = keyframe_images;
  }

  const negative = asNonEmptyString(input.negative_prompt);
  if (negative) req.negative_prompt = negative;

  if (input.num_inference_steps !== undefined && input.num_inference_steps !== "") {
    const steps = asInteger(input.num_inference_steps);
    if (steps === null || steps < 0) return fail("Invalid inference steps.");
    req.num_inference_steps = steps;
  }

  if (input.seed !== undefined && input.seed !== "") {
    const seed = asInteger(input.seed);
    if (seed === null) return fail("Invalid seed.");
    req.seed = seed;
  }

  return { ok: true, value: req };
}

function parseFlashSeconds(value: unknown): string | null {
  const asString = typeof value === "number" && Number.isInteger(value)
    ? String(value)
    : asNonEmptyString(value);
  if (!asString || !/^\d+$/.test(asString)) return null;
  const n = Number(asString);
  if (n < FLASH_SECONDS_MIN || n > FLASH_SECONDS_MAX) return null;
  return asString;
}

function parseFlash(input: Record<string, unknown>): ParseResult {
  const mode = parseFlashMode(input.mode);
  if (!mode) return fail("Invalid mode for 2.5 Flash.");

  const prompt = asNonEmptyString(input.prompt);
  if (!prompt) return fail("Enter a prompt.");

  let seconds: string;
  if (input.seconds === undefined || input.seconds === "") {
    seconds = FLASH_DEFAULT_SECONDS;
  } else {
    const parsed = parseFlashSeconds(input.seconds);
    if (!parsed) return fail("Flash duration must be an integer from 4 to 12 seconds.");
    seconds = parsed;
  }

  const aspect_ratio = input.aspect_ratio === undefined ? "16:9" : input.aspect_ratio;
  if (!isFlashAspectRatio(aspect_ratio)) return fail("Invalid aspect ratio.");

  const req: FlashCreateRequest = {
    model: MODEL_FLASH,
    mode,
    prompt,
    seconds,
    aspect_ratio,
  };

  if (mode === "keyframe") {
    if (Array.isArray(input.first_frame)) return fail("First frame allows 1 image.");
    if (Array.isArray(input.last_frame)) return fail("Last frame allows 1 image.");
    const first = asNonEmptyString(input.first_frame);
    const last = asNonEmptyString(input.last_frame);
    if (first) {
      const url = asHttpsUrl(first);
      if (!url) return fail("Use a public https:// URL.");
      req.first_frame = url;
    }
    if (last) {
      const url = asHttpsUrl(last);
      if (!url) return fail("Use a public https:// URL.");
      req.last_frame = url;
    }
    if (!req.first_frame && !req.last_frame) {
      return fail("Add at least one frame (first, last, or both).");
    }
  }

  if (mode === "reference") {
    const images =
      input.images === undefined || (Array.isArray(input.images) && input.images.length === 0)
        ? []
        : asHttpsUrlList(input.images);
    const audios =
      input.audios === undefined || (Array.isArray(input.audios) && input.audios.length === 0)
        ? []
        : asHttpsUrlList(input.audios);
    if (images === null) return fail("Use a public https:// URL.");
    if (audios === null) return fail("Use a public https:// URL.");
    if (images.length === 0 && audios.length === 0) {
      return fail("Add at least one image or audio.");
    }
    if (images.length > FLASH_IMAGE_MAX) return fail("images length must not exceed 5");
    if (audios.length > FLASH_AUDIO_MAX) return fail("audios length must not exceed 3");
    if (images.length) req.images = images;
    if (audios.length) req.audios = audios;
  }

  if (input.seed !== undefined && input.seed !== "") {
    const seed = asInteger(input.seed);
    if (seed === null) return fail("Invalid seed.");
    req.seed = seed;
  }

  return { ok: true, value: req };
}

export function parseCreateRequest(input: unknown): ParseResult {
  if (!isRecord(input)) return fail("Invalid JSON.");
  if (input.model === MODEL_V20) return parseV20(input);
  if (input.model === MODEL_FLASH) return parseFlash(input);
  return fail("Unknown model.");
}

function stripEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildCreateBody(req: CreateRequest): Record<string, unknown> {
  if (req.model === MODEL_V20) {
    return buildV20Body(req);
  }
  return buildFlashBody(req);
}

function buildV20Body(req: V20CreateRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: MODEL_V20,
    prompt: req.prompt,
    width: req.width,
    height: req.height,
    num_frames: req.num_frames,
    frame_rate: req.frame_rate,
  };

  switch (req.mode) {
    case "text":
      break;
    case "image": {
      const image = stripEmpty(req.image);
      if (!image) throw new Error("Use a public https:// URL.");
      body.image = image;
      break;
    }
    case "keyframes": {
      const images = (req.keyframe_images ?? []).map((u) => u.trim()).filter(Boolean);
      if (images.length < V20_KEYFRAME_MIN) throw new Error("Add at least two keyframe images.");
      if (images.length > V20_KEYFRAME_MAX) throw new Error("Use at most 3 keyframe images.");
      body.extra_body = { image: images, mode: "keyframes" };
      break;
    }
    default: {
      const _exhaustive: never = req.mode;
      throw new Error(`Unhandled v2.0 mode: ${_exhaustive}`);
    }
  }

  const negative = stripEmpty(req.negative_prompt);
  if (negative) body.negative_prompt = negative;
  if (req.num_inference_steps !== undefined) body.num_inference_steps = req.num_inference_steps;
  if (req.seed !== undefined) body.seed = req.seed;

  return body;
}

function buildFlashBody(req: FlashCreateRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: MODEL_FLASH,
    mode: req.mode,
    prompt: req.prompt,
    seconds: req.seconds,
    size: FLASH_SIZE,
    aspect_ratio: req.aspect_ratio,
  };

  switch (req.mode) {
    case "text":
      break;
    case "keyframe": {
      const first = stripEmpty(req.first_frame);
      const last = stripEmpty(req.last_frame);
      if (!first && !last) {
        throw new Error("Add at least one frame (first, last, or both).");
      }
      if (first) body.first_frame = first;
      if (last) body.last_frame = last;
      break;
    }
    case "reference": {
      const images = (req.images ?? []).map((u) => u.trim()).filter(Boolean);
      const audios = (req.audios ?? []).map((u) => u.trim()).filter(Boolean);
      if (images.length === 0 && audios.length === 0) {
        throw new Error("Add at least one image or audio.");
      }
      if (images.length) body.images = images;
      if (audios.length) body.audios = audios;
      break;
    }
    default: {
      const _exhaustive: never = req.mode;
      throw new Error(`Unhandled Flash mode: ${_exhaustive}`);
    }
  }

  if (req.seed !== undefined) body.seed = req.seed;

  return body;
}
