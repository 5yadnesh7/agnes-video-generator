"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  allowedV20Durations,
  DEFAULT_FRAME_RATE,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_V20_RESOLUTION,
  IMAGE_MODELS,
  isImageModelId,
  FLASH_ASPECT_RATIOS,
  FLASH_AUDIO_MAX,
  FLASH_IMAGE_MAX,
  FLASH_SECONDS_MAX,
  FLASH_SECONDS_MIN,
  formatStoryLength,
  framesForDuration,
  maxFramesForPixels,
  MODEL_FLASH,
  MODEL_V20,
  snapStoryDuration,
  STORY_CHARACTER_MAX,
  STORY_CREATE_GAP_MS,
  STORY_DEFAULT_MINUTES,
  STORY_MINUTES_OPTIONS,
  STORY_SCENE_HARD_MAX,
  STORY_SCENE_MIN,
  STORY_V20_NEGATIVE_PROMPT,
  clampStoryMinutes,
  storyClipMinSec,
  storyClipTargetSec,
  storySceneRange,
  storyTiming,
  V20_ASPECTS,
  V20_FPS_OPTIONS,
  V20_I2V_MAX,
  V20_KEYFRAME_MAX,
  V20_KEYFRAME_MIN,
  V20_RESOLUTIONS,
  v20Size,
  type ImageModelId,
  type V20Fps,
  type V20Resolution,
} from "@/lib/agnes/constants";
import { FLASH_STORY_NEGATIVE_LINE, formatStoryShot, isComposedShotPrompt, applyShotDurationLine, sceneBridgeStillPrompt, sceneTimeRange } from "@/lib/agnes/story-format";
import {
  isJobStatus,
  isPublicHttpsUrl,
  type CreateRequest,
  type FlashAspectRatio,
  type ModelId,
  type V20FrameSizeId,
} from "@/lib/agnes/types";

const IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";
const AUDIO_ACCEPT = "audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav,.m4a,.aac,.mp4";
const STORY_IMAGE_LIBRARY_MAX = 8;
const STORY_AUDIO_LIBRARY_MAX = 6;
const PIPELINE = ["input", "storyboard", "clips", "merge"] as const;
type Gate = "input" | "storyboard" | "clips";
type PipelineStep = (typeof PIPELINE)[number];
type SourceMode = "topic" | "story";
type ClipStatus = "waiting" | "queued" | "generating" | "ready" | "failed";

type SceneDraft = {
  title: string;
  duration_sec: number;
  durationTouched: boolean;
  cast: string[];
  setting: string;
  subject: string;
  action: string;
  camera_movement: string;
  lighting: string;
  style: string;
  dialogue: string;
  videoPrompt: string;
  bridgeId: string;
  bridgeUrl: string;
};

type CharacterDraft = {
  name: string;
  role: string;
  appearance: string;
  sheet_prompt: string;
  stillId: string;
  stillUrl: string;
  sampleId: string;
  sampleUrl: string;
  sampleName: string;
  generatePrompt: string;
  imageModel: ImageModelId;
};

function emptySheetFields(): Pick<
  CharacterDraft,
  "sampleId" | "sampleUrl" | "sampleName" | "generatePrompt" | "imageModel"
> {
  return {
    sampleId: "",
    sampleUrl: "",
    sampleName: "",
    generatePrompt: "",
    imageModel: DEFAULT_IMAGE_MODEL,
  };
}

type Clip = {
  status: ClipStatus;
  videoId?: string;
  url?: string;
  lastFrameId?: string;
  lastFrameSrc?: string;
  progress?: number;
  error?: string;
  resumeKind?: "poll" | "frame" | "create";
};

const STORY_CHECKPOINT_KEY = "agnes-story-checkpoint-v2";

type ImageKind = "character" | "keyframe";

type StoryImageAsset = {
  key: string;
  id: string;
  url: string;
  name: string;
  selected: boolean;
  kind: ImageKind;
  characterName: string;
};

type StoryAudioAsset = {
  key: string;
  id: string;
  url: string;
  name: string;
  selected: boolean;
  sceneIndex: number | null;
};

type StoryCheckpoint = {
  gate: Gate;
  source: SourceMode;
  text: string;
  model: ModelId;
  targetMinutes: number;
  v20Resolution: V20Resolution;
  fps: V20Fps;
  v20Aspect: V20FrameSizeId;
  flashAspect: FlashAspectRatio;
  imageAssets: StoryImageAsset[];
  audioAssets: StoryAudioAsset[];
  stillUrl: string;
  stillId: string;
  stillName: string;
  seed: number | null;
  filmStyle: string;
  characters: CharacterDraft[];
  story: string;
  scenes: SceneDraft[];
  clips: Clip[];
  lastCreateAt: number;
};

let assetSeq = 0;
function nextAssetKey(prefix: string): string {
  assetSeq += 1;
  return `${prefix}-${Date.now()}-${assetSeq}`;
}

function fileStem(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return base.slice(0, 40);
}

function uniqueCharacterName(desired: string, existing: CharacterDraft[]): string {
  const base = desired.trim() || "Character";
  const taken = new Set(existing.map((c) => c.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 40; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${existing.length + 1}`;
}

function parseResolution(value: unknown): V20Resolution {
  return typeof value === "string" && (V20_RESOLUTIONS as readonly string[]).includes(value)
    ? (value as V20Resolution)
    : DEFAULT_V20_RESOLUTION;
}

function parseFps(value: unknown): V20Fps {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return (V20_FPS_OPTIONS as readonly number[]).includes(n) ? (n as V20Fps) : DEFAULT_FRAME_RATE;
}

function parseV20Aspect(value: unknown): V20FrameSizeId {
  return typeof value === "string" && (V20_ASPECTS as readonly string[]).includes(value)
    ? (value as V20FrameSizeId)
    : "16:9";
}

function parseFlashAspect(value: unknown): FlashAspectRatio {
  return typeof value === "string" && (FLASH_ASPECT_RATIOS as readonly string[]).includes(value)
    ? (value as FlashAspectRatio)
    : "16:9";
}

function parseImageAssets(raw: unknown, fallback?: { url: string; id: string; name: string }): StoryImageAsset[] {
  const out: StoryImageAsset[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const url = typeof rec.url === "string" ? rec.url : "";
      if (!url) continue;
      out.push({
        key: typeof rec.key === "string" ? rec.key : nextAssetKey("img"),
        id: typeof rec.id === "string" ? rec.id : "",
        url,
        name: typeof rec.name === "string" ? rec.name : "image",
        selected: rec.selected !== false,
        kind: rec.kind === "keyframe" ? "keyframe" : "character",
        characterName: typeof rec.characterName === "string" ? rec.characterName : "",
      });
      if (out.length >= STORY_IMAGE_LIBRARY_MAX) break;
    }
  }
  if (out.length === 0 && fallback?.url) {
    out.push({
      key: nextAssetKey("img"),
      id: fallback.id,
      url: fallback.url,
      name: fallback.name || "character still",
      selected: true,
      kind: "character",
      characterName: "",
    });
  }
  return out;
}

function parseAudioAssets(raw: unknown): StoryAudioAsset[] {
  const out: StoryAudioAsset[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url : "";
    if (!url) continue;
    const sceneRaw = rec.sceneIndex;
    const sceneIndex =
      sceneRaw === null || sceneRaw === undefined
        ? null
        : typeof sceneRaw === "number" && Number.isInteger(sceneRaw) && sceneRaw >= 0
          ? sceneRaw
          : null;
    out.push({
      key: typeof rec.key === "string" ? rec.key : nextAssetKey("aud"),
      id: typeof rec.id === "string" ? rec.id : "",
      url,
      name: typeof rec.name === "string" ? rec.name : "audio",
      selected: rec.selected !== false,
      sceneIndex,
    });
    if (out.length >= STORY_AUDIO_LIBRARY_MAX) break;
  }
  return out;
}

function bindAssetsToCharacters(
  chars: CharacterDraft[],
  images: StoryImageAsset[],
): { chars: CharacterDraft[]; images: StoryImageAsset[] } {
  const nextChars = chars.slice(0, STORY_CHARACTER_MAX).map((c) => ({ ...c }));
  const nextImages = images.map((img) => ({ ...img }));

  function assign(img: StoryImageAsset, index: number) {
    nextChars[index] = {
      ...nextChars[index],
      stillId: img.id,
      stillUrl: img.url,
    };
    img.characterName = nextChars[index].name;
  }

  for (const img of nextImages) {
    if (img.kind !== "character" || !img.characterName.trim()) continue;
    const idx = nextChars.findIndex((c) => c.name.toLowerCase() === img.characterName.trim().toLowerCase());
    if (idx >= 0) assign(img, idx);
  }

  for (const img of nextImages) {
    if (img.kind !== "character" || img.characterName.trim()) continue;
    const idx = nextChars.findIndex((c) => !c.stillUrl);
    if (idx >= 0) {
      assign(img, idx);
      continue;
    }
    if (nextChars.length >= STORY_CHARACTER_MAX) continue;
    const name = uniqueCharacterName(fileStem(img.name) || `Character ${nextChars.length + 1}`, nextChars);
    nextChars.push({
      name,
      role: "supporting",
      appearance: "Match the uploaded reference photo.",
      sheet_prompt: "",
      stillId: img.id,
      stillUrl: img.url,
      ...emptySheetFields(),
      sampleId: img.id,
      sampleUrl: img.url,
      sampleName: img.name,
    });
    img.characterName = name;
  }

  return { chars: nextChars, images: nextImages };
}

function selectedImageUrls(images: StoryImageAsset[]): string[] {
  return images.filter((img) => img.selected).map((img) => img.url);
}

function selectedAudioUrls(audios: StoryAudioAsset[], sceneIndex: number): string[] {
  return audios
    .filter((a) => a.selected && (a.sceneIndex === null || a.sceneIndex === sceneIndex))
    .map((a) => a.url);
}

function loadCheckpoint(): StoryCheckpoint | null {
  try {
    const raw = sessionStorage.getItem(STORY_CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (rec.gate !== "input" && rec.gate !== "storyboard" && rec.gate !== "clips") return null;
    if (!Array.isArray(rec.scenes) || !Array.isArray(rec.clips)) return null;
    return rec as unknown as StoryCheckpoint;
  } catch {
    return null;
  }
}

function clearCheckpoint(): void {
  try {
    sessionStorage.removeItem(STORY_CHECKPOINT_KEY);
  } catch {
    /* ignore quota / private mode */
  }
}

function failKindFromWait(message: string): "poll" | "create" {
  const msg = message.toLowerCase();
  if (
    msg.includes("timed out") ||
    msg.includes("status check") ||
    msg.includes("still generating") ||
    msg.includes("interrupted")
  ) {
    return "poll";
  }
  return "create";
}

function shouldReattachPoll(clip: Clip): boolean {
  if (!clip.videoId || clip.url) return false;
  if (clip.resumeKind === "poll") return true;
  if (clip.resumeKind === "create" || clip.resumeKind === "frame") return false;
  const msg = (clip.error ?? "").toLowerCase();
  return (
    msg.includes("timed out") ||
    msg.includes("status check") ||
    msg.includes("still generating") ||
    msg.includes("interrupted")
  );
}

export type StoryWorkbenchHandle = {
  reset: () => void;
};

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

async function readDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "detail" in body &&
      typeof (body as { detail: unknown }).detail === "string"
    ) {
      return (body as { detail: string }).detail;
    }
  } catch {
    /* ignore malformed error bodies */
  }
  return "Agnes is unavailable or the job was not found.";
}

function parseEventPayload(raw: string): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort);
  });
}

function shotReady(scene: SceneDraft): boolean {
  return Boolean(scene.setting.trim() && scene.subject.trim() && scene.action.trim());
}

function mediaPreview(id: string, url: string): string {
  if (id) return `/api/media/${id}`;
  if (url.startsWith("agnes-media:")) return `/api/media/${url.slice("agnes-media:".length)}`;
  return url;
}

function pushUnique(list: string[], url: string | undefined, cap: number): void {
  if (!url || list.includes(url) || list.length >= cap) return;
  list.push(url);
}

function scenePayload(
  model: ModelId,
  prompt: string,
  durationSec: number,
  opts: {
    sheets: string[];
    startFrame?: string;
    endFrame?: string;
    seed: number;
    width: number;
    height: number;
    fps: number;
    maxFrames: number;
    flashAspect: FlashAspectRatio;
    selectedImages: string[];
    selectedAudios: string[];
  },
): CreateRequest {
  const { sheets, startFrame, endFrame, seed, width, height, fps, maxFrames, flashAspect, selectedImages, selectedAudios } =
    opts;
  if (model === MODEL_V20) {
    const refs: string[] = [];
    if (startFrame && endFrame) {
      pushUnique(refs, startFrame, V20_KEYFRAME_MAX);
      pushUnique(refs, endFrame, V20_KEYFRAME_MAX);
    } else {
      for (const url of selectedImages) pushUnique(refs, url, V20_KEYFRAME_MAX - 1);
      if (refs.length === 0) {
        for (const url of sheets) pushUnique(refs, url, V20_I2V_MAX);
      }
      pushUnique(refs, endFrame, V20_KEYFRAME_MAX);
    }
    const req: CreateRequest = {
      model: MODEL_V20,
      mode: refs.length >= V20_KEYFRAME_MIN ? "keyframes" : refs.length === 1 ? "image" : "text",
      prompt,
      width,
      height,
      num_frames: framesForDuration(durationSec, fps, maxFrames),
      frame_rate: fps,
      negative_prompt: STORY_V20_NEGATIVE_PROMPT,
      seed,
    };
    if (req.mode === "keyframes") req.keyframe_images = refs;
    else if (req.mode === "image") req.image = refs[0];
    return req;
  }
  const images: string[] = [];
  pushUnique(images, startFrame, FLASH_IMAGE_MAX);
  pushUnique(images, endFrame, FLASH_IMAGE_MAX);
  for (const url of selectedImages) pushUnique(images, url, FLASH_IMAGE_MAX);
  for (const url of sheets) pushUnique(images, url, FLASH_IMAGE_MAX);
  const audios = selectedAudios.slice(0, FLASH_AUDIO_MAX);
  const tags = [
    ...images.map((_, i) => `<Picture ${i + 1}>`),
    ...audios.map((_, i) => `<Audio ${i + 1}>`),
  ];
  const fullPrompt = [
    prompt,
    FLASH_STORY_NEGATIVE_LINE,
    tags.length > 0 ? `Use these references in order: ${tags.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (images.length > 0 || audios.length > 0) {
    return {
      model: MODEL_FLASH,
      mode: "reference",
      prompt: fullPrompt,
      seconds: String(durationSec),
      aspect_ratio: flashAspect,
      images: images.length ? images : undefined,
      audios: audios.length ? audios : undefined,
      seed,
    };
  }
  return {
    model: MODEL_FLASH,
    mode: "text",
    prompt: fullPrompt,
    seconds: String(durationSec),
    aspect_ratio: flashAspect,
    seed,
  };
}

function statusLabel(status: ClipStatus): string {
  if (status === "waiting") return "WAITING";
  if (status === "queued") return "QUEUED";
  if (status === "generating") return "GENERATING";
  if (status === "ready") return "READY";
  return "FAILED";
}

function pipelineCurrent(gate: Gate, clips: Clip[], mergedUrl: string | null): PipelineStep {
  if (gate === "input") return "input";
  if (gate === "storyboard") return "storyboard";
  if (mergedUrl || (clips.length > 0 && clips.every((c) => c.status === "ready"))) return "merge";
  return "clips";
}

function ModelRadios({
  name,
  model,
  disabled,
  onChange,
}: {
  name: string;
  model: ModelId;
  disabled?: boolean;
  onChange: (next: ModelId) => void;
}) {
  return (
    <fieldset className="group">
      <legend className="block">Model</legend>
      <div className="choice-row">
        <label className="radio">
          <input
            type="radio"
            name={name}
            value={MODEL_V20}
            checked={model === MODEL_V20}
            disabled={disabled}
            onChange={() => onChange(MODEL_V20)}
          />
          v2.0 <span className="api">{MODEL_V20}</span>
        </label>
        <label className="radio">
          <input
            type="radio"
            name={name}
            value={MODEL_FLASH}
            checked={model === MODEL_FLASH}
            disabled={disabled}
            onChange={() => onChange(MODEL_FLASH)}
          />
          2.5 Flash <span className="api">{MODEL_FLASH}</span>
        </label>
      </div>
    </fieldset>
  );
}

function Pipeline({
  current,
  onBack,
}: {
  current: PipelineStep;
  onBack: (() => void) | null;
}) {
  const order: Record<PipelineStep, number> = { input: 0, storyboard: 1, clips: 2, merge: 3 };
  const labels: Record<PipelineStep, string> = {
    input: "Input",
    storyboard: "Storyboard",
    clips: "Clips",
    merge: "Merge",
  };
  return (
    <div className="pipeline">
      <ol className="pipeline-steps">
        {PIPELINE.map((id, i) => {
          const state =
            id === current ? "current" : order[id] < order[current] ? "done" : "future";
          const mark = state === "done" ? "✓" : state === "current" ? "●" : "○";
          return (
            <li key={id} style={{ display: "contents" }}>
              {i > 0 ? (
                <span className="pipeline-join" aria-hidden="true">
                  ────
                </span>
              ) : null}
              <span
                className={`pipeline-step${state === "done" ? " is-done" : ""}`}
                aria-current={state === "current" ? "step" : undefined}
              >
                {labels[id]} {mark}
              </span>
            </li>
          );
        })}
      </ol>
      {onBack ? (
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Back
        </button>
      ) : null}
    </div>
  );
}

function ZoomLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener("cancel", onCancel);
    return () => {
      el.removeEventListener("cancel", onCancel);
      if (el.open) el.close();
    };
  }, [onClose, src]);
  return (
    <dialog
      ref={ref}
      className="zoom-dialog"
      aria-label={alt || "Zoomed image"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button type="button" className="btn zoom-close" onClick={onClose}>
        Close
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} />
    </dialog>
  );
}

function ZoomableImage({
  src,
  alt,
  onZoom,
}: {
  src: string;
  alt: string;
  onZoom: (src: string, alt: string) => void;
}) {
  return (
    <button type="button" className="zoom-thumb" onClick={() => onZoom(src, alt)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="last-frame-thumb" src={src} alt={alt} />
      <span className="zoom-thumb-hint">Tap to zoom</span>
    </button>
  );
}

function sceneCastLocks(scene: SceneDraft, roster: CharacterDraft[]): { name: string; appearance: string }[] {
  const wanted = ((scene.cast ?? []).length > 0 ? scene.cast : roster.map((c) => c.name)).map((n) =>
    n.toLowerCase(),
  );
  const present = roster.filter((c) => c.stillUrl && wanted.includes(c.name.toLowerCase()));
  const used = present.length > 0 ? present : roster.filter((c) => c.stillUrl);
  return used.map((c) => ({ name: c.name, appearance: c.appearance }));
}

function composeSceneVideoPrompt(index: number, scenes: SceneDraft[], characters: CharacterDraft[]): string {
  const scene = scenes[index];
  if (!scene) return "";
  const durations = scenes.map((s) => s.duration_sec);
  const custom = scene.videoPrompt.trim();
  if (isComposedShotPrompt(custom, index)) {
    return applyShotDurationLine(custom, index, durations);
  }
  const prev = index > 0 ? scenes[index - 1] : undefined;
  return formatStoryShot(index, durations, scene, sceneCastLocks(scene, characters), {
    hasStart: index > 0,
    hasEnd: true,
    prevEnd: prev ? { setting: prev.setting, subject: prev.subject, action: prev.action } : undefined,
    extraPrompt: custom,
  });
}

function SceneDurationPicker({
  index,
  scene,
  model,
  durationOptions,
  v20Resolution,
  fps,
  planMaxSec,
  filmMaxFrames,
  namePrefix,
  onPatch,
}: {
  index: number;
  scene: SceneDraft;
  model: ModelId;
  durationOptions: number[];
  v20Resolution: V20Resolution;
  fps: V20Fps;
  planMaxSec: number;
  filmMaxFrames: number;
  namePrefix: string;
  onPatch: (partial: Partial<SceneDraft>) => void;
}) {
  const capHint =
    model === MODEL_FLASH
      ? `Flash ${FLASH_SECONDS_MIN}–${FLASH_SECONDS_MAX}s (max ${FLASH_SECONDS_MAX}s). Applies to this clip.`
      : `Legal lengths at ${v20Resolution} · ${fps} fps (max ${planMaxSec}s). Same cap on every scene.`;
  if (model === MODEL_V20) {
    return (
      <fieldset className="group">
        <legend>Duration</legend>
        <div className="pill-row">
          {durationOptions.map((opt) => (
            <label key={opt}>
              <input
                type="radio"
                name={`${namePrefix}-dur-${index}`}
                value={opt}
                checked={scene.duration_sec === opt}
                onChange={() => onPatch({ duration_sec: opt, durationTouched: true })}
              />
              <span>{opt}s</span>
            </label>
          ))}
        </div>
        <p className="hint">{capHint}</p>
      </fieldset>
    );
  }
  return (
    <div className="row">
      <label className="field" htmlFor={`${namePrefix}-dur-${index}`}>
        Duration
      </label>
      <input
        id={`${namePrefix}-dur-${index}`}
        type="number"
        min={FLASH_SECONDS_MIN}
        max={FLASH_SECONDS_MAX}
        step={1}
        value={scene.duration_sec}
        onChange={(e) => {
          const n = Number(e.target.value);
          onPatch({
            duration_sec: Number.isFinite(n) ? n : scene.duration_sec,
            durationTouched: true,
          });
        }}
        onBlur={(e) => {
          const n = Number(e.currentTarget.value);
          onPatch({
            duration_sec: snapStoryDuration(
              Number.isFinite(n) ? n : scene.duration_sec,
              MODEL_FLASH,
              fps,
              filmMaxFrames,
            ),
          });
        }}
      />
      <p className="hint">{capHint}</p>
    </div>
  );
}

function ImageModelSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ImageModelId;
  onChange: (model: ImageModelId) => void;
}) {
  return (
    <div className="row">
      <label className="field" htmlFor={id}>
        Image model
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (isImageModelId(next)) onChange(next);
        }}
      >
        {IMAGE_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {m.id === DEFAULT_IMAGE_MODEL ? " (default)" : ""}
          </option>
        ))}
      </select>
      <p className="hint">
        Default is {IMAGE_MODELS.find((m) => m.id === DEFAULT_IMAGE_MODEL)?.label}. All three are
        free.
      </p>
    </div>
  );
}

function SceneBeatPair({
  index,
  scene,
  scenes,
  characters,
  stillBusy,
  endError,
  onZoom,
  onRegenEnd,
}: {
  index: number;
  scene: SceneDraft;
  scenes: SceneDraft[];
  characters: CharacterDraft[];
  stillBusy: boolean;
  endError?: string;
  onZoom: (src: string, alt: string) => void;
  onRegenEnd: (index: number) => void;
}) {
  const wanted = (scene.cast ?? []).map((n) => n.toLowerCase());
  const castSheets = (wanted.length > 0
    ? characters.filter((c) => wanted.includes(c.name.toLowerCase()))
    : characters
  ).filter((c) => c.stillUrl || c.stillId);
  const prev = index > 0 ? scenes[index - 1] : null;
  const startSrc =
    prev && (prev.bridgeId || prev.bridgeUrl) ? mediaPreview(prev.bridgeId, prev.bridgeUrl) : "";
  const endSrc = scene.bridgeId || scene.bridgeUrl ? mediaPreview(scene.bridgeId, scene.bridgeUrl) : "";
  const nextIndex = index + 2;
  const hasNext = index + 1 < scenes.length;

  return (
    <div className="scene-beats">
      <div className="scene-beat">
        <p className="field">Start</p>
        {index === 0 ? (
          castSheets.length > 0 ? (
            <div className="scene-beat-cast">
              {castSheets.map((ch) => (
                <ZoomableImage
                  key={ch.stillId || ch.name}
                  src={mediaPreview(ch.stillId, ch.stillUrl)}
                  alt={`${ch.name} spritesheet`}
                  onZoom={onZoom}
                />
              ))}
            </div>
          ) : (
            <p className="hint">Cast spritesheets pending.</p>
          )
        ) : startSrc ? (
          <ZoomableImage
            src={startSrc}
            alt={`Scene ${index} end still (start of scene ${index + 1})`}
            onZoom={onZoom}
          />
        ) : (
          <p className="hint">{stillBusy ? "Waiting for previous end still…" : "Previous end still not drawn yet."}</p>
        )}
        <p className="hint">
          {index === 0 ? "Cast spritesheets" : `Same picture as end of scene ${index}`}
        </p>
      </div>
      <div className="scene-beat">
        <p className="field">End</p>
        {endSrc ? (
          <ZoomableImage
            src={endSrc}
            alt={`Scene ${index + 1} end still${hasNext ? ` (start of scene ${nextIndex})` : ""}`}
            onZoom={onZoom}
          />
        ) : (
          <p className="hint">{stillBusy ? "Drawing end still…" : "End still not drawn yet."}</p>
        )}
        {endError ? <p className="form-error">{endError}</p> : null}
        <p className="hint">{hasNext ? `Start of scene ${nextIndex}` : "Last still of this clip"}</p>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={stillBusy}
          onClick={() => onRegenEnd(index)}
        >
          {stillBusy && !endSrc ? "Drawing…" : "Regenerate end still"}
        </button>
      </div>
    </div>
  );
}

function PillRow<T extends string | number>({
  legend,
  name,
  options,
  value,
  format,
  onChange,
  hint,
}: {
  legend: string;
  name: string;
  options: readonly T[];
  value: T;
  format?: (opt: T) => string;
  onChange: (opt: T) => void;
  hint?: string;
}) {
  return (
    <fieldset className="group">
      <legend>{legend}</legend>
      <div className="pill-row">
        {options.map((opt) => (
          <label key={String(opt)}>
            <input
              type="radio"
              name={name}
              value={String(opt)}
              checked={value === opt}
              onChange={() => onChange(opt)}
            />
            <span>{format ? format(opt) : String(opt)}</span>
          </label>
        ))}
      </div>
      {hint ? <p className="hint">{hint}</p> : null}
    </fieldset>
  );
}

function FilmSettings({
  idPrefix,
  model,
  resolution,
  fps,
  v20Aspect,
  flashAspect,
  onResolution,
  onFps,
  onV20Aspect,
  onFlashAspect,
}: {
  idPrefix: string;
  model: ModelId;
  resolution: V20Resolution;
  fps: V20Fps;
  v20Aspect: V20FrameSizeId;
  flashAspect: FlashAspectRatio;
  onResolution: (next: V20Resolution) => void;
  onFps: (next: V20Fps) => void;
  onV20Aspect: (next: V20FrameSizeId) => void;
  onFlashAspect: (next: FlashAspectRatio) => void;
}) {
  const size = v20Size(resolution, v20Aspect);
  const maxFrames = maxFramesForPixels(size.width, size.height);
  const timing = storyTiming(model, fps, maxFrames);
  if (model === MODEL_FLASH) {
    return (
      <div>
        <h2 className="block">Film settings</h2>
        <div className="settings-grid">
          <fieldset className="group">
            <legend>Aspect</legend>
            <div className="pill-row">
              {FLASH_ASPECT_RATIOS.map((opt) => (
                <label key={opt}>
                  <input
                    type="radio"
                    name={`${idPrefix}-flash-aspect`}
                    value={opt}
                    checked={flashAspect === opt}
                    onChange={() => onFlashAspect(opt)}
                  />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
            <p className="hint">
              Flash has no fps. Each scene is {FLASH_SECONDS_MIN}–{FLASH_SECONDS_MAX}s. Max duration of a
              scene is {FLASH_SECONDS_MAX}s. Applies to every scene.
            </p>
          </fieldset>
        </div>
      </div>
    );
  }
  return (
    <div>
      <h2 className="block">Film settings</h2>
      <div className="settings-grid">
        <PillRow
          legend="Resolution"
          name={`${idPrefix}-resolution`}
          options={V20_RESOLUTIONS}
          value={resolution}
          onChange={onResolution}
          hint={`${resolution} · max ${maxFrames} frames`}
        />
        <PillRow
          legend="FPS"
          name={`${idPrefix}-fps`}
          options={V20_FPS_OPTIONS}
          value={fps}
          onChange={onFps}
        />
        <fieldset className="group">
          <legend>Aspect</legend>
          <div className="pill-row">
            {V20_ASPECTS.map((opt) => (
              <label key={opt}>
                <input
                  type="radio"
                  name={`${idPrefix}-aspect`}
                  value={opt}
                  checked={v20Aspect === opt}
                  onChange={() => onV20Aspect(opt)}
                />
                <span>{opt}</span>
              </label>
            ))}
          </div>
          <p className="hint">Agnes may normalize. Trust the file, not these pixels.</p>
        </fieldset>
      </div>
      <p className="hint">
        Max duration of a scene is based on resolution and fps. At {resolution} · {fps} fps a clip can be{" "}
        {timing.min}–{timing.max}s (max {timing.max}s). No film-level duration — each beat picks its own
        length inside that range. Applies to every scene.
      </p>
    </div>
  );
}

function AssetLibrary({
  idPrefix,
  disabled,
  storing,
  characters,
  sceneCount,
  imageAssets,
  audioAssets,
  model,
  onPickImages,
  onPickAudios,
  onPatchImage,
  onPatchAudio,
  onRemoveImage,
  onRemoveAudio,
}: {
  idPrefix: string;
  disabled: boolean;
  storing: boolean;
  characters: CharacterDraft[];
  sceneCount: number;
  imageAssets: StoryImageAsset[];
  audioAssets: StoryAudioAsset[];
  model: ModelId;
  onPickImages: (files: File[]) => void;
  onPickAudios: (files: File[]) => void;
  onPatchImage: (key: string, patch: Partial<StoryImageAsset>) => void;
  onPatchAudio: (key: string, patch: Partial<StoryAudioAsset>) => void;
  onRemoveImage: (key: string) => void;
  onRemoveAudio: (key: string) => void;
}) {
  return (
    <div className="asset-library">
      <h2 className="block">Reference images</h2>
      <p className="hint">
        Character stills and keyframes. Check the ones to send with scene 1 (within Agnes caps). After the
        storyboard, map stills to people. Unmapped stills become extra characters; missing people get a
        generated spritesheet.
      </p>
      <label className="field" htmlFor={`${idPrefix}-images`}>
        Choose images
      </label>
      <input
        id={`${idPrefix}-images`}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        disabled={disabled || storing || imageAssets.length >= STORY_IMAGE_LIBRARY_MAX}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          onPickImages(files);
        }}
      />
      <p className="hint">
        {imageAssets.length}/{STORY_IMAGE_LIBRARY_MAX} images
        {storing ? " · storing…" : ""}
      </p>
      {imageAssets.map((img, index) => (
        <div className="asset-row" key={img.key}>
          <label className="asset-check">
            <input
              type="checkbox"
              checked={img.selected}
              disabled={disabled}
              onChange={(e) => onPatchImage(img.key, { selected: e.target.checked })}
            />
            <span className="visually-hidden">Use {img.name}</span>
          </label>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="asset-thumb" src={mediaPreview(img.id, img.url)} alt="" />
          <div className="asset-meta">
            <p className="mono">{img.name}</p>
            <div className="asset-maps">
              <label>
                <span className="visually-hidden">Image kind {index + 1}</span>
                <select
                  value={img.kind}
                  disabled={disabled}
                  onChange={(e) => onPatchImage(img.key, { kind: e.target.value as ImageKind })}
                >
                  <option value="character">Character still</option>
                  <option value="keyframe">Keyframe / reference</option>
                </select>
              </label>
              {img.kind === "character" ? (
                <label>
                  <span className="visually-hidden">Map image {index + 1}</span>
                  <select
                    value={img.characterName}
                    disabled={disabled}
                    onChange={(e) => onPatchImage(img.key, { characterName: e.target.value })}
                  >
                    <option value="">
                      {characters.length > 0 ? "Unmapped — new or auto" : "Assign after storyboard"}
                    </option>
                    {characters.map((ch) => (
                      <option key={ch.name} value={ch.name}>
                        {ch.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </div>
          <button type="button" className="btn" disabled={disabled} onClick={() => onRemoveImage(img.key)}>
            Remove
          </button>
        </div>
      ))}

      <h2 className="block">Reference audio</h2>
      <p className="hint">
        {model === MODEL_FLASH
          ? `Selected audio is sent with Flash clips (max ${FLASH_AUDIO_MAX} per scene). Map to all scenes or one beat.`
          : "v2.0 has no audio API. Switch to Flash to send these files. Mapping is kept."}
      </p>
      <label className="field" htmlFor={`${idPrefix}-audios`}>
        Choose audios
      </label>
      <input
        id={`${idPrefix}-audios`}
        type="file"
        accept={AUDIO_ACCEPT}
        multiple
        disabled={disabled || storing || audioAssets.length >= STORY_AUDIO_LIBRARY_MAX}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          onPickAudios(files);
        }}
      />
      <p className="hint">
        {audioAssets.length}/{STORY_AUDIO_LIBRARY_MAX} audios
      </p>
      {audioAssets.map((aud, index) => (
        <div className="asset-row" key={aud.key}>
          <label className="asset-check">
            <input
              type="checkbox"
              checked={aud.selected}
              disabled={disabled}
              onChange={(e) => onPatchAudio(aud.key, { selected: e.target.checked })}
            />
            <span className="visually-hidden">Use {aud.name}</span>
          </label>
          <div className="asset-meta">
            <p className="mono">{aud.name}</p>
            <label>
              <span className="visually-hidden">Map audio {index + 1}</span>
              <select
                value={aud.sceneIndex === null ? "all" : String(aud.sceneIndex)}
                disabled={disabled}
                onChange={(e) =>
                  onPatchAudio(aud.key, {
                    sceneIndex: e.target.value === "all" ? null : Number(e.target.value),
                  })
                }
              >
                <option value="all">All scenes</option>
                {Array.from({ length: Math.max(sceneCount, 1) }, (_, i) => (
                  <option key={i} value={String(i)}>
                    Scene {i + 1}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="button" className="btn" disabled={disabled} onClick={() => onRemoveAudio(aud.key)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

export const StoryWorkbench = forwardRef<
  StoryWorkbenchHandle,
  {
    active: boolean;
    agnesApiKey: string;
    onAuthError: () => void;
    onAuthOk: () => void;
  }
>(function StoryWorkbench({ active, agnesApiKey, onAuthError, onAuthOk }, ref) {
  const [gate, setGate] = useState<Gate>("input");
  const [source, setSource] = useState<SourceMode>("topic");
  const [text, setText] = useState("");
  const [model, setModel] = useState<ModelId>(MODEL_V20);
  const [targetMinutes, setTargetMinutes] = useState(STORY_DEFAULT_MINUTES);
  const [v20Resolution, setV20Resolution] = useState<V20Resolution>(DEFAULT_V20_RESOLUTION);
  const [fps, setFps] = useState<V20Fps>(DEFAULT_FRAME_RATE);
  const [v20Aspect, setV20Aspect] = useState<V20FrameSizeId>("16:9");
  const [flashAspect, setFlashAspect] = useState<FlashAspectRatio>("16:9");
  const [imageAssets, setImageAssets] = useState<StoryImageAsset[]>([]);
  const [audioAssets, setAudioAssets] = useState<StoryAudioAsset[]>([]);
  const [assetStoring, setAssetStoring] = useState(false);
  const [seed, setSeed] = useState<number | null>(null);
  const [filmStyle, setFilmStyle] = useState("");
  const [characters, setCharacters] = useState<CharacterDraft[]>([]);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetNote, setSheetNote] = useState("");
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [story, setStory] = useState("");
  const [scenes, setScenes] = useState<SceneDraft[]>([]);
  const [modelSnapHint, setModelSnapHint] = useState<string | null>(null);
  const [triedLooksGood, setTriedLooksGood] = useState(false);
  const [openScenes, setOpenScenes] = useState<Set<number>>(() => new Set([0]));
  const [clips, setClips] = useState<Clip[]>([]);
  const [mergeChecked, setMergeChecked] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergedUrl, setMergedUrl] = useState<string | null>(null);
  const [queueNote, setQueueNote] = useState("");
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  const closeZoom = useCallback(() => setZoom(null), []);
  const [stillBusy, setStillBusy] = useState(false);
  const [stillNote, setStillNote] = useState("");
  const [stillErrors, setStillErrors] = useState<Record<number, string>>({});

  const scenesHeadingRef = useRef<HTMLHeadingElement>(null);
  const mergedPlayerRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onlyAbortRef = useRef<AbortController | null>(null);
  const lastCreateAtRef = useRef(0);
  const bridgeWaitRef = useRef(new Map<number, Promise<string | null>>());
  const bridgeGenRef = useRef(new Map<number, number>());
  const bridgeEpochRef = useRef(0);
  const filmStyleRef = useRef(filmStyle);
  const storyRef = useRef(story);
  const scenesRef = useRef(scenes);
  const clipsRef = useRef(clips);
  const modelRef = useRef(model);
  const filmRef = useRef({
    resolution: v20Resolution,
    fps,
    v20Aspect,
    flashAspect,
    width: 1280,
    height: 720,
    maxFrames: 481,
  });
  const assetsRef = useRef({ images: imageAssets, audios: audioAssets });
  const seedRef = useRef(0);
  const keyRef = useRef(agnesApiKey);
  const charactersRef = useRef<CharacterDraft[]>([]);
  const imageModelRef = useRef<ImageModelId>(DEFAULT_IMAGE_MODEL);
  scenesRef.current = scenes;
  clipsRef.current = clips;
  modelRef.current = model;
  const filmSize = v20Size(v20Resolution, v20Aspect);
  const filmMaxFrames = maxFramesForPixels(filmSize.width, filmSize.height);
  filmRef.current = {
    resolution: v20Resolution,
    fps,
    v20Aspect,
    flashAspect,
    width: filmSize.width,
    height: filmSize.height,
    maxFrames: filmMaxFrames,
  };
  assetsRef.current = { images: imageAssets, audios: audioAssets };
  seedRef.current = seed ?? 0;
  keyRef.current = agnesApiKey;
  charactersRef.current = characters;
  imageModelRef.current = characters[0]?.imageModel ?? DEFAULT_IMAGE_MODEL;
  filmStyleRef.current = filmStyle;
  storyRef.current = story;

  const durationOptions = useMemo(
    () => allowedV20Durations(fps, filmMaxFrames),
    [fps, filmMaxFrames],
  );
  const totalSec = scenes.reduce((sum, s) => sum + s.duration_sec, 0);
  const planRange = storySceneRange(targetMinutes, model, fps, filmMaxFrames);
  const planMinSec = storyClipMinSec(model, fps, filmMaxFrames);
  const planMaxSec = storyClipTargetSec(model, fps, filmMaxFrames);
  const skipSaveRef = useRef(true);

  useEffect(() => {
    const cp = loadCheckpoint();
    if (
      cp &&
      (cp.gate === "storyboard" || cp.gate === "clips") &&
      Array.isArray(cp.scenes) &&
      cp.scenes.length >= STORY_SCENE_MIN
    ) {
      setGate(cp.gate);
      setSource(cp.source === "story" ? "story" : "topic");
      setText(typeof cp.text === "string" ? cp.text : "");
      setModel(cp.model === MODEL_FLASH ? MODEL_FLASH : MODEL_V20);
      setTargetMinutes(
        clampStoryMinutes(
          typeof cp.targetMinutes === "number" ? cp.targetMinutes : STORY_DEFAULT_MINUTES,
        ),
      );
      setV20Resolution(parseResolution(cp.v20Resolution));
      setFps(parseFps(cp.fps));
      setV20Aspect(parseV20Aspect(cp.v20Aspect));
      setFlashAspect(parseFlashAspect(cp.flashAspect));
      setImageAssets(
        parseImageAssets(cp.imageAssets, {
          url: typeof cp.stillUrl === "string" ? cp.stillUrl : "",
          id: typeof cp.stillId === "string" ? cp.stillId : "",
          name: typeof cp.stillName === "string" ? cp.stillName : "",
        }),
      );
      setAudioAssets(parseAudioAssets(cp.audioAssets));
      setSeed(typeof cp.seed === "number" ? cp.seed : null);
      setFilmStyle(typeof cp.filmStyle === "string" ? cp.filmStyle : "");
      if (Array.isArray(cp.characters)) {
        setCharacters(
          cp.characters.slice(0, STORY_CHARACTER_MAX).map((c, i) => ({
            name: typeof c.name === "string" && c.name.trim() ? c.name : `Character ${i + 1}`,
            role: typeof c.role === "string" ? c.role : "",
            appearance: typeof c.appearance === "string" ? c.appearance : "",
            sheet_prompt: typeof c.sheet_prompt === "string" ? c.sheet_prompt : "",
            stillId: typeof c.stillId === "string" ? c.stillId : "",
            stillUrl: typeof c.stillUrl === "string" ? c.stillUrl : "",
            sampleId: typeof c.sampleId === "string" ? c.sampleId : "",
            sampleUrl: typeof c.sampleUrl === "string" ? c.sampleUrl : "",
            sampleName: typeof c.sampleName === "string" ? c.sampleName : "",
            generatePrompt: typeof c.generatePrompt === "string" ? c.generatePrompt : "",
            imageModel: isImageModelId(c.imageModel) ? c.imageModel : DEFAULT_IMAGE_MODEL,
          })),
        );
      }
      setStory(typeof cp.story === "string" ? cp.story : "");
      const nextScenes = cp.scenes.slice(0, STORY_SCENE_HARD_MAX).map((s) => ({
        ...s,
        cast: Array.isArray(s.cast) ? s.cast : [],
        bridgeId: typeof s.bridgeId === "string" ? s.bridgeId : "",
        bridgeUrl: typeof s.bridgeUrl === "string" ? s.bridgeUrl : "",
        videoPrompt: typeof s.videoPrompt === "string" ? s.videoPrompt : "",
      }));
      setScenes(nextScenes);
      const restored: Clip[] = nextScenes.map((_, i) => {
        const c = cp.clips[i] ?? { status: "waiting" as const };
        if (c.status === "generating" || c.status === "queued") {
          return {
            ...c,
            status: "failed" as const,
            error: "Interrupted. Resume keeps finished clips.",
            progress: undefined,
            resumeKind: c.videoId ? ("poll" as const) : ("create" as const),
          };
        }
        if (String(c.status) === "stale") {
          return { status: "waiting" as const };
        }
        return c;
      });
      setClips(restored);
      clipsRef.current = restored;
      lastCreateAtRef.current = typeof cp.lastCreateAt === "number" ? cp.lastCreateAt : 0;
    }
    skipSaveRef.current = false;
  }, []);

  useEffect(() => {
    if (gate !== "storyboard") return;
    if (scenes.length === 0 || characters.length === 0) return;
    if (scenes.every((s) => s.bridgeUrl)) return;
    void fetchAllBridges();
  }, [gate, scenes.length, characters.length]);

  useEffect(() => {
    if (skipSaveRef.current) return;
    if (gate === "input" && scenes.length === 0 && clips.length === 0) {
      clearCheckpoint();
      return;
    }
    const payload: StoryCheckpoint = {
      gate,
      source,
      text,
      model,
      targetMinutes,
      v20Resolution,
      fps,
      v20Aspect,
      flashAspect,
      imageAssets,
      audioAssets,
      stillUrl: imageAssets[0]?.url ?? "",
      stillId: imageAssets[0]?.id ?? "",
      stillName: imageAssets[0]?.name ?? "",
      seed,
      filmStyle,
      characters,
      story,
      scenes,
      clips: clips.map((c) => ({
        status: c.status,
        videoId: c.videoId,
        url: c.url,
        lastFrameId: c.lastFrameId,
        lastFrameSrc: c.lastFrameSrc,
        error: c.error,
        resumeKind: c.resumeKind,
      })),
      lastCreateAt: lastCreateAtRef.current,
    };
    try {
      sessionStorage.setItem(STORY_CHECKPOINT_KEY, JSON.stringify(payload));
    } catch {
      /* ignore quota / private mode */
    }
  }, [
    gate,
    source,
    text,
    model,
    targetMinutes,
    v20Resolution,
    fps,
    v20Aspect,
    flashAspect,
    imageAssets,
    audioAssets,
    seed,
    filmStyle,
    characters,
    story,
    scenes,
    clips,
  ]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      onlyAbortRef.current?.abort();
    };
  }, []);

  function stopQueue() {
    abortRef.current?.abort();
    abortRef.current = null;
    onlyAbortRef.current?.abort();
    onlyAbortRef.current = null;
  }

  function resetAll() {
    stopQueue();
    lastCreateAtRef.current = 0;
    setGate("input");
    setSource("topic");
    setText("");
    setModel(MODEL_V20);
    setTargetMinutes(STORY_DEFAULT_MINUTES);
    setV20Resolution(DEFAULT_V20_RESOLUTION);
    setFps(DEFAULT_FRAME_RATE);
    setV20Aspect("16:9");
    setFlashAspect("16:9");
    setImageAssets([]);
    setAudioAssets([]);
    setAssetStoring(false);
    setWriting(false);
    setWriteError(null);
    setStory("");
    setScenes([]);
    setModelSnapHint(null);
    setTriedLooksGood(false);
    setOpenScenes(new Set());
    setClips([]);
    clipsRef.current = [];
    setMergeChecked(false);
    setMerging(false);
    setMergeError(null);
    setMergedUrl(null);
    setQueueNote("");
    setSeed(null);
    setFilmStyle("");
    setCharacters([]);
    setSheetBusy(false);
    setSheetNote("");
    setSheetError(null);
    setStillBusy(false);
    setStillNote("");
    setStillErrors({});
    bumpBridgeEpoch();
    clearCheckpoint();
  }

  useImperativeHandle(ref, () => ({
    reset() {
      const dirty =
        text.trim().length > 0 ||
        scenes.length > 0 ||
        clips.length > 0 ||
        writing ||
        Boolean(mergedUrl);
      if (dirty && !window.confirm("Clear this story and start over?")) return;
      resetAll();
    },
  }));

  function snapDurations(nextModel: ModelId, nextFps: V20Fps, nextResolution: V20Resolution, nextAspect: V20FrameSizeId) {
    const size = v20Size(nextResolution, nextAspect);
    const maxFrames = maxFramesForPixels(size.width, size.height);
    setScenes((prev) => {
      if (prev.length === 0) return prev;
      const anyCustom = prev.some((s) => s.durationTouched);
      const nextScenes = prev.map((s) => ({
        ...s,
        duration_sec: snapStoryDuration(s.duration_sec, nextModel, nextFps, maxFrames),
      }));
      const changed = nextScenes.some((s, i) => s.duration_sec !== prev[i].duration_sec);
      setModelSnapHint(
        changed
          ? anyCustom
            ? "Custom durations were snapped to this resolution / fps / model."
            : "Durations were snapped to this resolution / fps / model."
          : null,
      );
      return nextScenes;
    });
  }

  function changeModel(next: ModelId) {
    setModel(next);
    snapDurations(next, fps, v20Resolution, v20Aspect);
  }

  function changeResolution(next: V20Resolution) {
    setV20Resolution(next);
    snapDurations(model, fps, next, v20Aspect);
  }

  function changeFps(next: V20Fps) {
    setFps(next);
    snapDurations(model, next, v20Resolution, v20Aspect);
  }

  function changeV20Aspect(next: V20FrameSizeId) {
    setV20Aspect(next);
    snapDurations(model, fps, v20Resolution, next);
  }

  async function storeMediaFile(
    file: File,
    onError: (detail: string) => void = setWriteError,
  ): Promise<{ url: string; id: string } | null> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/videos/media", { method: "POST", body: fd });
    if (!res.ok) {
      onError(await readDetail(res));
      return null;
    }
    const body: unknown = await res.json();
    const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
    const url = rec && typeof rec.url === "string" ? rec.url : "";
    const id = rec && typeof rec.id === "string" ? rec.id : "";
    if (!url) {
      onError("Could not store this file. Try again.");
      return null;
    }
    return { url, id };
  }

  async function uploadImageFiles(files: File[]) {
    if (files.length === 0) return;
    setAssetStoring(true);
    setWriteError(null);
    try {
      const room = STORY_IMAGE_LIBRARY_MAX - imageAssets.length;
      const picked = files.slice(0, Math.max(0, room));
      const added: StoryImageAsset[] = [];
      for (const file of picked) {
        const stored = await storeMediaFile(file);
        if (!stored) break;
        added.push({
          key: nextAssetKey("img"),
          id: stored.id,
          url: stored.url,
          name: file.name,
          selected: true,
          kind: "character",
          characterName: "",
        });
      }
      if (added.length) setImageAssets((prev) => [...prev, ...added].slice(0, STORY_IMAGE_LIBRARY_MAX));
    } catch {
      setWriteError("Could not store this file. Try again.");
    } finally {
      setAssetStoring(false);
    }
  }

  async function uploadAudioFiles(files: File[]) {
    if (files.length === 0) return;
    setAssetStoring(true);
    setWriteError(null);
    try {
      const room = STORY_AUDIO_LIBRARY_MAX - audioAssets.length;
      const picked = files.slice(0, Math.max(0, room));
      const added: StoryAudioAsset[] = [];
      for (const file of picked) {
        const stored = await storeMediaFile(file);
        if (!stored) break;
        added.push({
          key: nextAssetKey("aud"),
          id: stored.id,
          url: stored.url,
          name: file.name,
          selected: true,
          sceneIndex: null,
        });
      }
      if (added.length) setAudioAssets((prev) => [...prev, ...added].slice(0, STORY_AUDIO_LIBRARY_MAX));
    } catch {
      setWriteError("Could not store this file. Try again.");
    } finally {
      setAssetStoring(false);
    }
  }

  async function drawCharacterSheet(ch: CharacterDraft, style: string): Promise<CharacterDraft | null> {
    if (!ch.appearance.trim() && !ch.sheet_prompt.trim() && !ch.generatePrompt.trim() && !ch.sampleUrl) {
      setSheetError(`No description or sample to draw ${ch.name || "this character"}.`);
      return null;
    }
    const payload: Record<string, unknown> = {
      name: ch.name,
      appearance: ch.appearance,
      style,
      sheet_prompt: ch.sheet_prompt,
      prompt: ch.generatePrompt,
      model: ch.imageModel || DEFAULT_IMAGE_MODEL,
    };
    if (ch.sampleUrl) payload.image = ch.sampleUrl;
    const typedKey = keyRef.current.trim();
    if (typedKey) payload.agnes_api_key = typedKey;
    const res = await fetch("/api/character-sheet", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      onAuthError();
      setSheetError(null);
      return null;
    }
    if (!res.ok) {
      setSheetError(await readDetail(res));
      return null;
    }
    onAuthOk();
    const body: unknown = await res.json();
    const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
    const url = rec && typeof rec.url === "string" ? rec.url : "";
    const id = rec && typeof rec.id === "string" ? rec.id : "";
    if (!url || !id) {
      setSheetError("Character sheet did not return an image.");
      return null;
    }
    return { ...ch, stillId: id, stillUrl: url };
  }

  async function fetchAllSheets(list: CharacterDraft[], style: string) {
    if (list.length === 0) return list;
    setSheetBusy(true);
    setSheetError(null);
    const next = list.map((c) => ({ ...c }));
    try {
      const pending = next
        .map((ch, i) => ({ ch, i }))
        .filter(({ ch }) => !ch.stillUrl);
      if (pending.length === 0) {
        setSheetNote("");
        charactersRef.current = next;
        return next;
      }
      setSheetNote(
        pending.length === 1
          ? `Drawing spritesheet: ${pending[0].ch.name}`
          : `Drawing ${pending.length} spritesheets together…`,
      );
      const drawn = await Promise.all(
        pending.map(({ ch }) => drawCharacterSheet(ch, style)),
      );
      let failed: string | null = null;
      for (let p = 0; p < pending.length; p += 1) {
        const result = drawn[p];
        if (!result) {
          failed = pending[p].ch.name;
          continue;
        }
        next[pending[p].i] = result;
      }
      setCharacters(next.map((c) => ({ ...c })));
      charactersRef.current = next;
      if (failed && next.some((c) => !c.stillUrl)) {
        return next;
      }
      setSheetNote("");
      return next;
    } catch {
      setSheetError("Could not generate a character spritesheet.");
      return next;
    } finally {
      setSheetBusy(false);
    }
  }

  async function regenOneSheet(index: number) {
    const ch = characters[index];
    if (!ch) return;
    setSheetBusy(true);
    setSheetError(null);
    setSheetNote(`Drawing spritesheet: ${ch.name}`);
    try {
      const drawn = await drawCharacterSheet(ch, filmStyle);
      if (!drawn) return;
      setCharacters((prev) => prev.map((c, i) => (i === index ? drawn : c)));
      setSheetNote("");
    } catch {
      setSheetError("Could not generate a character spritesheet.");
    } finally {
      setSheetBusy(false);
    }
  }

  function patchCharacter(index: number, patch: Partial<CharacterDraft>) {
    setCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  async function uploadCharacterSample(index: number, file: File | undefined) {
    if (!file) return;
    setAssetStoring(true);
    setSheetError(null);
    try {
      const stored = await storeMediaFile(file, setSheetError);
      if (!stored) return;
      patchCharacter(index, {
        sampleId: stored.id,
        sampleUrl: stored.url,
        sampleName: file.name,
      });
    } catch {
      setSheetError("Could not store this sample image.");
    } finally {
      setAssetStoring(false);
    }
  }

  function openZoom(src: string, alt: string) {
    setZoom({ src, alt });
  }

  async function writeStoryboard(fromBoard = false) {
    const trimmed = (fromBoard ? story || text : text).trim();
    const sendSource: SourceMode = fromBoard ? "story" : source;
    if (!trimmed) {
      setWriteError(sendSource === "topic" ? "Enter a topic." : "Paste a story.");
      return;
    }
    setWriting(true);
    setWriteError(null);
    try {
      const payload: Record<string, unknown> = {
        source: sendSource,
        text: trimmed,
        video_model: model,
        target_minutes: targetMinutes,
        frame_rate: fps,
        resolution: v20Resolution,
        aspect_ratio: model === MODEL_FLASH ? flashAspect : v20Aspect,
      };
      const typedKey = keyRef.current.trim();
      if (typedKey) payload.agnes_api_key = typedKey;
      const res = await fetch("/api/storyboard", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        onAuthError();
        setWriteError(null);
        return;
      }
      if (!res.ok) {
        setWriteError(await readDetail(res));
        return;
      }
      onAuthOk();
      const body: unknown = await res.json();
      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as { story?: unknown }).story !== "string" ||
        !Array.isArray((body as { scenes?: unknown }).scenes)
      ) {
        setWriteError("The storyboard was not valid JSON. Retry write storyboard.");
        return;
      }
      const nextScenes: SceneDraft[] = [];
      for (const item of (body as { scenes: unknown[] }).scenes) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const str = (key: string) => (typeof rec[key] === "string" ? rec[key] : "");
        const castRaw = rec.cast;
        const cast: string[] = [];
        if (Array.isArray(castRaw)) {
          for (const name of castRaw) {
            if (typeof name === "string" && name.trim() && !cast.includes(name.trim())) {
              cast.push(name.trim());
            }
          }
        }
        nextScenes.push({
          title: str("title") || `Scene ${nextScenes.length + 1}`,
          duration_sec: snapStoryDuration(
            typeof rec.duration_sec === "number" ? rec.duration_sec : 5,
            model,
            fps,
            filmMaxFrames,
          ),
          durationTouched: false,
          cast,
          setting: str("setting") || str("visual_prompt"),
          subject: str("subject"),
          action: str("action"),
          camera_movement: str("camera_movement"),
          lighting: str("lighting"),
          style: str("style"),
          dialogue: str("dialogue") || "None.",
          videoPrompt: "",
          bridgeId: "",
          bridgeUrl: "",
        });
      }
      if (nextScenes.length < STORY_SCENE_MIN) {
        setWriteError(
          "The model returned only one scene. Story needs at least two. Retry write storyboard.",
        );
        return;
      }
      const recBody = body as Record<string, unknown>;
      setStory(typeof recBody.story === "string" ? recBody.story : "");
      const style = typeof recBody.style === "string" ? recBody.style : "";
      setFilmStyle(style);
      const rawChars = Array.isArray(recBody.characters)
        ? recBody.characters
        : recBody.character && typeof recBody.character === "object"
          ? [recBody.character]
          : [];
      const nextChars: CharacterDraft[] = [];
      for (const item of rawChars) {
        if (typeof item !== "object" || item === null) continue;
        if (nextChars.length >= STORY_CHARACTER_MAX) break;
        const rec = item as Record<string, unknown>;
        const str = (key: string) => (typeof rec[key] === "string" ? rec[key] : "");
        nextChars.push({
          name: str("name") || `Character ${nextChars.length + 1}`,
          role: str("role"),
          appearance: str("appearance"),
          sheet_prompt: str("sheet_prompt"),
          stillId: "",
          stillUrl: "",
          ...emptySheetFields(),
        });
      }
      if (nextChars.length === 0) {
        nextChars.push({
          name: "Hero",
          role: "protagonist",
          appearance: "",
          sheet_prompt: "",
          stillId: "",
          stillUrl: "",
          ...emptySheetFields(),
        });
      }
      const bound = bindAssetsToCharacters(nextChars, imageAssets);
      for (const scene of nextScenes) {
        if (scene.cast.length === 0) scene.cast = [bound.chars[0].name];
      }
      setCharacters(bound.chars);
      setImageAssets(bound.images);
      const nextSeed =
        typeof recBody.seed === "number" && Number.isInteger(recBody.seed) ? recBody.seed : Math.floor(Math.random() * 2_147_483_646) + 1;
      setSeed(nextSeed);
      seedRef.current = nextSeed;
      setScenes(nextScenes);
      setTriedLooksGood(false);
      setOpenScenes(new Set(nextScenes.length ? [0] : []));
      setModelSnapHint(null);
      bumpBridgeEpoch();
      setStillErrors({});
      setGate("storyboard");
      queueMicrotask(() => scenesHeadingRef.current?.focus());
      void fetchAllSheets(bound.chars, style).then((drawn) => {
        if (drawn.some((c) => c.stillUrl)) void fetchAllBridges();
      });
    } catch {
      setWriteError("Agnes is unavailable or the job was not found.");
    } finally {
      setWriting(false);
    }
  }

  function dropScene(index: number) {
    if (scenes.length <= STORY_SCENE_MIN) return;
    setScenes((prev) => prev.filter((_, i) => i !== index));
    setOpenScenes((prev) => {
      const next = new Set<number>();
      for (const i of prev) {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      }
      return next;
    });
  }

  function goBack() {
    if (gate === "storyboard") {
      setGate("input");
      return;
    }
    if (gate === "clips") {
      if (!window.confirm("This throws away generated clips. Storyboard stays.")) return;
      stopQueue();
      setClips([]);
      clipsRef.current = [];
      setMergeChecked(false);
      setMerging(false);
      setMergeError(null);
      setMergedUrl(null);
      setQueueNote("");
      setGate("storyboard");
    }
  }

  function patchClip(index: number, patch: Partial<Clip>) {
    setClips((prev) => {
      const next = prev.map((c, i) => (i === index ? { ...c, ...patch } : c));
      clipsRef.current = next;
      return next;
    });
  }

  function waitStoryJob(
    videoId: string,
    pollModel: ModelId,
    signal: AbortSignal,
    onStatus: (progress?: number) => void,
  ): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
    return new Promise((resolve) => {
      const params = new URLSearchParams({
        video_id: videoId,
        model_name: pollModel,
        pace: "story",
      });
      const es = new EventSource(`/api/videos/events?${params.toString()}`);
      let settled = false;
      const settle = (result: { ok: true; url: string } | { ok: false; message: string }) => {
        if (settled) return;
        settled = true;
        es.close();
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => settle({ ok: false, message: "Aborted" });
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) {
        onAbort();
        return;
      }
      es.addEventListener("status", (e: MessageEvent) => {
        if (settled) return;
        const data = parseEventPayload(e.data);
        if (!data || !isJobStatus(data.status)) return;
        if (data.status !== "queued" && data.status !== "in_progress") return;
        onStatus(typeof data.progress === "number" ? data.progress : undefined);
      });
      es.addEventListener("completed", (e: MessageEvent) => {
        const data = parseEventPayload(e.data);
        const url = data && typeof data.url === "string" ? data.url : "";
        if (!url || !isPublicHttpsUrl(url)) {
          settle({ ok: false, message: "Clip finished but no playable URL." });
          return;
        }
        settle({ ok: true, url });
      });
      es.addEventListener("failed", (e: MessageEvent) => {
        const data = parseEventPayload(e.data);
        const message =
          data && typeof data.message === "string" ? data.message : "Generation failed.";
        settle({ ok: false, message });
      });
      es.addEventListener("timeout", () => {
        settle({ ok: false, message: "Still generating? Status check timed out." });
      });
      es.addEventListener("stream_error", (e: MessageEvent) => {
        const data = parseEventPayload(e.data);
        const message =
          data && typeof data.message === "string"
            ? data.message
            : "Status check failed. You can check status.";
        settle({ ok: false, message });
      });
      es.addEventListener("error", () => {
        settle({ ok: false, message: "Status check failed. You can check status." });
      });
    });
  }

  async function extractFrame(url: string): Promise<{ ok: true; id: string } | { ok: false; detail: string }> {
    try {
      const res = await fetch("/api/videos/frame", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) return { ok: false, detail: await readDetail(res) };
      const body: unknown = await res.json();
      const id =
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        typeof (body as { id: unknown }).id === "string"
          ? (body as { id: string }).id
          : "";
      if (!id) return { ok: false, detail: "Could not extract the last frame." };
      return { ok: true, id };
    } catch {
      return { ok: false, detail: "Could not extract the last frame." };
    }
  }

  async function finishClip(
    i: number,
    createdId: string,
    url: string,
    signal: AbortSignal,
  ): Promise<"ok" | "fail" | "abort"> {
    const frame = await extractFrame(url);
    if (signal.aborted) return "abort";
    patchClip(i, {
      status: "ready",
      url,
      videoId: createdId,
      progress: undefined,
      error: undefined,
      lastFrameId: frame.ok ? frame.id : undefined,
      lastFrameSrc: frame.ok ? `/api/media/${frame.id}` : undefined,
    });
    return "ok";
  }

  function patchScene(index: number, patch: Partial<SceneDraft>) {
    setScenes((prev) => {
      const next = prev.map((s, i) => (i === index ? { ...s, ...patch } : s));
      scenesRef.current = next;
      return next;
    });
  }

  function bumpBridgeEpoch() {
    bridgeEpochRef.current += 1;
    bridgeWaitRef.current.clear();
    bridgeGenRef.current = new Map();
  }

  function setStillErrorAt(index: number, detail: string | null) {
    setStillErrors((prev) => {
      if (!detail) {
        if (!(index in prev)) return prev;
        const next = { ...prev };
        delete next[index];
        return next;
      }
      return { ...prev, [index]: detail };
    });
  }

  async function ensureBridge(index: number, signal?: AbortSignal): Promise<string | null> {
    const existing = scenesRef.current[index];
    if (!existing) return null;
    if (existing.bridgeUrl) return existing.bridgeUrl;
    const waiting = bridgeWaitRef.current.get(index);
    if (waiting) return waiting;
    const epoch = bridgeEpochRef.current;
    const gen = bridgeGenRef.current.get(index) ?? 0;
    const job = (async () => {
      try {
        const scene = scenesRef.current[index];
        if (!scene) return null;
        const roster = charactersRef.current;
        const wanted = ((scene.cast ?? []).length > 0 ? scene.cast : roster.map((c) => c.name)).map((n) =>
          n.toLowerCase(),
        );
        const used = roster.filter((c) => wanted.includes(c.name.toLowerCase()));
        const prompt = sceneBridgeStillPrompt(
          scene,
          (used.length > 0 ? used : roster).map((c) => ({ name: c.name, appearance: c.appearance })),
          filmStyleRef.current,
          storyRef.current,
        );
        const payload: Record<string, unknown> = {
          prompt,
          ratio: modelRef.current === MODEL_FLASH ? filmRef.current.flashAspect : filmRef.current.v20Aspect,
          model: imageModelRef.current,
        };
        const typedKey = keyRef.current.trim();
        if (typedKey) payload.agnes_api_key = typedKey;
        if (abortRef.current || onlyAbortRef.current) setQueueNote(`Drawing landing still for scene ${index + 1}…`);
        const res = await fetch("/api/scene-still", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (signal?.aborted) return null;
        if (bridgeEpochRef.current !== epoch) return null;
        if ((bridgeGenRef.current.get(index) ?? 0) !== gen) return null;
        if (res.status === 401) {
          onAuthError();
          return null;
        }
        if (!res.ok) {
          setStillErrorAt(index, await readDetail(res));
          return null;
        }
        onAuthOk();
        const body: unknown = await res.json();
        const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
        const url = rec && typeof rec.url === "string" ? rec.url : "";
        const id = rec && typeof rec.id === "string" ? rec.id : "";
        if (!url) {
          setStillErrorAt(index, "End still did not return an image.");
          return null;
        }
        if (bridgeEpochRef.current !== epoch) return null;
        if ((bridgeGenRef.current.get(index) ?? 0) !== gen) return null;
        setStillErrorAt(index, null);
        patchScene(index, { bridgeId: id, bridgeUrl: url });
        return url;
      } catch {
        if (bridgeEpochRef.current !== epoch) return null;
        if ((bridgeGenRef.current.get(index) ?? 0) !== gen) return null;
        setStillErrorAt(index, "Could not draw this end still.");
        return null;
      }
    })();
    bridgeWaitRef.current.set(index, job);
    try {
      return await job;
    } finally {
      if (bridgeWaitRef.current.get(index) === job) bridgeWaitRef.current.delete(index);
    }
  }

  async function fetchAllBridges() {
    const list = scenesRef.current;
    if (list.length === 0) return;
    setStillBusy(true);
    setStillNote(
      list.length === 1 ? "Drawing end still for scene 1…" : `Drawing ${list.length} scene end stills…`,
    );
    try {
      await Promise.all(list.map((_, i) => ensureBridge(i)));
    } catch {
      /* ensureBridge swallows fetch errors */
    } finally {
      setStillBusy(false);
      setStillNote("");
    }
  }

  async function regenSceneStill(index: number) {
    bridgeWaitRef.current.delete(index);
    bridgeGenRef.current.set(index, (bridgeGenRef.current.get(index) ?? 0) + 1);
    patchScene(index, { bridgeId: "", bridgeUrl: "" });
    setStillErrorAt(index, null);
    setStillBusy(true);
    setStillNote(`Drawing end still for scene ${index + 1}…`);
    try {
      await ensureBridge(index);
    } catch {
      setStillErrorAt(index, "Could not draw this end still.");
    } finally {
      setStillBusy(false);
      setStillNote("");
    }
  }

  async function pollClip(i: number, createdId: string, signal: AbortSignal): Promise<void> {
    const done = await waitStoryJob(createdId, modelRef.current, signal, (progress) => {
      patchClip(i, { status: "generating", progress, videoId: createdId });
    });
    if (signal.aborted) return;
    if (!done.ok) {
      if (done.message === "Aborted") return;
      patchClip(i, {
        status: "failed",
        error: done.message,
        videoId: createdId,
        resumeKind: failKindFromWait(done.message),
      });
      return;
    }
    await finishClip(i, createdId, done.url, signal);
  }

  async function runQueue(from: number, signal: AbortSignal, resume: boolean, only?: number) {
    const list = scenesRef.current;
    const inflight: Promise<void>[] = [];
    const last = only == null ? list.length - 1 : Math.min(only, list.length - 1);

    for (let i = from; i <= last; i += 1) {
      if (signal.aborted) break;
      const cur = clipsRef.current[i] ?? { status: "waiting" as const };

      if (resume && cur.status === "ready" && cur.url && isPublicHttpsUrl(cur.url)) {
        continue;
      }

      if (resume && cur.url && isPublicHttpsUrl(cur.url) && !cur.lastFrameId) {
        inflight.push(finishClip(i, cur.videoId ?? "", cur.url, signal).then(() => undefined));
        continue;
      }

      if (resume && shouldReattachPoll(cur) && cur.videoId) {
        const createdId = cur.videoId;
        patchClip(i, { status: "generating", error: undefined, progress: undefined, videoId: createdId });
        inflight.push(pollClip(i, createdId, signal));
        continue;
      }

      patchClip(i, {
        status: "queued",
        error: undefined,
        progress: undefined,
        url: undefined,
        videoId: undefined,
        lastFrameId: undefined,
        lastFrameSrc: undefined,
      });

      const endFrame = await ensureBridge(i, signal);
      if (signal.aborted) break;
      if (!endFrame) {
        patchClip(i, {
          status: "failed",
          error: "Could not draw this scene's landing still.",
          resumeKind: "create",
        });
        break;
      }
      let startFrame: string | undefined;
      if (i > 0) {
        startFrame = (await ensureBridge(i - 1, signal)) ?? undefined;
        if (signal.aborted) break;
        if (!startFrame) {
          patchClip(i, {
            status: "failed",
            error: "Need the landing still from the scene before this.",
            resumeKind: "create",
          });
          break;
        }
      }
      if (i + 1 < list.length) void ensureBridge(i + 1, signal);

      if (lastCreateAtRef.current > 0) {
        const wait = STORY_CREATE_GAP_MS - (Date.now() - lastCreateAtRef.current);
        if (wait > 0) {
          setQueueNote(`Next create in ~${Math.ceil(wait / 1000)}s. Earlier clips can keep generating.`);
          await sleep(wait, signal);
        }
      }
      if (signal.aborted) break;

      const scene = scenesRef.current[i];
      const roster = charactersRef.current;
      const wanted = ((scene.cast ?? []).length > 0 ? scene.cast : roster.map((c) => c.name)).map((n) =>
        n.toLowerCase(),
      );
      const present = roster.filter((c) => c.stillUrl && wanted.includes(c.name.toLowerCase()));
      const used = present.length > 0 ? present : roster.filter((c) => c.stillUrl);
      const sheets = used.map((c) => c.stillUrl);
      const durations = scenesRef.current.map((s) => s.duration_sec);
      const prev = i > 0 ? scenesRef.current[i - 1] : undefined;
      const custom = scene.videoPrompt.trim();
      const prompt = isComposedShotPrompt(custom, i)
        ? applyShotDurationLine(custom, i, durations)
        : formatStoryShot(
            i,
            durations,
            scene,
            used.map((c) => ({ name: c.name, appearance: c.appearance })),
            {
              hasStart: Boolean(startFrame),
              hasEnd: Boolean(endFrame),
              prevEnd: prev
                ? { setting: prev.setting, subject: prev.subject, action: prev.action }
                : undefined,
              extraPrompt: custom,
            },
          );
      const seedNow = seedRef.current || 1;
      const film = filmRef.current;
      const selectedImages = i === 0 ? selectedImageUrls(assetsRef.current.images) : [];
      const selectedAudios = selectedAudioUrls(assetsRef.current.audios, i);

      patchClip(i, { status: "generating", progress: undefined, error: undefined });
      const payload: Record<string, unknown> = {
        ...scenePayload(modelRef.current, prompt, scene.duration_sec, {
          sheets,
          startFrame,
          endFrame: endFrame ?? undefined,
          seed: seedNow,
          width: film.width,
          height: film.height,
          fps: film.fps,
          maxFrames: film.maxFrames,
          flashAspect: film.flashAspect,
          selectedImages,
          selectedAudios,
        }),
      };
      const typedKey = keyRef.current.trim();
      if (typedKey) payload.agnes_api_key = typedKey;

      let createdId: string;
      try {
        const res = await fetch("/api/videos", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        lastCreateAtRef.current = Date.now();
        if (res.status === 401) {
          onAuthError();
          patchClip(i, { status: "failed", error: "Add an Agnes API key in the header, or set AGNES_API_KEY in .env and restart.", resumeKind: "create" });
          break;
        }
        if (!res.ok) {
          patchClip(i, { status: "failed", error: await readDetail(res), resumeKind: "create" });
          break;
        }
        onAuthOk();
        const body: unknown = await res.json();
        const videoId =
          typeof body === "object" &&
          body !== null &&
          "video_id" in body &&
          typeof (body as { video_id: unknown }).video_id === "string"
            ? (body as { video_id: string }).video_id
            : "";
        if (!videoId) {
          patchClip(i, { status: "failed", error: "Agnes is unavailable or the job was not found.", resumeKind: "create" });
          break;
        }
        createdId = videoId;
      } catch (err) {
        if (isAbort(err)) break;
        patchClip(i, { status: "failed", error: "Agnes is unavailable or the job was not found.", resumeKind: "create" });
        break;
      }

      patchClip(i, { videoId: createdId });
      inflight.push(pollClip(i, createdId, signal));
    }

    await Promise.all(inflight);
    if (!signal.aborted) setQueueNote("");
  }

  function startQueue(from: number, resume = false, only?: number) {
    const ac = new AbortController();
    if (only == null) {
      stopQueue();
      abortRef.current = ac;
    } else {
      onlyAbortRef.current?.abort();
      onlyAbortRef.current = ac;
    }
    setMergeChecked(false);
    setMergeError(null);
    setMergedUrl(null);
    void runQueue(from, ac.signal, resume, only).catch((err) => {
      if (!isAbort(err)) {
        patchClip(from, {
          status: "failed",
          error: "Agnes is unavailable or the job was not found.",
          resumeKind: "create",
        });
      }
    });
  }

  function resumeFrom(index: number) {
    startQueue(index, true);
  }

  async function looksGood() {
    setTriedLooksGood(true);
    const missing = scenes.flatMap((s, i) => (shotReady(s) ? [] : [i]));
    if (missing.length > 0) {
      setOpenScenes(new Set(missing));
      return;
    }
    const bound = bindAssetsToCharacters(characters, imageAssets);
    setCharacters(bound.chars);
    setImageAssets(bound.images);
    charactersRef.current = bound.chars;
    if (bound.chars.length === 0) {
      setSheetError("Need at least one character.");
      return;
    }
    if (bound.chars.some((c) => !c.stillUrl)) {
      const drawn = await fetchAllSheets(bound.chars, filmStyle);
      const roster = drawn ?? charactersRef.current;
      if (roster.some((c) => !c.stillUrl)) {
        setSheetError("Wait for every character spritesheet, or regenerate the missing one.");
        return;
      }
    }
    if (scenesRef.current.some((s) => !s.bridgeUrl)) {
      await fetchAllBridges();
      scenesRef.current.forEach((s, i) => {
        if (!s.bridgeUrl) setStillErrorAt(i, "End still not drawn yet. Retry this cell.");
      });
      if (scenesRef.current.some((s) => !s.bridgeUrl)) return;
    }
    const snapped = scenes.map((s) => ({
      ...s,
      duration_sec: snapStoryDuration(s.duration_sec, model, fps, filmMaxFrames),
    }));
    scenesRef.current = snapped;
    setScenes(snapped);
    const initial: Clip[] = snapped.map(() => ({ status: "waiting" }));
    setClips(initial);
    clipsRef.current = initial;
    setGate("clips");
    startQueue(0, false);
  }

  function regenScene(index: number) {
    const next = clips.map((c, i) => (i === index ? { status: "waiting" as const } : c));
    setClips(next);
    clipsRef.current = next;
    startQueue(index, true, index);
  }

  async function mergeClips() {
    const urls = clips.map((c) => c.url).filter((u): u is string => typeof u === "string" && isPublicHttpsUrl(u));
    if (urls.length !== clips.length) {
      setMergeError("Every clip needs a playable URL before merge.");
      return;
    }
    setMerging(true);
    setMergeError(null);
    try {
      const res = await fetch("/api/videos/merge", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      if (!res.ok) {
        setMergeError(await readDetail(res));
        return;
      }
      const body: unknown = await res.json();
      const url =
        typeof body === "object" &&
        body !== null &&
        "url" in body &&
        typeof (body as { url: unknown }).url === "string"
          ? (body as { url: string }).url
          : "";
      if (!url) {
        setMergeError("Could not merge these clips.");
        return;
      }
      setMergedUrl(url);
      queueMicrotask(() => mergedPlayerRef.current?.focus());
    } catch {
      setMergeError("Could not merge these clips.");
    } finally {
      setMerging(false);
    }
  }

  const current = pipelineCurrent(gate, clips, mergedUrl);
  const allReady = clips.length > 0 && clips.every((c) => c.status === "ready");
  const generatingIndex = clips.findIndex((c) => c.status === "generating");
  const failedIndex = clips.findIndex((c) => c.status === "failed");

  const filmBlock = (idPrefix: string) => (
    <FilmSettings
      idPrefix={idPrefix}
      model={model}
      resolution={v20Resolution}
      fps={fps}
      v20Aspect={v20Aspect}
      flashAspect={flashAspect}
      onResolution={changeResolution}
      onFps={changeFps}
      onV20Aspect={changeV20Aspect}
      onFlashAspect={setFlashAspect}
    />
  );

  const assetsBlock = (idPrefix: string) => (
    <AssetLibrary
      idPrefix={idPrefix}
      disabled={writing || sheetBusy}
      storing={assetStoring}
      characters={characters}
      sceneCount={scenes.length}
      imageAssets={imageAssets}
      audioAssets={audioAssets}
      model={model}
      onPickImages={(files) => void uploadImageFiles(files)}
      onPickAudios={(files) => void uploadAudioFiles(files)}
      onPatchImage={(key, patch) =>
        setImageAssets((prev) => prev.map((img) => (img.key === key ? { ...img, ...patch } : img)))
      }
      onPatchAudio={(key, patch) =>
        setAudioAssets((prev) => prev.map((aud) => (aud.key === key ? { ...aud, ...patch } : aud)))
      }
      onRemoveImage={(key) => setImageAssets((prev) => prev.filter((img) => img.key !== key))}
      onRemoveAudio={(key) => setAudioAssets((prev) => prev.filter((aud) => aud.key !== key))}
    />
  );

  function queueLive(): string {
    if (merging) return `Merging ${clips.length} clips…`;
    if (mergedUrl) return "Merged.";
    const generating = clips
      .map((c, i) => (c.status === "generating" ? i + 1 : 0))
      .filter((n) => n > 0);
    if (generating.length > 0) {
      const queued = clips.filter((c) => c.status === "queued" || c.status === "waiting").length;
      const who = generating.length === 1 ? `Scene ${generating[0]}` : `Scenes ${generating.join(", ")}`;
      const extra = queued > 0 ? ` ${queued} still in line.` : "";
      return `${who} of ${clips.length} generating.${extra}`;
    }
    const fail = clips.findIndex((c) => c.status === "failed");
    if (fail >= 0) return `Scene ${fail + 1} failed. Finished clips stay. Resume continues from there.`;
    const queued = clips.findIndex((c) => c.status === "queued");
    if (queued >= 0) return `Scene ${queued + 1} of ${clips.length} next.`;
    if (allReady) return "All clips ready.";
    return "Waiting to start.";
  }

  function onWriteSubmit(e: FormEvent) {
    e.preventDefault();
    void writeStoryboard();
  }

  return (
    <div className="story-root" style={!active ? { display: "none" } : undefined} aria-hidden={!active}>
      <Pipeline current={current} onBack={gate === "input" ? null : goBack} />

      {gate === "input" ? (
        <div className="layout">
          <form className="request" onSubmit={onWriteSubmit} noValidate>
            <h2 className="block">Source</h2>
            <fieldset className="seg" style={{ border: 0, margin: "0 0 0.9rem" }}>
              <legend className="visually-hidden">Source</legend>
              <label>
                <input
                  type="radio"
                  name="story-source"
                  value="topic"
                  checked={source === "topic"}
                  onChange={() => setSource("topic")}
                />
                <span>Topic</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="story-source"
                  value="story"
                  checked={source === "story"}
                  onChange={() => setSource("story")}
                />
                <span>Paste story</span>
              </label>
            </fieldset>

            {source === "topic" ? (
              <div className="row">
                <label className="field" htmlFor="story-topic">
                  Topic{" "}
                  <abbr className="req" title="required">
                    *
                  </abbr>
                </label>
                <textarea
                  id="story-topic"
                  className="textarea-compact"
                  rows={3}
                  required
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <p className="hint">Same language as you type. One short film, not a series.</p>
              </div>
            ) : (
              <div className="row">
                <label className="field" htmlFor="story-paste">
                  Story{" "}
                  <abbr className="req" title="required">
                    *
                  </abbr>
                </label>
                <textarea
                  id="story-paste"
                  className="textarea-story"
                  rows={10}
                  required
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <p className="hint">
                  Keep your intent. The model tightens for picture, then splits scenes. You still confirm.
                </p>
              </div>
            )}

            <ModelRadios name="story-model-input" model={model} onChange={changeModel} />
            {filmBlock("story-input")}

            <div className="row">
              <label className="field" htmlFor="story-minutes">
                Film length{" "}
                <abbr className="req" title="required">
                  *
                </abbr>
              </label>
              <select
                id="story-minutes"
                className="story-minutes"
                value={targetMinutes}
                onChange={(e) => setTargetMinutes(Number(e.target.value))}
              >
                {STORY_MINUTES_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
              <p className="hint">
                Total film, not one Agnes call. Clip length follows each beat ({planMinSec}–{planMaxSec}s
                {model === MODEL_V20 ? " at this resolution / fps" : ""}), not always max. About{" "}
                {planRange.min}–{planRange.max} clips. Free accounts: about one create every 65s; previous
                clips can keep generating.
              </p>
            </div>

            {assetsBlock("story-input")}

            <div className="generate-bar">
              <button type="submit" className="btn btn-primary" disabled={writing || assetStoring}>
                {writing ? "Writing…" : "Write storyboard"}
              </button>
              <p className="hint">No Agnes create yet.</p>
            </div>
          </form>

          <aside className="job" aria-labelledby="storyboard-well-heading">
            <h2 className="block" id="storyboard-well-heading">
              Storyboard
            </h2>
            <div className="job-well" aria-busy={writing}>
              {writing ? (
                <div className="job-run">
                  <span className="spin" aria-hidden="true" />
                  <p className="job-line sr-status" aria-live="polite" aria-atomic="true">
                    Writing storyboard… then a spritesheet per character.
                  </p>
                </div>
              ) : writeError ? (
                <p className="form-error">{writeError}</p>
              ) : (
                <p className="hint">
                  Topic or paste. The model writes or refines, then you confirm scenes. No video until you say so.
                </p>
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {gate === "storyboard" ? (
        <div className="layout">
          <div className="request">
            <h2 className="block">Story</h2>
            <div className="row">
              <label className="visually-hidden" htmlFor="story-prose">
                Story
              </label>
              <textarea
                id="story-prose"
                className="textarea-story"
                rows={12}
                value={story}
                onChange={(e) => setStory(e.target.value)}
              />
              <p className="hint">
                {wordCount(story)} words · same language
              </p>
            </div>
            <p className="hint">
              TOTAL {scenes.length} scenes · {formatStoryLength(totalSec)}
              {seed !== null ? ` · seed ${seed}` : ""}
            </p>
            <p className="hint">
              Free ~1 create / 65s. Next clip can start while the previous is still generating. Same seed.
              Each person has a labeled model sheet with their name on it. Cuts share a landing still.
              The video is a live scene, not the sheet.
            </p>
            <h2 className="block">Characters</h2>
            <p className="hint">
              Up to {STORY_CHARACTER_MAX} main people. Separate labeled model sheet each, with the name printed
              on the sheet so video can map them. Never a group image.
            </p>
            {sheetBusy ? (
              <div className="job-run">
                <span className="spin" aria-hidden="true" />
                <p className="job-line">{sheetNote || "Drawing spritesheets…"}</p>
              </div>
            ) : null}
            {sheetError ? <p className="form-error">{sheetError}</p> : null}
            {characters.map((ch, index) => (
              <div className="scene-slot character-card" key={`cast-${index}`}>
                {ch.stillId || ch.stillUrl ? (
                  <ZoomableImage
                    src={mediaPreview(ch.stillId, ch.stillUrl)}
                    alt={`${ch.name} spritesheet`}
                    onZoom={openZoom}
                  />
                ) : (
                  <p className="hint">Spritesheet pending.</p>
                )}
                <div className="row">
                  <label className="field" htmlFor={`character-name-${index}`}>
                    Name
                  </label>
                  <input
                    id={`character-name-${index}`}
                    type="text"
                    value={ch.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      const prevName = ch.name;
                      setCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, name } : c)));
                      if (prevName) {
                        setImageAssets((prev) =>
                          prev.map((img) =>
                            img.characterName === prevName ? { ...img, characterName: name } : img,
                          ),
                        );
                      }
                    }}
                  />
                </div>
                <p className="hint">{ch.role || "character"}</p>
                <div className="row">
                  <label className="field" htmlFor={`character-look-${index}`}>
                    Appearance
                  </label>
                  <textarea
                    id={`character-look-${index}`}
                    className="prompt-short"
                    rows={3}
                    value={ch.appearance}
                    onChange={(e) => {
                      const appearance = e.target.value;
                      setCharacters((prev) =>
                        prev.map((c, i) => (i === index ? { ...c, appearance } : c)),
                      );
                    }}
                  />
                </div>
                <div className="row">
                  <label className="field" htmlFor={`character-sample-${index}`}>
                    Sample image
                  </label>
                  {ch.sampleUrl ? (
                    <ZoomableImage
                      src={mediaPreview(ch.sampleId, ch.sampleUrl)}
                      alt={`${ch.name} sample`}
                      onZoom={openZoom}
                    />
                  ) : null}
                  <input
                    id={`character-sample-${index}`}
                    type="file"
                    accept={IMAGE_ACCEPT}
                    disabled={sheetBusy || writing || assetStoring}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      void uploadCharacterSample(index, file);
                    }}
                  />
                  {ch.sampleName ? (
                    <p className="hint sample-meta">
                      Using {ch.sampleName}{" "}
                      <button
                        type="button"
                        className="btn btn-ghost sample-clear"
                        disabled={sheetBusy || writing}
                        onClick={() =>
                          patchCharacter(index, { sampleId: "", sampleUrl: "", sampleName: "" })
                        }
                      >
                        Remove
                      </button>
                    </p>
                  ) : (
                    <p className="hint">Optional. Upload a photo, then regenerate with prompt + model.</p>
                  )}
                </div>
                <div className="row">
                  <label className="field" htmlFor={`character-prompt-${index}`}>
                    Generate prompt
                  </label>
                  <textarea
                    id={`character-prompt-${index}`}
                    className="prompt-short"
                    rows={3}
                    value={ch.generatePrompt}
                    placeholder="Optional extra instruction for this labeled model sheet"
                    onChange={(e) => patchCharacter(index, { generatePrompt: e.target.value })}
                  />
                </div>
                <ImageModelSelect
                  id={`character-model-${index}`}
                  value={ch.imageModel}
                  onChange={(imageModel) => patchCharacter(index, { imageModel })}
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={sheetBusy || writing}
                  onClick={() => void regenOneSheet(index)}
                >
                  {sheetBusy ? "Drawing…" : "Regenerate this spritesheet"}
                </button>
              </div>
            ))}
            {assetsBlock("story-board")}
            <ModelRadios name="story-model-board" model={model} onChange={changeModel} />
            {filmBlock("story-board")}
            {modelSnapHint ? <p className="hint">{modelSnapHint}</p> : null}
            <button
              type="button"
              className="btn btn-ghost"
              disabled={writing}
              onClick={() => {
                if (!window.confirm("Replace these scenes? Edits go away. Clips have not started.")) return;
                void writeStoryboard(true);
              }}
            >
              {writing ? "Writing…" : "Regenerate storyboard"}
            </button>
            <p className="hint">Overwrites scene list. Story text is sent again.</p>
            {writeError ? <p className="form-error">{writeError}</p> : null}
          </div>

          <aside className="job" aria-labelledby="scenes-heading">
            <div className="board-meta">
              <h2 className="block" id="scenes-heading" tabIndex={-1} ref={scenesHeadingRef}>
                Scenes
              </h2>
              <p className="hint">
                {scenes.length} · {formatStoryLength(totalSec)}
                {targetMinutes ? ` · target ${targetMinutes} min` : ""}
              </p>
              {stillBusy || stillNote ? (
                <div className="job-run">
                  {stillBusy ? <span className="spin" aria-hidden="true" /> : null}
                  <p className="job-line">{stillNote || "Drawing scene stills…"}</p>
                </div>
              ) : null}
              <div className="scene-fold-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setOpenScenes(new Set(scenes.map((_, i) => i)))}
                >
                  Expand all
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setOpenScenes(new Set())}>
                  Collapse all
                </button>
              </div>
            </div>
            {scenes.map((scene, index) => {
              const empty = triedLooksGood && !shotReady(scene);
              const dropDisabled = scenes.length <= STORY_SCENE_MIN;
              const range = sceneTimeRange(
                scenes.map((s) => s.duration_sec),
                index,
              );
              const patch = (partial: Partial<SceneDraft>) => {
                setScenes((prev) => prev.map((s, i) => (i === index ? { ...s, ...partial } : s)));
              };
              return (
                <div key={`scene-${index}`} className={`scene-slot${empty ? " is-incomplete" : ""}`}>
                  {index === 0 ? (
                    <p className="handoff">
                      {characters.every((c) => c.stillUrl)
                        ? "Scene 1 starts from the cast spritesheets and ends on a generated still. That end still is the start of scene 2."
                        : "Spritesheets still drawing. Wait or regenerate the missing one."}
                    </p>
                  ) : (
                    <p className="handoff">
                      End of scene {index} is the start of scene {index + 1} — same picture, not drawn twice.
                    </p>
                  )}
                  <SceneBeatPair
                    index={index}
                    scene={scene}
                    scenes={scenes}
                    characters={characters}
                    stillBusy={stillBusy}
                    endError={stillErrors[index]}
                    onZoom={openZoom}
                    onRegenEnd={(i) => void regenSceneStill(i)}
                  />
                  <details
                    className="scene-fold"
                    open={openScenes.has(index)}
                    onToggle={(e) => {
                      const isOpen = e.currentTarget.open;
                      setOpenScenes((prev) => {
                        const next = new Set(prev);
                        if (isOpen) next.add(index);
                        else next.delete(index);
                        return next;
                      });
                    }}
                  >
                    <summary className="scene-summary">
                      <span className="scene-chevron" aria-hidden="true">
                        {openScenes.has(index) ? "▾" : "▸"}
                      </span>
                      <span className="scene-index">{index + 1}</span>
                      <span className="scene-summary-title">{scene.title.trim() || `Scene ${index + 1}`}</span>
                      <span className="hint">
                        {scene.duration_sec}s · {range.start}–{range.end}
                        {scene.cast.length > 0 ? ` · ${scene.cast.join(", ")}` : ""}
                      </span>
                      {empty ? (
                        <span className="field-error">Needs Scene / Subject / Action</span>
                      ) : null}
                    </summary>
                    <div className="scene-body">
                    <div className="scene-head">
                      <label className="field" htmlFor={`scene-title-${index}`}>
                        Title
                      </label>
                      <input
                        id={`scene-title-${index}`}
                        className="scene-title"
                        type="text"
                        aria-label={`Scene ${index + 1} title`}
                        value={scene.title}
                        onChange={(e) => {
                          const title = e.target.value;
                          setScenes((prev) => prev.map((s, i) => (i === index ? { ...s, title } : s)));
                        }}
                      />
                    </div>
                    <p className="hint">
                      Duration: {range.start}–{range.end} sec
                      {scene.cast.length > 0 ? ` · cast ${scene.cast.join(", ")}` : ""}
                    </p>
                    <SceneDurationPicker
                      index={index}
                      scene={scene}
                      model={model}
                      durationOptions={durationOptions}
                      v20Resolution={v20Resolution}
                      fps={fps}
                      planMaxSec={planMaxSec}
                      filmMaxFrames={filmMaxFrames}
                      namePrefix="scene"
                      onPatch={patch}
                    />
                    <div className="row">
                      <label className="field" htmlFor={`scene-setting-${index}`}>
                        Scene{" "}
                        <abbr className="req" title="required">
                          *
                        </abbr>
                      </label>
                      <textarea
                        id={`scene-setting-${index}`}
                        rows={2}
                        value={scene.setting}
                        aria-invalid={empty && !scene.setting.trim() ? true : undefined}
                        onChange={(e) => patch({ setting: e.target.value })}
                      />
                    </div>
                    <div className="row">
                      <label className="field" htmlFor={`scene-subject-${index}`}>
                        Subject{" "}
                        <abbr className="req" title="required">
                          *
                        </abbr>
                      </label>
                      <textarea
                        id={`scene-subject-${index}`}
                        rows={2}
                        value={scene.subject}
                        aria-invalid={empty && !scene.subject.trim() ? true : undefined}
                        onChange={(e) => patch({ subject: e.target.value })}
                      />
                    </div>
                    <div className="row">
                      <label className="field" htmlFor={`scene-action-${index}`}>
                        Action{" "}
                        <abbr className="req" title="required">
                          *
                        </abbr>
                      </label>
                      <textarea
                        id={`scene-action-${index}`}
                        rows={2}
                        value={scene.action}
                        aria-invalid={empty && !scene.action.trim() ? true : undefined}
                        onChange={(e) => patch({ action: e.target.value })}
                      />
                    </div>
                    <div className="row">
                      <label className="field" htmlFor={`scene-cam-${index}`}>
                        Camera_Movement
                      </label>
                      <textarea
                        id={`scene-cam-${index}`}
                        rows={2}
                        value={scene.camera_movement}
                        onChange={(e) => patch({ camera_movement: e.target.value })}
                      />
                    </div>
                    <div className="row">
                      <label className="field" htmlFor={`scene-light-${index}`}>
                        Lighting
                      </label>
                      <textarea
                        id={`scene-light-${index}`}
                        rows={2}
                        value={scene.lighting}
                        onChange={(e) => patch({ lighting: e.target.value })}
                      />
                    </div>
                    <div className="row">
                      <label className="field" htmlFor={`scene-style-${index}`}>
                        Style
                      </label>
                      <input
                        id={`scene-style-${index}`}
                        type="text"
                        value={scene.style}
                        onChange={(e) => patch({ style: e.target.value })}
                      />
                    </div>
                    <div className="row">
                      <label className="field" htmlFor={`scene-dialogue-${index}`}>
                        Dialogue
                      </label>
                      <textarea
                        id={`scene-dialogue-${index}`}
                        rows={2}
                        value={scene.dialogue}
                        onChange={(e) => patch({ dialogue: e.target.value })}
                      />
                    </div>
                    <div className="row">
                      <label className="field" htmlFor={`scene-video-prompt-${index}`}>
                        Prompt
                      </label>
                      <textarea
                        id={`scene-video-prompt-${index}`}
                        className="prompt-clip"
                        rows={8}
                        value={composeSceneVideoPrompt(index, scenes, characters)}
                        placeholder="Built from this scene. Edit to override."
                        onChange={(e) => patch({ videoPrompt: e.target.value })}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn"
                      disabled={dropDisabled}
                      onClick={() => dropScene(index)}
                    >
                      Drop
                    </button>
                    {dropDisabled ? <p className="hint">Need at least two scenes.</p> : null}
                    </div>
                  </details>
                </div>
              );
            })}
            <div className="generate-bar">
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  writing ||
                  sheetBusy ||
                  assetStoring ||
                  characters.length === 0 ||
                  characters.some((c) => !c.stillUrl) ||
                  scenes.some((s) => !shotReady(s))
                }
                onClick={looksGood}
              >
                Looks good — generate clips
              </button>
              <p className="hint">
                Scene 1 from character images. Later scenes: landing still of N → start of N+1. Next create
                ~65s after the previous POST even if that clip is still generating. Same seed. Max beat{" "}
                {planMaxSec}s. Total about {formatStoryLength(totalSec)}.
              </p>
            </div>
          </aside>
        </div>
      ) : null}

      {gate === "clips" ? (
        <>
          <div className="story-queue job-well" aria-live="polite" aria-atomic="true">
            {generatingIndex >= 0 || merging ? (
              <div className="job-run">
                <span className="spin" aria-hidden="true" />
                <p className="job-line sr-status">{queueLive()}</p>
              </div>
            ) : (
              <p className="sr-status">{queueLive()}</p>
            )}
            {failedIndex >= 0 && generatingIndex < 0 && !merging && !mergedUrl ? (
              <div className="story-queue-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => resumeFrom(failedIndex)}
                >
                  Resume from scene {failedIndex + 1}
                </button>
              </div>
            ) : null}
            {!mergedUrl ? (
              <p className="hint">Free accounts: about one create every 65s. Earlier clips can keep generating.{queueNote ? ` ${queueNote}` : ""}</p>
            ) : null}
          </div>

          <div className="story-clips">
            {clips.map((clip, index) => {
              const scene = scenes[index];
              const busyRow = clip.status === "generating";
              return (
                <div key={`clip-${index}`}>
                  {index > 0 ? (
                    <p className="handoff">
                      End of {index} is the start of {index + 1} — same picture.
                    </p>
                  ) : (
                    <p className="handoff">
                      {characters.some((c) => c.stillUrl)
                        ? "Scene 1 starts from the cast spritesheets and ends on that scene’s still."
                        : "Scene 1 needs character spritesheets."}
                    </p>
                  )}
                  {scene ? (
                    <SceneBeatPair
                      index={index}
                      scene={scene}
                      scenes={scenes}
                      characters={characters}
                      stillBusy={stillBusy}
                      endError={stillErrors[index]}
                      onZoom={openZoom}
                      onRegenEnd={(i) => void regenSceneStill(i)}
                    />
                  ) : null}
                  <div className="clip-row">
                    <div className="clip-head">
                      <p>
                        <strong>
                          {index + 1} {scene?.title ?? ""} · {scene?.duration_sec ?? 0}s
                        </strong>
                      </p>
                      <p className="block clip-status">
                        {statusLabel(clip.status)}
                        {clip.status === "generating" && typeof clip.progress === "number"
                          ? `  ${clip.progress}%`
                          : ""}
                      </p>
                    </div>
                    <div className="clip-body">
                      <div>
                        {clip.status === "ready" && clip.url ? (
                          <video className="player" src={clip.url} controls playsInline />
                        ) : clip.status === "generating" ? (
                          <div className="job-well">
                            <div className="job-run">
                              <span className="spin" aria-hidden="true" />
                              <p>In progress</p>
                            </div>
                          </div>
                        ) : clip.status === "failed" ? (
                          <p className="form-error">{clip.error ?? "Generation failed."}</p>
                        ) : clip.status === "queued" ? (
                          <div className="job-well">
                            <p>Next create after the free-tier gap.</p>
                          </div>
                        ) : (
                          <div className="job-well">
                            <p>
                              {index === 0
                                ? "Waiting to start."
                                : `Waits for scene ${index}. Then ~1 min free-tier gap before create.`}
                            </p>
                          </div>
                        )}
                        {clip.videoId ? <p className="mono">video_id: {clip.videoId}</p> : null}
                        {scene ? (
                          <div className="row clip-prompt">
                            <SceneDurationPicker
                              index={index}
                              scene={scene}
                              model={model}
                              durationOptions={durationOptions}
                              v20Resolution={v20Resolution}
                              fps={fps}
                              planMaxSec={planMaxSec}
                              filmMaxFrames={filmMaxFrames}
                              namePrefix="clip"
                              onPatch={(partial) => patchScene(index, partial)}
                            />
                            <label className="field" htmlFor={`clip-video-prompt-${index}`}>
                              Prompt
                            </label>
                            <textarea
                              id={`clip-video-prompt-${index}`}
                              className="prompt-clip"
                              rows={10}
                              value={composeSceneVideoPrompt(index, scenes, characters)}
                              placeholder="This is the clip prompt."
                              onChange={(e) => patchScene(index, { videoPrompt: e.target.value })}
                            />
                            <p className="hint">
                              This is the prompt that will be sent. Edit it before regenerate. Duration
                              follows {model === MODEL_FLASH ? "Flash" : `${v20Resolution} · ${fps} fps`}{" "}
                              (max {planMaxSec}s). Only this clip is remade. Later clips stay.
                            </p>
                          </div>
                        ) : null}
                        <div className="clip-actions">
                          {clip.status === "ready" && clip.url ? (
                            <>
                              <a className="btn" href={clip.url} download target="_blank" rel="noopener noreferrer">
                                Download
                              </a>
                              <button
                                type="button"
                                className="btn"
                                disabled={merging || busyRow}
                                onClick={() => regenScene(index)}
                              >
                                Regenerate this scene
                              </button>
                            </>
                          ) : null}
                          {clip.status === "failed" ? (
                            <button
                              type="button"
                              className="btn"
                              disabled={generatingIndex >= 0 || merging}
                              onClick={() => resumeFrom(index)}
                            >
                              Retry this scene
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div className="clip-side">
                        {clip.status === "ready" && clip.lastFrameSrc ? (
                          <>
                            <p className="hint">Decoded last frame</p>
                            <ZoomableImage src={clip.lastFrameSrc} alt={`Scene ${index + 1} decoded last frame`} onZoom={openZoom} />
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="merge-bar">
              {mergedUrl ? (
                <>
                  <video
                    ref={mergedPlayerRef}
                    className="player"
                    src={mergedUrl}
                    controls
                    playsInline
                    tabIndex={-1}
                  />
                  <p>
                    <a href={mergedUrl} download target="_blank" rel="noopener noreferrer">
                      Download MP4
                    </a>
                  </p>
                </>
              ) : (
                <>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={mergeChecked}
                      disabled={!allReady || merging}
                      onChange={(e) => setMergeChecked(e.target.checked)}
                    />
                    <span>These clips are correct</span>
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!allReady || !mergeChecked || merging}
                    onClick={() => void mergeClips()}
                  >
                    {merging ? "Merging…" : "Merge clips"}
                  </button>
                  <p className="hint">No speech, no captions. Concat only.</p>
                  {mergeError ? <p className="form-error">{mergeError}</p> : null}
                </>
              )}
            </div>
          </div>
        </>
      ) : null}
      {zoom ? <ZoomLightbox src={zoom.src} alt={zoom.alt} onClose={closeZoom} /> : null}
    </div>
  );
});
