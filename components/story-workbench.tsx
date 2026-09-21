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
  DEFAULT_FRAME_RATE,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_V20_RESOLUTION,
  FLASH_ASPECT_RATIOS,
  FLASH_AUDIO_MAX,
  FLASH_IMAGE_MAX,
  FLASH_STORY_DURATION_OPTIONS,
  FLASH_STORY_SECONDS,
  formatStoryLength,
  IMAGE_MODELS,
  isImageModelId,
  maxFramesForPixels,
  MODEL_FLASH,
  MODEL_V20,
  snapStoryDuration,
  STORY_BOARD_AUDIO_MAX,
  STORY_BOARD_IMAGE_MAX,
  STORY_CHARACTER_MAX,
  STORY_COMPOSE_AUDIO_MAX,
  STORY_COMPOSE_IMAGE_MAX,
  STORY_CREATE_GAP_MS,
  STORY_DEFAULT_MINUTES,
  STORY_MINUTES_OPTIONS,
  STORY_SCENE_HARD_MAX,
  STORY_SCENE_MIN,
  STORY_V20_NEGATIVE_PROMPT,
  clampStoryMinutes,
  flashStorySceneCount,
  framesForDuration,
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
import { FLASH_STORY_NEGATIVE_LINE, formatStoryShot, isComposedShotPrompt, isComposedStillPrompt, applyShotDurationLine, sceneBridgeStillPrompt, sceneStartStillPrompt, sceneTimeRange, sceneUsesSheetI2V, sceneIsI2V, sceneNeedsGeneratedStart, isShotMode, dialogueTurnsFromUnknown, serializeDialogueJson, normalizeDialogueJson, type DialogueTurn, type ShotMode } from "@/lib/agnes/story-format";
import {
  isPublicHttpsUrl,
  type CreateRequest,
  type FlashAspectRatio,
  type ModelId,
  type V20FrameSizeId,
} from "@/lib/agnes/types";
import { ClipTimeline } from "@/components/clip-timeline";
import { PromptComposer, type PromptChipItem } from "@/components/prompt-media-chips";
import { humanizeAgnesDetail, isAgnesCreateQueueFull } from "@/lib/agnes/errors";
import { abortServerJob, openJobSse } from "@/lib/client/job-sse";
import { localMediaUrl } from "@/lib/client/media-cache";

const IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";
const AUDIO_ACCEPT = "audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav,.m4a,.aac,.mp4";
/** Wait from a CREATE queue-full reject; do not add STORY_CREATE_GAP_MS on top. */
const STORY_CREATE_QUEUE_FULL_WAIT_MS = 60_000;
const STORY_CREATE_QUEUE_FULL_ATTEMPTS = 3;
const PIPELINE = ["input", "storyboard", "clips", "merge"] as const;
type Gate = "input" | "storyboard" | "clips";
type PipelineStep = (typeof PIPELINE)[number];
type SourceMode = "topic" | "story";
type ClipStatus = "waiting" | "queued" | "generating" | "ready" | "failed";

type StillRef = { id: string; url: string; prompt?: string };

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
  stillPrompt: string;
  startPrompt: string;
  bridgeId: string;
  bridgeUrl: string;
  startId: string;
  startUrl: string;
  imageModel: ImageModelId;
  shotMode: ShotMode;
  i2vRefs: StillRef[];
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
type StudioMode = "compose" | "board" | "playback";
type BeatFocus = "wait" | "cast" | "scene";

type StoryImageAsset = {
  key: string;
  id: string;
  url: string;
  name: string;
  selected: boolean;
  kind: ImageKind;
  characterName: string;
  sceneIndex: number | null;
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
  mergeOrder?: number[];
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
        sceneIndex:
          rec.sceneIndex === null || rec.sceneIndex === undefined
            ? null
            : typeof rec.sceneIndex === "number" && Number.isInteger(rec.sceneIndex) && rec.sceneIndex >= 0
              ? rec.sceneIndex
              : null,
      });
      if (out.length >= STORY_BOARD_IMAGE_MAX) break;
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
      sceneIndex: null,
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
    if (out.length >= STORY_BOARD_AUDIO_MAX) break;
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

function selectedImageUrls(images: StoryImageAsset[], sceneIndex: number): string[] {
  return images
    .filter((img) => img.selected && (img.sceneIndex === null || img.sceneIndex === sceneIndex))
    .map((img) => img.url);
}

function selectedAudioUrls(audios: StoryAudioAsset[], sceneIndex: number): string[] {
  return audios
    .filter((a) => a.selected && (a.sceneIndex === null || a.sceneIndex === sceneIndex))
    .map((a) => a.url);
}

function identityOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function isPermutation(order: unknown, n: number): order is number[] {
  if (!Array.isArray(order) || order.length !== n) return false;
  const seen = new Set<number>();
  for (const value of order) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= n || seen.has(value)) {
      return false;
    }
    seen.add(value);
  }
  return true;
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
      return humanizeAgnesDetail((body as { detail: string }).detail);
    }
  } catch {
    /* ignore malformed error bodies */
  }
  return "Agnes is unavailable or the job was not found.";
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
  if (url.startsWith("agnes-media:")) return `/api/media/${url.slice("agnes-media:".length)}`;
  if (id) return `/api/media/${id}`;
  if (isPublicHttpsUrl(url)) return url;
  return url;
}

function StoryCachedImg({
  src,
  alt,
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const [href, setHref] = useState("");
  const [loadedSrc, setLoadedSrc] = useState("");
  useEffect(() => {
    if (!src) return;
    let live = true;
    let blobUrl = "";
    void localMediaUrl(src).then((next) => {
      if (!live) {
        if (next.startsWith("blob:")) URL.revokeObjectURL(next);
        return;
      }
      blobUrl = next.startsWith("blob:") ? next : "";
      setHref(next);
      setLoadedSrc(src);
    });
    return () => {
      live = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src]);
  const shown = src && loadedSrc === src ? href : "";
  if (!src || !shown) return className ? <span className={className} /> : null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={shown} alt={alt ?? ""} className={className} />
  );
}

function storyPromptChips(
  imageAssets: StoryImageAsset[],
  audioAssets: StoryAudioAsset[],
  characters: CharacterDraft[],
  scenes: SceneDraft[],
): { images: PromptChipItem[]; audios: PromptChipItem[] } {
  const images: PromptChipItem[] = [];
  const seen = new Set<string>();
  const addImage = (key: string, url: string, label: string) => {
    const u = url.trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    images.push({ key, url: u, label: label.trim() || `Image${images.length + 1}`, storing: false });
  };
  for (const img of imageAssets) addImage(img.key || img.id, img.url, fileStem(img.name) || img.name);
  characters.forEach((ch, i) => {
    addImage(`char-${i}`, mediaPreview(ch.stillId, ch.stillUrl) || ch.stillUrl, `${ch.name} sheet`);
  });
  scenes.forEach((s, i) => {
    addImage(`start-${i}`, mediaPreview(s.startId, s.startUrl) || s.startUrl, `S${i + 1} start`);
    addImage(`still-${i}`, mediaPreview(s.bridgeId, s.bridgeUrl) || s.bridgeUrl, `S${i + 1} end`);
  });
  const audios: PromptChipItem[] = [];
  const seenA = new Set<string>();
  for (const a of audioAssets) {
    const u = a.url.trim();
    if (!u || seenA.has(u)) continue;
    seenA.add(u);
    audios.push({
      key: a.key || a.id,
      url: u,
      label: fileStem(a.name) || a.name || `Audio${audios.length + 1}`,
      storing: false,
    });
  }
  return { images, audios };
}

function generatedImageAliases(
  characters: CharacterDraft[],
  scenes: SceneDraft[],
): { url: string; name: string; prompt: string; regen: { kind: "sheet" | "start" | "end"; index: number } }[] {
  const out: { url: string; name: string; prompt: string; regen: { kind: "sheet" | "start" | "end"; index: number } }[] = [];
  const seen = new Set<string>();
  const add = (url: string, name: string, prompt: string, regen: { kind: "sheet" | "start" | "end"; index: number }) => {
    const u = url.trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({ url: u, name, prompt, regen });
  };
  characters.forEach((ch, i) => {
    add(mediaPreview(ch.stillId, ch.stillUrl) || ch.stillUrl, `${ch.name} sheet`, ch.generatePrompt || ch.sheet_prompt, {
      kind: "sheet",
      index: i,
    });
  });
  scenes.forEach((s, i) => {
    add(mediaPreview(s.startId, s.startUrl) || s.startUrl, `S${i + 1} start`, s.startPrompt, { kind: "start", index: i });
    add(mediaPreview(s.bridgeId, s.bridgeUrl) || s.bridgeUrl, `S${i + 1} end`, s.stillPrompt, { kind: "end", index: i });
    (s.i2vRefs ?? []).forEach((ref, ri) => {
      add(mediaPreview(ref.id, ref.url) || ref.url, `S${i + 1} ref ${ri + 1}`, ref.prompt ?? "", { kind: "start", index: i });
    });
  });
  return out;
}

function libraryImageTotal(
  uploads: StoryImageAsset[],
  characters: CharacterDraft[],
  scenes: SceneDraft[],
): number {
  const urls = new Set<string>();
  for (const img of uploads) {
    if (img.url) urls.add(img.url);
  }
  for (const item of generatedImageAliases(characters, scenes)) urls.add(item.url);
  return urls.size;
}

function emptySceneDraft(style: string, cast: string[]): SceneDraft {
  return {
    title: "Untitled",
    duration_sec: FLASH_STORY_SECONDS,
    durationTouched: true,
    cast,
    setting: "",
    subject: "",
    action: "",
    camera_movement: "",
    lighting: "",
    style,
    dialogue: "{}",
    videoPrompt: "",
    stillPrompt: "",
    startPrompt: "",
    bridgeId: "",
    bridgeUrl: "",
    startId: "",
    startUrl: "",
    imageModel: DEFAULT_IMAGE_MODEL,
    shotMode: "keyframe",
    i2vRefs: [],
  };
}

function parseStillRefs(value: unknown): StillRef[] {
  if (!Array.isArray(value)) return [];
  const out: StillRef[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!url) continue;
    out.push({
      id: typeof rec.id === "string" ? rec.id : "",
      url,
      prompt: typeof rec.prompt === "string" ? rec.prompt : undefined,
    });
  }
  return out;
}

function stampShotModes(scenes: SceneDraft[]): SceneDraft[] {
  return scenes.map((scene, i) => ({
    ...scene,
    shotMode: isShotMode(scene.shotMode)
      ? scene.shotMode
      : sceneUsesSheetI2V(scenes, i)
        ? "i2v"
        : "keyframe",
    i2vRefs: Array.isArray(scene.i2vRefs) ? scene.i2vRefs : [],
  }));
}

function insertPositionOptions(scenes: SceneDraft[]): { value: string; label: string }[] {
  if (scenes.length === 0) return [{ value: "0", label: "At end" }];
  const opts: { value: string; label: string }[] = [
    { value: "0", label: `Before S1 · ${scenes[0].title.trim() || "Untitled"}` },
  ];
  for (let i = 0; i < scenes.length - 1; i += 1) {
    opts.push({
      value: String(i + 1),
      label: `After S${i + 1} · ${scenes[i].title.trim() || "Untitled"}`,
    });
  }
  opts.push({ value: String(scenes.length), label: "At end" });
  return opts;
}

function shiftSceneIndex(value: number | null, at: number, delta: number): number | null {
  if (value === null) return null;
  if (delta > 0 && value >= at) return value + delta;
  if (delta < 0 && value === at) return null;
  if (delta < 0 && value > at) return value + delta;
  return value;
}

function SvgIco({ path, filled = false }: { path: string; filled?: boolean }) {
  return (
    <svg className="story-ico" width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d={path} />
    </svg>
  );
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
    i2vRefs?: string[];
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
  const { sheets, i2vRefs, startFrame, endFrame, seed, width, height, fps, maxFrames, flashAspect, selectedImages, selectedAudios } =
    opts;
  if (model === MODEL_V20) {
    const refs: string[] = [];
    if (startFrame && endFrame) {
      pushUnique(refs, startFrame, V20_KEYFRAME_MAX);
      pushUnique(refs, endFrame, V20_KEYFRAME_MAX);
    } else {
      for (const url of i2vRefs ?? []) pushUnique(refs, url, V20_I2V_MAX);
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
  for (const url of i2vRefs ?? []) pushUnique(images, url, FLASH_IMAGE_MAX);
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

function uniqueSceneIndexes(items: { index: number }[]): number[] {
  return [...new Set(items.map((item) => item.index))];
}

function isPhoneStory(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 899px)").matches;
}

type MobilePane = "canvas" | "library" | "details";

function pipelineCurrent(gate: Gate, clips: Clip[], mergedUrl: string | null): PipelineStep {
  if (gate === "input") return "input";
  if (gate === "storyboard") return "storyboard";
  if (mergedUrl || (clips.length > 0 && clips.every((c) => c.status === "ready"))) return "merge";
  return "clips";
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
      <StoryCachedImg src={src} alt={alt} />
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

function composeStillPrompt(
  scene: SceneDraft,
  characters: CharacterDraft[],
  filmStyle: string,
  story: string,
): string {
  const custom = scene.stillPrompt.trim();
  if (custom && isComposedStillPrompt(custom)) return custom;
  const locks = sceneCastForStill(scene, characters);
  const base = sceneBridgeStillPrompt(scene, locks, filmStyle, story);
  if (custom) return `${base} Director note: ${custom}`;
  return base;
}

function composeStartStillPrompt(
  scene: SceneDraft,
  characters: CharacterDraft[],
  filmStyle: string,
  story: string,
): string {
  const custom = scene.startPrompt.trim();
  if (custom && isComposedStillPrompt(custom)) return custom;
  const locks = sceneCastForStill(scene, characters);
  const base = sceneStartStillPrompt(scene, locks, filmStyle, story);
  if (custom) return `${base} Director note: ${custom}`;
  return base;
}

function sceneCastLocks(scene: SceneDraft, roster: CharacterDraft[]): { name: string; appearance: string }[] {
  const wanted = ((scene.cast ?? []).length > 0 ? scene.cast : roster.map((c) => c.name)).map((n) =>
    n.toLowerCase(),
  );
  const present = roster.filter((c) => c.stillUrl && wanted.includes(c.name.toLowerCase()));
  const used = present.length > 0 ? present : roster.filter((c) => c.stillUrl);
  return used.map((c) => ({ name: c.name, appearance: c.appearance }));
}

function sceneCastForStill(scene: SceneDraft, roster: CharacterDraft[]): { name: string; appearance: string }[] {
  const locks = sceneCastLocks(scene, roster);
  if (locks.length > 0) return locks;
  const wanted = ((scene.cast ?? []).length > 0 ? scene.cast : roster.map((c) => c.name)).map((n) =>
    n.toLowerCase(),
  );
  const used = roster.filter((c) => wanted.includes(c.name.toLowerCase()));
  return (used.length > 0 ? used : roster).map((c) => ({ name: c.name, appearance: c.appearance }));
}

function stillJudgeSource(scene: SceneDraft, kind: "start" | "end" = "end"): string {
  const url = kind === "start" ? scene.startUrl : scene.bridgeUrl;
  const id = kind === "start" ? scene.startId : scene.bridgeId;
  if (isPublicHttpsUrl(url)) return url;
  if (url.startsWith("agnes-media:")) return url;
  if (id) return `agnes-media:${id}`;
  return url;
}

function stillFailCopy(reasons: string[]): string {
  const text = reasons.map((r) => r.trim()).filter(Boolean).join(" ");
  if (/could not judge/i.test(text)) {
    return "Could not judge this still. The picture is kept. Try Check & fix stills or regenerate.";
  }
  return text
    ? `Gold standard failed after retries: ${text} Edit the still prompt and regenerate.`
    : "Gold standard failed after retries. Edit the still prompt and regenerate.";
}

function parseStillCheck(body: unknown): { pass: boolean; reasons: string[]; judged: boolean } | null {
  if (typeof body !== "object" || body === null) return null;
  const rec = body as Record<string, unknown>;
  const raw = rec.check && typeof rec.check === "object" ? (rec.check as Record<string, unknown>) : rec;
  if (typeof raw.pass !== "boolean") return null;
  const reasons: string[] = [];
  if (Array.isArray(raw.reasons)) {
    for (const item of raw.reasons) {
      if (typeof item === "string" && item.trim()) reasons.push(item.trim());
    }
  }
  const judged = raw.judged === true;
  return { pass: raw.pass, reasons, judged };
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
  const sheetI2V = sceneIsI2V(scenes, index);
  const needsStart = sceneNeedsGeneratedStart(scenes, index);
  return formatStoryShot(index, durations, scene, sceneCastLocks(scene, characters), {
    hasStart: !sheetI2V && (index > 0 || needsStart || Boolean(scene.startUrl)),
    hasEnd: !sheetI2V,
    startIsGenerated: needsStart,
    prevEnd: prev ? { setting: prev.setting, subject: prev.subject, action: prev.action } : undefined,
    extraPrompt: custom,
  });
}

function SceneDurationPicker({
  id,
  scene,
  onPatch,
}: {
  id: string;
  scene: SceneDraft;
  onPatch: (partial: Partial<SceneDraft>) => void;
}) {
  return (
    <>
      <label className="story-field" htmlFor={id}>
        Duration
      </label>
      <select
        id={id}
        value={scene.duration_sec}
        onChange={(e) => onPatch({ duration_sec: Number(e.target.value), durationTouched: true })}
      >
        {FLASH_STORY_DURATION_OPTIONS.map((opt) => (
          <option key={opt} value={opt}>
            {opt}s
          </option>
        ))}
      </select>
      <p className="story-hint">Default {FLASH_STORY_SECONDS}s. Flash allows {FLASH_STORY_DURATION_OPTIONS[0]}–{FLASH_STORY_SECONDS}s.</p>
    </>
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
    <>
      <label className="story-field" htmlFor={id}>
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
      <p className="story-hint">
        Default is {IMAGE_MODELS.find((m) => m.id === DEFAULT_IMAGE_MODEL)?.label}. All three are
        free.
      </p>
    </>
  );
}

function SceneBeatPair({
  index,
  scene,
  scenes,
  characters,
  filmStyle,
  story,
  stillBusy,
  endError,
  startError,
  onZoom,
  onRegenEnd,
  onRegenStart,
  onStillPrompt,
  onStartPrompt,
  mentionImages,
  mentionAudios,
}: {
  index: number;
  scene: SceneDraft;
  scenes: SceneDraft[];
  characters: CharacterDraft[];
  filmStyle: string;
  story: string;
  stillBusy: boolean;
  endError?: string;
  startError?: string;
  onZoom: (src: string, alt: string) => void;
  onRegenEnd: (index: number) => void;
  onRegenStart: (index: number) => void;
  onStillPrompt: (index: number, value: string) => void;
  onStartPrompt: (index: number, value: string) => void;
  mentionImages: PromptChipItem[];
  mentionAudios: PromptChipItem[];
}) {
  const wanted = (scene.cast ?? []).map((n) => n.toLowerCase());
  const castSheets = (wanted.length > 0
    ? characters.filter((c) => wanted.includes(c.name.toLowerCase()))
    : characters
  ).filter((c) => c.stillUrl || c.stillId);
  const sheetI2V = sceneIsI2V(scenes, index);
  const needsStart = sceneNeedsGeneratedStart(scenes, index);
  const prev = index > 0 ? scenes[index - 1] : null;
  const i2vRefs = scene.i2vRefs ?? [];
  const generatedStartSrc =
    needsStart && (scene.startId || scene.startUrl) ? mediaPreview(scene.startId, scene.startUrl) : "";
  const startSrc =
    !sheetI2V && !needsStart && prev && (prev.bridgeId || prev.bridgeUrl)
      ? mediaPreview(prev.bridgeId, prev.bridgeUrl)
      : generatedStartSrc;
  const endSrc = scene.bridgeId || scene.bridgeUrl ? mediaPreview(scene.bridgeId, scene.bridgeUrl) : "";
  const nextIndex = index + 2;
  const hasNext = index + 1 < scenes.length;
  const showI2vRefs = sheetI2V && i2vRefs.length > 0;
  const showSheetsAtStart = sheetI2V && !showI2vRefs;

  return (
    <div className="scene-beats">
      <div className="scene-beat">
        <p className="field">Start</p>
        {showI2vRefs ? (
          <div className="scene-beat-cast">
            {i2vRefs.map((ref, ri) => (
              <ZoomableImage
                key={ref.id || ref.url || `ref-${ri}`}
                src={mediaPreview(ref.id, ref.url)}
                alt={`Scene ${index + 1} ref ${ri + 1}`}
                onZoom={onZoom}
              />
            ))}
          </div>
        ) : showSheetsAtStart ? (
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
            alt={
              needsStart
                ? `Scene ${index + 1} opening still`
                : `Scene ${index} end still (start of scene ${index + 1})`
            }
            onZoom={onZoom}
          />
        ) : (
          <p className="hint">
            {stillBusy
              ? needsStart
                ? "Drawing opening still…"
                : "Waiting for previous end still…"
              : needsStart
                ? "Opening still not drawn yet."
                : "Previous end still not drawn yet."}
          </p>
        )}
        {needsStart && startError ? <p className="form-error">{startError}</p> : null}
        <p className="hint">
          {sheetI2V
            ? showI2vRefs
              ? "Image-to-video from generated or uploaded refs. No end still."
              : "Image-to-video from character sheets. No generated start still."
            : needsStart
              ? "Previous clip was image-to-video (no end still). This opening still is generated."
              : `Same picture as end of scene ${index}`}
        </p>
        {needsStart ? (
          <>
            <label className="field" htmlFor={`scene-start-prompt-${index}`}>
              Start still prompt
            </label>
            <PromptComposer
              id={`scene-start-prompt-${index}`}
              className="is-clip"
              showChips={false}
              value={composeStartStillPrompt(scene, characters, filmStyle, story)}
              images={mentionImages}
              audios={mentionAudios}
              onChange={(next) => onStartPrompt(index, next)}
            />
            <button
              type="button"
              className="btn btn-ghost"
              disabled={stillBusy}
              onClick={() => onRegenStart(index)}
            >
              {stillBusy && !generatedStartSrc ? "Drawing…" : "Regenerate start still"}
            </button>
          </>
        ) : null}
      </div>
      <div className="scene-beat">
        <p className="field">End</p>
        {sheetI2V ? (
          <p className="hint">No end still. This clip is image-to-video.</p>
        ) : endSrc ? (
          <ZoomableImage
            src={endSrc}
            alt={`Scene ${index + 1} end still${hasNext ? ` (start of scene ${nextIndex})` : ""}`}
            onZoom={onZoom}
          />
        ) : (
          <p className="hint">{stillBusy ? "Drawing end still…" : "End still not drawn yet."}</p>
        )}
        {!sheetI2V && endError ? <p className="form-error">{endError}</p> : null}
        {sheetI2V ? null : (
          <>
            <p className="hint">{hasNext ? `Start of scene ${nextIndex}` : "Last still of this clip"}</p>
            <label className="field" htmlFor={`scene-still-prompt-${index}`}>
              End still prompt
            </label>
            <PromptComposer
              id={`scene-still-prompt-${index}`}
              className="is-clip"
              showChips={false}
              value={composeStillPrompt(scene, characters, filmStyle, story)}
              images={mentionImages}
              audios={mentionAudios}
              onChange={(next) => onStillPrompt(index, next)}
            />
            <p className="hint">
              Gold standard: one live movie frame, each named character once, no spritesheet or duplicates. Failed stills
              redraw automatically.
            </p>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={stillBusy}
              onClick={() => onRegenEnd(index)}
            >
              {stillBusy && !endSrc ? "Drawing…" : "Regenerate end still"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FlashAspectPills({
  name,
  value,
  onChange,
}: {
  name: string;
  value: FlashAspectRatio;
  onChange: (next: FlashAspectRatio) => void;
}) {
  return (
    <div className="story-pills" role="radiogroup" aria-label="Aspect">
      {FLASH_ASPECT_RATIOS.map((opt) => (
        <button
          key={opt}
          type="button"
          className={`story-pill${value === opt ? " is-on" : ""}`}
          aria-pressed={value === opt}
          onClick={() => onChange(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function DialogueTurnsEditor({
  turns,
  onChange,
}: {
  turns: DialogueTurn[];
  onChange: (next: DialogueTurn[]) => void;
}) {
  return (
    <div>
      <p className="story-field">Dialogue</p>
      {turns.length === 0 ? <p className="story-hint">No lines. Add who-says-what.</p> : null}
      {turns.map((turn, i) => (
        <div className="story-dlg-row" key={`dlg-${i}`}>
          <input
            type="text"
            value={turn.speaker}
            aria-label={`Speaker ${i + 1}`}
            placeholder="Who"
            onChange={(e) => {
              const next = turns.slice();
              next[i] = { ...turn, speaker: e.target.value };
              onChange(next);
            }}
          />
          <input
            type="text"
            value={turn.line}
            aria-label={`Line ${i + 1}`}
            placeholder="Says what"
            onChange={(e) => {
              const next = turns.slice();
              next[i] = { ...turn, line: e.target.value };
              onChange(next);
            }}
          />
          <button
            type="button"
            className="story-tiny"
            aria-label={`Remove line ${i + 1}`}
            onClick={() => onChange(turns.filter((_, j) => j !== i))}
          >
            −
          </button>
        </div>
      ))}
      <button
        type="button"
        className="story-add-line"
        onClick={() => onChange([...turns, { speaker: "", line: "" }])}
      >
        Add line
      </button>
    </div>
  );
}

type AddSceneForm = {
  title: string;
  duration_sec: number;
  setting: string;
  subject: string;
  action: string;
  position: string;
  shotMode: ShotMode;
  imageModel: ImageModelId;
  i2vRefs: StillRef[];
  startId: string;
  startUrl: string;
  startPrompt: string;
  bridgeId: string;
  bridgeUrl: string;
  stillPrompt: string;
};

type AddBeatErrorField = "setting" | "subject" | "action" | "shot" | "stills";

function ModalStillThumb({
  src,
  label,
  onRemove,
}: {
  src: string;
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="story-ref-thumb">
      <StoryCachedImg src={src} alt="" />
      <span>{label}</span>
      <button type="button" className="story-ref-x" aria-label={`Remove ${label}`} onClick={onRemove}>
        ×
      </button>
    </span>
  );
}

function AddSceneModal({
  kind,
  scenes,
  ratio,
  onClose,
  onAdd,
}: {
  kind: "scene" | "clip";
  scenes: SceneDraft[];
  ratio: FlashAspectRatio;
  onClose: () => void;
  onAdd: (form: AddSceneForm) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState("Untitled");
  const [duration, setDuration] = useState(FLASH_STORY_SECONDS);
  const [setting, setSetting] = useState("");
  const [subject, setSubject] = useState("");
  const [action, setAction] = useState("");
  const [position, setPosition] = useState(String(scenes.length));
  const [shotMode, setShotMode] = useState<ShotMode | "">("");
  const [imageModel, setImageModel] = useState<ImageModelId>(DEFAULT_IMAGE_MODEL);
  const [i2vPrompt, setI2vPrompt] = useState("");
  const [i2vRefs, setI2vRefs] = useState<StillRef[]>([]);
  const [kfStartPrompt, setKfStartPrompt] = useState("");
  const [kfEndPrompt, setKfEndPrompt] = useState("");
  const [kfStart, setKfStart] = useState<StillRef | null>(null);
  const [kfEnd, setKfEnd] = useState<StillRef | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ field: AddBeatErrorField; message: string }[]>([]);

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
  }, [onClose]);

  const positions = insertPositionOptions(scenes);
  const stillsReady =
    shotMode === "i2v" ? i2vRefs.length > 0 : shotMode === "keyframe" ? Boolean(kfStart && kfEnd) : false;
  const canSubmit =
    Boolean(setting.trim() && subject.trim() && action.trim() && shotMode && stillsReady) && !busy;
  const ids: Record<AddBeatErrorField, string> = {
    setting: "add-beat-setting",
    subject: "add-beat-subject",
    action: "add-beat-action",
    shot: "add-beat-shot",
    stills: shotMode === "i2v" ? "add-beat-i2v-prompt" : "add-beat-kf-start",
  };

  async function generateStill(prompt: string): Promise<StillRef | null> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setGenError("Enter a prompt, then generate.");
      return null;
    }
    setGenError(null);
    try {
      const res = await fetch("/api/scene-still", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          ratio,
          model: imageModel,
          validate: false,
        }),
      });
      if (!res.ok) {
        setGenError(await readDetail(res));
        return null;
      }
      const body: unknown = await res.json();
      const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
      const url = rec && typeof rec.url === "string" ? rec.url : "";
      const id = rec && typeof rec.id === "string" ? rec.id : "";
      if (!url) {
        setGenError("That still did not return an image.");
        return null;
      }
      return { id, url, prompt: trimmed };
    } catch {
      setGenError("Could not draw this still.");
      return null;
    }
  }

  async function uploadStill(file: File | undefined): Promise<StillRef | null> {
    if (!file) return null;
    setGenError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/videos/media", { method: "POST", body: fd });
      if (!res.ok) {
        setGenError(await readDetail(res));
        return null;
      }
      const body: unknown = await res.json();
      const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
      const url = rec && typeof rec.url === "string" ? rec.url : "";
      const id = rec && typeof rec.id === "string" ? rec.id : "";
      if (!url) {
        setGenError("Could not store this file.");
        return null;
      }
      return { id, url, prompt: file.name };
    } catch {
      setGenError("Could not store this file.");
      return null;
    }
  }

  function submit() {
    const next: { field: AddBeatErrorField; message: string }[] = [];
    if (!setting.trim()) next.push({ field: "setting", message: "Enter a setting." });
    if (!subject.trim()) next.push({ field: "subject", message: "Enter a subject." });
    if (!action.trim()) next.push({ field: "action", message: "Enter an action." });
    if (!isShotMode(shotMode)) next.push({ field: "shot", message: "Choose Image to video or Keyframe to video." });
    if (isShotMode(shotMode) && !stillsReady) {
      next.push({
        field: "stills",
        message: shotMode === "i2v" ? "Generate or upload at least one ref." : "Need a start still and an end still.",
      });
    }
    if (next.length > 0) {
      setErrors(next);
      queueMicrotask(() => summaryRef.current?.focus());
      return;
    }
    if (!isShotMode(shotMode)) return;
    onAdd({
      title,
      duration_sec: duration,
      setting,
      subject,
      action,
      position,
      shotMode,
      imageModel,
      i2vRefs,
      startId: kfStart?.id ?? "",
      startUrl: kfStart?.url ?? "",
      startPrompt: kfStartPrompt,
      bridgeId: kfEnd?.id ?? "",
      bridgeUrl: kfEnd?.url ?? "",
      stillPrompt: kfEndPrompt,
    });
  }

  return (
    <dialog
      ref={ref}
      className="story-modal"
      aria-labelledby="add-beat-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="box story-modal-panel"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h3 id="add-beat-title" style={{ margin: "0 0 10px" }}>
          {kind === "clip" ? "Add clip" : "Add scene"}
        </h3>
        {errors.length > 0 ? (
          <div
            ref={summaryRef}
            className="story-error-summary"
            role="alert"
            tabIndex={-1}
            aria-labelledby="add-beat-errors"
          >
            <p id="add-beat-errors" style={{ margin: "0 0 6px", fontWeight: 700 }}>
              There is a problem
            </p>
            {errors.map((err) => (
              <a key={err.field} href={`#${ids[err.field]}`}>
                {err.message}
              </a>
            ))}
          </div>
        ) : null}
        <label className="story-field" htmlFor="add-beat-name">
          Title
        </label>
        <input id="add-beat-name" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label className="story-field" htmlFor="add-beat-dur">
          Duration
        </label>
        <select
          id="add-beat-dur"
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
        >
          {FLASH_STORY_DURATION_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}s
            </option>
          ))}
        </select>
        <label className="story-field" htmlFor="add-beat-setting">
          Setting{" "}
          <abbr className="req" title="required">
            *
          </abbr>
        </label>
        <textarea
          id="add-beat-setting"
          value={setting}
          aria-invalid={errors.some((e) => e.field === "setting") ? true : undefined}
          onChange={(e) => setSetting(e.target.value)}
        />
        {errors.some((e) => e.field === "setting") ? (
          <p className="story-field-error">Enter a setting.</p>
        ) : null}
        <label className="story-field" htmlFor="add-beat-subject">
          Subject{" "}
          <abbr className="req" title="required">
            *
          </abbr>
        </label>
        <textarea
          id="add-beat-subject"
          value={subject}
          aria-invalid={errors.some((e) => e.field === "subject") ? true : undefined}
          onChange={(e) => setSubject(e.target.value)}
        />
        {errors.some((e) => e.field === "subject") ? (
          <p className="story-field-error">Enter a subject.</p>
        ) : null}
        <label className="story-field" htmlFor="add-beat-action">
          Action{" "}
          <abbr className="req" title="required">
            *
          </abbr>
        </label>
        <textarea
          id="add-beat-action"
          value={action}
          aria-invalid={errors.some((e) => e.field === "action") ? true : undefined}
          onChange={(e) => setAction(e.target.value)}
        />
        {errors.some((e) => e.field === "action") ? (
          <p className="story-field-error">Enter an action.</p>
        ) : null}
        <label className="story-field" htmlFor="add-beat-pos">
          Position
        </label>
        <select id="add-beat-pos" value={position} onChange={(e) => setPosition(e.target.value)}>
          {positions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="story-field" id="add-beat-shot">
          Shot type{" "}
          <abbr className="req" title="required">
            *
          </abbr>
        </p>
        <div className="story-pills" role="group" aria-labelledby="add-beat-shot">
          <button
            type="button"
            className={`story-pill${shotMode === "i2v" ? " is-on" : ""}`}
            aria-pressed={shotMode === "i2v"}
            onClick={() => setShotMode("i2v")}
          >
            Image to video
          </button>
          <button
            type="button"
            className={`story-pill${shotMode === "keyframe" ? " is-on" : ""}`}
            aria-pressed={shotMode === "keyframe"}
            onClick={() => setShotMode("keyframe")}
          >
            Keyframe to video
          </button>
        </div>
        {errors.some((e) => e.field === "shot") ? (
          <p className="story-field-error">Choose Image to video or Keyframe to video.</p>
        ) : null}

        {shotMode === "i2v" ? (
          <div className="story-shot-block">
            <ImageModelSelect id="add-beat-i2v-model" value={imageModel} onChange={setImageModel} />
            <label className="story-field" htmlFor="add-beat-i2v-prompt">
              Prompt
            </label>
            <textarea
              id="add-beat-i2v-prompt"
              value={i2vPrompt}
              placeholder="Describe the reference still for this clip"
              onChange={(e) => setI2vPrompt(e.target.value)}
            />
            <div className="story-tiny-row">
              <label className="story-tiny" style={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}>
                Upload
                <input
                  type="file"
                  accept={IMAGE_ACCEPT}
                  hidden
                  disabled={Boolean(busy) || i2vRefs.length >= FLASH_IMAGE_MAX}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    setBusy("Uploading…");
                    void uploadStill(file).then((still) => {
                      if (still) setI2vRefs((prev) => [...prev, still].slice(0, FLASH_IMAGE_MAX));
                      setBusy(null);
                    });
                  }}
                />
              </label>
              <button
                type="button"
                className="story-tiny"
                disabled={Boolean(busy) || i2vRefs.length >= FLASH_IMAGE_MAX}
                onClick={() => {
                  setBusy("Generating…");
                  void generateStill(i2vPrompt).then((still) => {
                    if (still) setI2vRefs((prev) => [...prev, still].slice(0, FLASH_IMAGE_MAX));
                    setBusy(null);
                  });
                }}
              >
                Generate
              </button>
            </div>
            <p className="story-hint">Need at least one ref. Mix upload and generate.</p>
            <div className="story-ref-row">
              {i2vRefs.map((item, i) => (
                <ModalStillThumb
                  key={item.id || item.url}
                  src={mediaPreview(item.id, item.url)}
                  label={`Ref ${i + 1}`}
                  onRemove={() => setI2vRefs((prev) => prev.filter((_, idx) => idx !== i))}
                />
              ))}
            </div>
          </div>
        ) : null}

        {shotMode === "keyframe" ? (
          <div className="story-shot-block">
            <ImageModelSelect id="add-beat-kf-model" value={imageModel} onChange={setImageModel} />
            <div className="story-kf-slot">
              <p className="story-field" id="add-beat-kf-start">
                Start still
              </p>
              <textarea
                id="add-beat-kf-start-prompt"
                value={kfStartPrompt}
                placeholder="Opening frame prompt"
                onChange={(e) => setKfStartPrompt(e.target.value)}
              />
              <div className="story-tiny-row">
                <label className="story-tiny" style={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}>
                  Upload
                  <input
                    type="file"
                    accept={IMAGE_ACCEPT}
                    hidden
                    disabled={Boolean(busy)}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      setBusy("Uploading…");
                      void uploadStill(file).then((still) => {
                        if (still) setKfStart(still);
                        setBusy(null);
                      });
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="story-tiny"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setBusy("Generating start…");
                    void generateStill(kfStartPrompt).then((still) => {
                      if (still) setKfStart(still);
                      setBusy(null);
                    });
                  }}
                >
                  Generate
                </button>
              </div>
              <div className="story-ref-row">
                {kfStart ? (
                  <ModalStillThumb
                    src={mediaPreview(kfStart.id, kfStart.url)}
                    label="Start"
                    onRemove={() => setKfStart(null)}
                  />
                ) : null}
              </div>
            </div>
            <div className="story-kf-slot">
              <p className="story-field">End still</p>
              <textarea
                id="add-beat-kf-end-prompt"
                value={kfEndPrompt}
                placeholder="Last frame prompt"
                onChange={(e) => setKfEndPrompt(e.target.value)}
              />
              <div className="story-tiny-row">
                <label className="story-tiny" style={{ display: "inline-flex", alignItems: "center", cursor: "pointer" }}>
                  Upload
                  <input
                    type="file"
                    accept={IMAGE_ACCEPT}
                    hidden
                    disabled={Boolean(busy)}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      setBusy("Uploading…");
                      void uploadStill(file).then((still) => {
                        if (still) setKfEnd(still);
                        setBusy(null);
                      });
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="story-tiny"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    setBusy("Generating end…");
                    void generateStill(kfEndPrompt).then((still) => {
                      if (still) setKfEnd(still);
                      setBusy(null);
                    });
                  }}
                >
                  Generate
                </button>
              </div>
              <div className="story-ref-row">
                {kfEnd ? (
                  <ModalStillThumb
                    src={mediaPreview(kfEnd.id, kfEnd.url)}
                    label="End"
                    onRemove={() => setKfEnd(null)}
                  />
                ) : null}
              </div>
            </div>
            <p className="story-hint">First scene keyframe needs its own start and end.</p>
          </div>
        ) : null}

        {errors.some((e) => e.field === "stills") ? (
          <p className="story-field-error">
            {shotMode === "i2v" ? "Generate or upload at least one ref." : "Need a start still and an end still."}
          </p>
        ) : null}
        {busy ? <p className="story-hint">{busy}</p> : null}
        {genError ? <p className="form-error">{genError}</p> : null}

        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
          <button type="button" className="story-tiny" onClick={onClose}>
            Close
          </button>
          <button
            type="submit"
            className="story-cta"
            style={{ height: 32, boxShadow: "none" }}
            disabled={!canSubmit}
          >
            {kind === "clip" ? "Add clip" : "Add scene"}
          </button>
        </div>
      </form>
    </dialog>
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
  const model = MODEL_FLASH;
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
  const [mergeOrder, setMergeOrder] = useState<number[]>([]);
  const [mergeChecked, setMergeChecked] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergedUrl, setMergedUrl] = useState<string | null>(null);
  const [queueNote, setQueueNote] = useState("");
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  const closeZoom = useCallback(() => setZoom(null), []);
  const [stillBusy, setStillBusy] = useState(false);
  const [stillNote, setStillNote] = useState("");
  const [drawingScenes, setDrawingScenes] = useState<number[]>([]);
  const [mobilePane, setMobilePane] = useState<MobilePane>("canvas");
  const [stillErrors, setStillErrors] = useState<Record<number, string>>({});
  const [startErrors, setStartErrors] = useState<Record<number, string>>({});
  const [selectedScene, setSelectedScene] = useState(0);
  const [beatFocus, setBeatFocus] = useState<BeatFocus>("wait");
  const [inspectKind, setInspectKind] = useState<"sheet" | "start" | "end" | null>(null);
  const [selectedCast, setSelectedCast] = useState<number | null>(null);
  const [stillTab, setStillTab] = useState<"up" | "gen">("up");
  const [moreOpen, setMoreOpen] = useState(false);
  const [addModal, setAddModal] = useState<"scene" | "clip" | null>(null);
  const [bridgeNote, setBridgeNote] = useState("");
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const addClipBtnRef = useRef<HTMLButtonElement>(null);
  const beatDragRef = useRef<number | null>(null);
  const studioRef = useRef<HTMLDivElement>(null);

  const scenesHeadingRef = useRef<HTMLHeadingElement>(null);
  const mergedPlayerRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onlyAbortRef = useRef<AbortController | null>(null);
  const lastCreateAtRef = useRef(0);
  const stillWaitRef = useRef(new Map<string, Promise<string | null>>());
  const stillGenRef = useRef(new Map<string, number>());
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
  filmStyleRef.current = filmStyle;
  storyRef.current = story;

  const mentionMedia = useMemo(
    () => storyPromptChips(imageAssets, audioAssets, characters, scenes),
    [imageAssets, audioAssets, characters, scenes],
  );
  const clipOrder = useMemo(
    () => (isPermutation(mergeOrder, clips.length) ? mergeOrder : identityOrder(clips.length)),
    [mergeOrder, clips.length],
  );
  const totalSec = scenes.reduce((sum, s) => sum + s.duration_sec, 0);
  const planClips = flashStorySceneCount(targetMinutes);
  const skipSaveRef = useRef(true);

  useEffect(() => {
    const cp = loadCheckpoint();
    if (
      cp &&
      (cp.gate === "storyboard" || cp.gate === "clips") &&
      Array.isArray(cp.scenes) &&
      cp.scenes.length >= STORY_SCENE_MIN
    ) {
      // sessionStorage hydrate after mount (no SSR). Not derived-from-props.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore checkpoint
      setGate(cp.gate);
      setSource(cp.source === "story" ? "story" : "topic");
      setText(typeof cp.text === "string" ? cp.text : "");
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
      const nextScenes = stampShotModes(
        cp.scenes.slice(0, STORY_SCENE_HARD_MAX).map((s) => ({
          ...s,
          cast: Array.isArray(s.cast) ? s.cast : [],
          bridgeId: typeof s.bridgeId === "string" ? s.bridgeId : "",
          bridgeUrl: typeof s.bridgeUrl === "string" ? s.bridgeUrl : "",
          startId: typeof s.startId === "string" ? s.startId : "",
          startUrl: typeof s.startUrl === "string" ? s.startUrl : "",
          videoPrompt: typeof s.videoPrompt === "string" ? s.videoPrompt : "",
          stillPrompt: typeof s.stillPrompt === "string" ? s.stillPrompt : "",
          startPrompt: typeof s.startPrompt === "string" ? s.startPrompt : "",
          imageModel: isImageModelId(s.imageModel) ? s.imageModel : DEFAULT_IMAGE_MODEL,
          duration_sec: snapStoryDuration(s.duration_sec, MODEL_FLASH),
          shotMode: isShotMode(s.shotMode) ? s.shotMode : ("" as ShotMode),
          i2vRefs: parseStillRefs(s.i2vRefs),
        })),
      );
      setScenes(nextScenes);
      setSelectedScene(0);
      setBeatFocus("scene");
      setInspectKind(null);
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
      if (cp.gate === "clips") {
        setClips(restored);
        clipsRef.current = restored;
        setMergeOrder(isPermutation(cp.mergeOrder, restored.length) ? cp.mergeOrder : identityOrder(restored.length));
        lastCreateAtRef.current = typeof cp.lastCreateAt === "number" ? cp.lastCreateAt : 0;
      } else {
        setClips([]);
        clipsRef.current = [];
        setMergeOrder([]);
      }
    }
    skipSaveRef.current = false;
  }, []);

  useEffect(() => {
    if (gate !== "storyboard") return;
    if (scenes.length === 0 || characters.length === 0) return;
    const needEnd = scenes.filter((_, i) => !sceneIsI2V(scenes, i));
    const needStart = scenes.filter((_, i) => sceneNeedsGeneratedStart(scenes, i));
    if (
      (needEnd.length === 0 || needEnd.every((s) => s.bridgeUrl)) &&
      (needStart.length === 0 || needStart.every((s) => s.startUrl))
    ) {
      return;
    }
    void fetchAllStills();
    // Board/roster length only — still URL writes must not retrigger. fetchAllStills is ref-based.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      mergeOrder: clipOrder,
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
    clipOrder,
  ]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      onlyAbortRef.current?.abort();
    };
  }, []);

  function stopQueue(markStopped = false) {
    if (markStopped) {
      const model = modelRef.current;
      for (const c of clipsRef.current) {
        if ((c.status === "generating" || c.status === "queued") && c.videoId) {
          void abortServerJob(c.videoId, model);
        }
      }
    }
    abortRef.current?.abort();
    abortRef.current = null;
    onlyAbortRef.current?.abort();
    onlyAbortRef.current = null;
    if (markStopped) {
      setClips((prev) => {
        const next = prev.map((c) =>
          c.status === "generating" || c.status === "queued"
            ? {
                ...c,
                status: "failed" as const,
                error: "Stopped.",
                progress: undefined,
                resumeKind: c.videoId ? ("poll" as const) : ("create" as const),
              }
            : c,
        );
        clipsRef.current = next;
        return next;
      });
      setQueueNote("");
    }
  }

  function resetAll() {
    stopQueue();
    lastCreateAtRef.current = 0;
    setGate("input");
    setSource("topic");
    setText("");
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
    setMergeOrder([]);
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
    setDrawingScenes([]);
    setMobilePane("canvas");
    setStillErrors({});
    setStartErrors({});
    setSelectedScene(0);
    setBeatFocus("wait");
    setInspectKind(null);
    setSelectedCast(null);
    setAddModal(null);
    setMoreOpen(false);
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
      const imageCap = gate === "input" ? STORY_COMPOSE_IMAGE_MAX : STORY_BOARD_IMAGE_MAX;
      const used = gate === "input" ? imageAssets.length : libraryImageTotal(imageAssets, characters, scenes);
      const room = imageCap - used;
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
          sceneIndex: null,
        });
      }
      if (added.length) setImageAssets((prev) => [...prev, ...added].slice(0, imageCap));
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
      const audioCap = gate === "input" ? STORY_COMPOSE_AUDIO_MAX : STORY_BOARD_AUDIO_MAX;
      const room = audioCap - audioAssets.length;
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
      if (added.length) setAudioAssets((prev) => [...prev, ...added].slice(0, audioCap));
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
    const res = await fetch("/api/character-sheet", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      setSheetError(await readDetail(res));
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
        video_model: MODEL_FLASH,
        target_minutes: targetMinutes,
        aspect_ratio: flashAspect,
      };
      const res = await fetch("/api/storyboard", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) {
        setWriteError(await readDetail(res));
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
            typeof rec.duration_sec === "number" ? rec.duration_sec : FLASH_STORY_SECONDS,
            MODEL_FLASH,
          ),
          durationTouched: false,
          cast,
          setting: str("setting") || str("visual_prompt"),
          subject: str("subject"),
          action: str("action"),
          camera_movement: str("camera_movement"),
          lighting: str("lighting"),
          style: str("style"),
          dialogue: normalizeDialogueJson(rec.dialogue),
          videoPrompt: "",
          stillPrompt: "",
          startPrompt: "",
          bridgeId: "",
          bridgeUrl: "",
          startId: "",
          startUrl: "",
          imageModel: DEFAULT_IMAGE_MODEL,
          shotMode: "keyframe",
          i2vRefs: [],
        });
      }
      for (let i = 0; i < nextScenes.length; i += 1) {
        nextScenes[i].shotMode = sceneUsesSheetI2V(nextScenes, i) ? "i2v" : "keyframe";
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
      setSelectedScene(0);
      setBeatFocus("scene");
      setInspectKind(null);
      setOpenScenes(new Set(nextScenes.length ? [0] : []));
      setModelSnapHint(null);
      bumpBridgeEpoch();
      setStillErrors({});
      setStartErrors({});
      setGate("storyboard");
      queueMicrotask(() => scenesHeadingRef.current?.focus());
      const drawn = await fetchAllSheets(bound.chars, style);
      if (drawn.some((c) => c.stillUrl)) await fetchAllStills();
    } catch {
      setWriteError("Agnes is unavailable or the job was not found.");
    } finally {
      setWriting(false);
    }
  }

  function dropScene(index: number) {
    if (scenes.length <= STORY_SCENE_MIN) return;
    setScenes((prev) => {
      const next = prev.filter((_, i) => i !== index);
      scenesRef.current = next;
      return next;
    });
    setImageAssets((prev) =>
      prev.map((img) => ({ ...img, sceneIndex: shiftSceneIndex(img.sceneIndex, index, -1) })),
    );
    setAudioAssets((prev) =>
      prev.map((aud) => ({ ...aud, sceneIndex: shiftSceneIndex(aud.sceneIndex, index, -1) })),
    );
    if (gate === "clips") {
      setClips((prev) => {
        const next = prev.filter((_, i) => i !== index);
        clipsRef.current = next;
        return next;
      });
      setMergeOrder((prev) => identityOrder(Math.max(0, prev.length - 1)));
      setMergedUrl(null);
      setMergeChecked(false);
    }
    setSelectedScene((prev) => Math.max(0, prev === index ? index - 1 : prev > index ? prev - 1 : prev));
    setInspectKind(null);
  }

  function insertBeat(form: AddSceneForm, generateClip: boolean) {
    const at = Math.max(0, Math.min(scenesRef.current.length, Number(form.position)));
    const draft = emptySceneDraft(filmStyle, characters[0] ? [characters[0].name] : []);
    draft.title = form.title.trim() || "Untitled";
    draft.duration_sec = snapStoryDuration(form.duration_sec, MODEL_FLASH);
    draft.setting = form.setting.trim();
    draft.subject = form.subject.trim();
    draft.action = form.action.trim();
    draft.shotMode = form.shotMode;
    draft.imageModel = form.imageModel;
    if (form.shotMode === "i2v") {
      draft.i2vRefs = form.i2vRefs.slice(0, FLASH_IMAGE_MAX);
      const first = draft.i2vRefs[0];
      if (first) {
        draft.startId = first.id;
        draft.startUrl = first.url;
      }
    } else {
      draft.startId = form.startId;
      draft.startUrl = form.startUrl;
      draft.startPrompt = form.startPrompt.trim();
      draft.bridgeId = form.bridgeId;
      draft.bridgeUrl = form.bridgeUrl;
      draft.stillPrompt = form.stillPrompt.trim();
    }
    const nextScenes = scenesRef.current.slice();
    nextScenes.splice(at, 0, draft);
    const neighbor = nextScenes[at + 1];
    let note = "";
    if (neighbor && !sceneIsI2V(nextScenes, at + 1)) {
      if (sceneIsI2V(nextScenes, at)) {
        nextScenes[at + 1] = { ...neighbor, startId: "", startUrl: "", startPrompt: "" };
        note = `S${at + 2} is keyframe after an I2V insert — drawing a new start still from that scene's story.`;
      } else {
        nextScenes[at + 1] = {
          ...neighbor,
          startId: draft.bridgeId,
          startUrl: draft.bridgeUrl,
        };
        note = `S${at + 2} start still now uses the new scene's end still.`;
      }
    }
    scenesRef.current = nextScenes;
    setScenes(nextScenes);
    setImageAssets((prev) =>
      prev.map((img) => ({ ...img, sceneIndex: shiftSceneIndex(img.sceneIndex, at, 1) })),
    );
    setAudioAssets((prev) =>
      prev.map((aud) => ({ ...aud, sceneIndex: shiftSceneIndex(aud.sceneIndex, at, 1) })),
    );
    setSelectedScene(at);
    setBeatFocus("scene");
    setInspectKind(null);
    setMergedUrl(null);
    setMergeChecked(false);
    setBridgeNote(note);
    if (note) {
      window.setTimeout(() => {
        setBridgeNote((cur) => (cur === note ? "" : cur));
      }, 8000);
    }
    if (generateClip || gate === "clips") {
      setClips((prev) => {
        const next = prev.slice();
        next.splice(at, 0, { status: "waiting" });
        clipsRef.current = next;
        return next;
      });
      setMergeOrder(identityOrder(nextScenes.length));
    }
    void (async () => {
      const needNeighborStart =
        sceneIsI2V(nextScenes, at) && at + 1 < nextScenes.length && !sceneIsI2V(nextScenes, at + 1);
      if (needNeighborStart && gate !== "storyboard") {
        await ensureStill(at + 1, "start", undefined, { replace: true });
      }
      if (generateClip) startQueue(at, false, at);
    })();
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
      setMergeOrder([]);
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
    resume = false,
  ): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const nested = new AbortController();
      const settle = (result: { ok: true; url: string } | { ok: false; message: string }) => {
        if (settled) return;
        settled = true;
        nested.abort();
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => settle({ ok: false, message: "Aborted" });
      signal.addEventListener("abort", onAbort);
      if (signal.aborted) {
        onAbort();
        return;
      }
      openJobSse(
        videoId,
        pollModel,
        nested.signal,
        {
          onStatus: (_status, progress) => {
            if (settled) return;
            onStatus(progress);
          },
          onCompleted: (url) => {
            if (!url || !isPublicHttpsUrl(url)) {
              settle({ ok: false, message: "Clip finished but no playable URL." });
              return;
            }
            settle({ ok: true, url });
          },
          onAuthError: (message) => settle({ ok: false, message }),
        },
        resume,
      );
    });
  }

  async function extractFrame(
    url: string,
  ): Promise<{ ok: true; id: string; url: string } | { ok: false; detail: string }> {
    try {
      const res = await fetch("/api/videos/frame", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) return { ok: false, detail: await readDetail(res) };
      const body: unknown = await res.json();
      const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
      const id = rec && typeof rec.id === "string" ? rec.id : "";
      const urlOut = rec && typeof rec.url === "string" ? rec.url : "";
      if (!id) return { ok: false, detail: "Could not extract the last frame." };
      return { ok: true, id, url: urlOut };
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
      lastFrameSrc: frame.ok ? mediaPreview(frame.id, frame.url) : undefined,
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

  function stillJobKey(kind: "start" | "end", index: number): string {
    return `${kind}:${index}`;
  }

  function bumpBridgeEpoch() {
    bridgeEpochRef.current += 1;
    stillWaitRef.current.clear();
    stillGenRef.current = new Map();
  }

  function setStillErrorAt(index: number, detail: string | null, kind: "start" | "end" = "end") {
    const setter = kind === "start" ? setStartErrors : setStillErrors;
    setter((prev) => {
      if (!detail) {
        if (!(index in prev)) return prev;
        const next = { ...prev };
        delete next[index];
        return next;
      }
      return { ...prev, [index]: detail };
    });
  }

  async function ensureStill(
    index: number,
    kind: "start" | "end",
    signal?: AbortSignal,
    opts?: { replace?: boolean },
  ): Promise<string | null> {
    const existing = scenesRef.current[index];
    if (!existing) return null;
    const have = kind === "start" ? existing.startUrl : existing.bridgeUrl;
    if (!opts?.replace && have) return have;
    const key = stillJobKey(kind, index);
    const waiting = !opts?.replace ? stillWaitRef.current.get(key) : undefined;
    if (waiting) return waiting;
    const epoch = bridgeEpochRef.current;
    const gen = stillGenRef.current.get(key) ?? 0;
    const label = kind === "start" ? "opening" : "landing";
    const job = (async () => {
      try {
        const scene = scenesRef.current[index];
        if (!scene) return null;
        const roster = charactersRef.current;
        const prompt =
          kind === "start"
            ? composeStartStillPrompt(scene, roster, filmStyleRef.current, storyRef.current)
            : composeStillPrompt(scene, roster, filmStyleRef.current, storyRef.current);
        const payload: Record<string, unknown> = {
          prompt,
          ratio: modelRef.current === MODEL_FLASH ? filmRef.current.flashAspect : filmRef.current.v20Aspect,
          model: scene.imageModel || DEFAULT_IMAGE_MODEL,
          cast: sceneCastForStill(scene, roster).map((c) => c.name),
          validate: true,
        };
        if (abortRef.current || onlyAbortRef.current) {
          setQueueNote(`Drawing ${label} still for scene ${index + 1}…`);
        }
        const res = await fetch("/api/scene-still", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (signal?.aborted) return null;
        if (bridgeEpochRef.current !== epoch) return null;
        if ((stillGenRef.current.get(key) ?? 0) !== gen) return null;
        if (res.status === 401) {
          setStillErrorAt(index, await readDetail(res), kind);
          return null;
        }
        if (!res.ok) {
          setStillErrorAt(index, await readDetail(res), kind);
          return null;
        }
        onAuthOk();
        const body: unknown = await res.json();
        const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
        const url = rec && typeof rec.url === "string" ? rec.url : "";
        const id = rec && typeof rec.id === "string" ? rec.id : "";
        if (!url) {
          setStillErrorAt(index, `${kind === "start" ? "Start" : "End"} still did not return an image.`, kind);
          return null;
        }
        if (bridgeEpochRef.current !== epoch) return null;
        if ((stillGenRef.current.get(key) ?? 0) !== gen) return null;
        const check = parseStillCheck(body);
        if (check?.judged && !check.pass) {
          setStillErrorAt(index, stillFailCopy(check.reasons), kind);
        } else {
          setStillErrorAt(index, null, kind);
        }
        patchScene(
          index,
          kind === "start" ? { startId: id, startUrl: url } : { bridgeId: id, bridgeUrl: url },
        );
        return url;
      } catch {
        if (bridgeEpochRef.current !== epoch) return null;
        if ((stillGenRef.current.get(key) ?? 0) !== gen) return null;
        setStillErrorAt(index, `Could not draw this ${kind === "start" ? "start" : "end"} still.`, kind);
        return null;
      }
    })();
    stillWaitRef.current.set(key, job);
    try {
      return await job;
    } finally {
      if (stillWaitRef.current.get(key) === job) stillWaitRef.current.delete(key);
    }
  }

  async function fetchAllStills() {
    const list = scenesRef.current;
    const jobs: { index: number; kind: "start" | "end" }[] = [];
    for (let i = 0; i < list.length; i += 1) {
      if (!sceneIsI2V(list, i) && !list[i]?.bridgeUrl) jobs.push({ index: i, kind: "end" });
      if (sceneNeedsGeneratedStart(list, i) && !list[i]?.startUrl) jobs.push({ index: i, kind: "start" });
    }
    if (jobs.length === 0) return;
    setStillBusy(true);
    setDrawingScenes(uniqueSceneIndexes(jobs));
    setStillNote(
      jobs.length === 1
        ? `Drawing ${jobs[0].kind === "start" ? "opening" : "end"} still for scene ${jobs[0].index + 1}…`
        : `Drawing ${jobs.length} scene stills…`,
    );
    try {
      await Promise.all(jobs.map((j) => ensureStill(j.index, j.kind)));
    } catch {
      /* ensureStill swallows fetch errors */
    } finally {
      setStillBusy(false);
      setStillNote("");
      setDrawingScenes([]);
    }
  }

  async function regenSceneStill(index: number, kind: "start" | "end" = "end") {
    const key = stillJobKey(kind, index);
    stillWaitRef.current.delete(key);
    stillGenRef.current.set(key, (stillGenRef.current.get(key) ?? 0) + 1);
    setStillErrorAt(index, null, kind);
    setStillBusy(true);
    setDrawingScenes([index]);
    setStillNote(`Drawing ${kind === "start" ? "opening" : "end"} still for scene ${index + 1}…`);
    try {
      await ensureStill(index, kind, undefined, { replace: true });
    } catch {
      setStillErrorAt(index, `Could not draw this ${kind === "start" ? "start" : "end"} still.`, kind);
    } finally {
      setStillBusy(false);
      setStillNote("");
      setDrawingScenes([]);
    }
  }

  async function checkAndFixStills() {
    const list = scenesRef.current;
    const targets: { index: number; kind: "start" | "end"; image: string; imageId: string }[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const scene = list[index];
      if (sceneNeedsGeneratedStart(list, index)) {
        const image = stillJudgeSource(scene, "start");
        if (image) targets.push({ index, kind: "start", image, imageId: scene.startId });
      }
      if (!sceneIsI2V(list, index)) {
        const image = stillJudgeSource(scene, "end");
        if (image) targets.push({ index, kind: "end", image, imageId: scene.bridgeId });
      }
    }
    if (targets.length === 0) {
      setStillNote("No scene stills to check yet.");
      return;
    }
    setStillBusy(true);
    setDrawingScenes([]);
    setStillNote(`Checking ${targets.length} scene stills…`);
    try {
      const verdicts = await Promise.all(
        targets.map(async (target) => {
          const latest = scenesRef.current[target.index];
          const image = latest ? stillJudgeSource(latest, target.kind) : target.image;
          const imageId =
            latest && target.kind === "start" ? latest.startId : latest ? latest.bridgeId : target.imageId;
          const payload: Record<string, unknown> = {
            check_only: true,
            image,
            image_id: imageId,
            cast: sceneCastForStill(latest ?? list[target.index], charactersRef.current).map((c) => c.name),
          };
          const res = await fetch("/api/scene-still", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (res.status === 401 || !res.ok) {
            return { ...target, error: await readDetail(res), verdict: null as ReturnType<typeof parseStillCheck> };
          }
          onAuthOk();
          return { ...target, error: null as string | null, verdict: parseStillCheck(await res.json()) };
        }),
      );
      const redraw: { index: number; kind: "start" | "end" }[] = [];
      for (const item of verdicts) {
        if (item.error) {
          setStillErrorAt(item.index, item.error, item.kind);
          continue;
        }
        if (!item.verdict) {
          setStillErrorAt(item.index, null, item.kind);
          continue;
        }
        if (item.verdict.pass || !item.verdict.judged) {
          setStillErrorAt(item.index, null, item.kind);
          continue;
        }
        setStillErrorAt(item.index, stillFailCopy(item.verdict.reasons), item.kind);
        redraw.push({ index: item.index, kind: item.kind });
      }
      if (redraw.length > 0) {
        setDrawingScenes(uniqueSceneIndexes(redraw));
        setStillNote(
          redraw.length === 1
            ? `Scene ${redraw[0].index + 1} failed gold standard — redrawing…`
            : `Redrawing ${redraw.length} stills that failed gold standard…`,
        );
        await Promise.all(
          redraw.map((item) => {
            const key = stillJobKey(item.kind, item.index);
            stillWaitRef.current.delete(key);
            stillGenRef.current.set(key, (stillGenRef.current.get(key) ?? 0) + 1);
            return ensureStill(item.index, item.kind, undefined, { replace: true });
          }),
        );
      }
    } catch {
      setStillNote("Could not finish checking stills.");
    } finally {
      setStillBusy(false);
      setStillNote("");
      setDrawingScenes([]);
    }
  }

  async function pollClip(
    i: number,
    createdId: string,
    signal: AbortSignal,
    resume = false,
  ): Promise<void> {
    const done = await waitStoryJob(
      createdId,
      modelRef.current,
      signal,
      (progress) => {
        patchClip(i, { status: "generating", progress, videoId: createdId });
      },
      resume,
    );
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
        inflight.push(pollClip(i, createdId, signal, true));
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

      const i2v = sceneIsI2V(list, i);
      const needsStart = sceneNeedsGeneratedStart(list, i);
      let endFrame: string | undefined;
      let startFrame: string | undefined;
      if (!i2v) {
        const stillJobs: Promise<string | null>[] = [ensureStill(i, "end", signal)];
        if (needsStart) stillJobs.push(ensureStill(i, "start", signal));
        else if (i > 0 && !sceneIsI2V(list, i - 1)) stillJobs.push(ensureStill(i - 1, "end", signal));
        const [endUrl, startUrl] = await Promise.all(stillJobs);
        if (signal.aborted) break;
        endFrame = endUrl ?? undefined;
        if (!endFrame) {
          patchClip(i, {
            status: "failed",
            error: "Could not draw this scene's landing still.",
            resumeKind: "create",
          });
          break;
        }
        if (needsStart) {
          startFrame = startUrl ?? undefined;
          if (!startFrame) {
            patchClip(i, {
              status: "failed",
              error: "Could not draw this scene's opening still.",
              resumeKind: "create",
            });
            break;
          }
        } else if (i > 0 && !sceneIsI2V(list, i - 1)) {
          startFrame = startUrl ?? undefined;
          if (!startFrame) {
            patchClip(i, {
              status: "failed",
              error: "Need the landing still from the scene before this.",
              resumeKind: "create",
            });
            break;
          }
        }
      }
      if (i + 1 < list.length) {
        if (!sceneIsI2V(list, i + 1)) void ensureStill(i + 1, "end", signal);
        if (sceneNeedsGeneratedStart(list, i + 1)) void ensureStill(i + 1, "start", signal);
      }

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
              startIsGenerated: needsStart,
              prevEnd: prev
                ? { setting: prev.setting, subject: prev.subject, action: prev.action }
                : undefined,
              extraPrompt: custom,
            },
          );
      const seedNow = seedRef.current || 1;
      const film = filmRef.current;
      const selectedImages = selectedImageUrls(assetsRef.current.images, i);
      const selectedAudios = selectedAudioUrls(assetsRef.current.audios, i);

      const payload: Record<string, unknown> = {
        ...scenePayload(modelRef.current, prompt, scene.duration_sec, {
          sheets,
          i2vRefs: (scene.i2vRefs ?? []).map((r) => r.url),
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

      let createdId = "";
      for (let attempt = 1; attempt <= STORY_CREATE_QUEUE_FULL_ATTEMPTS; attempt += 1) {
        patchClip(i, { status: "generating", progress: undefined, error: undefined });
        try {
          const res = await fetch("/api/videos", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (res.status === 401) {
            onAuthError();
            patchClip(i, { status: "failed", error: "Add an Agnes API key in the header, or set AGNES_API_KEY in .env and restart.", resumeKind: "create" });
            break;
          }
          if (!res.ok) {
            const detail = await readDetail(res);
            if (isAgnesCreateQueueFull(detail) && attempt < STORY_CREATE_QUEUE_FULL_ATTEMPTS) {
              patchClip(i, { status: "queued", error: undefined });
              const deadline = Date.now() + STORY_CREATE_QUEUE_FULL_WAIT_MS;
              while (Date.now() < deadline) {
                const remaining = deadline - Date.now();
                setQueueNote(`Queue full. Next create in ~${Math.ceil(remaining / 1000)}s.`);
                await sleep(Math.min(1000, remaining), signal);
              }
              continue;
            }
            setQueueNote("");
            patchClip(i, { status: "failed", error: detail, resumeKind: "create" });
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
          lastCreateAtRef.current = Date.now();
          createdId = videoId;
          break;
        } catch (err) {
          if (isAbort(err)) break;
          patchClip(i, { status: "failed", error: "Agnes is unavailable or the job was not found.", resumeKind: "create" });
          break;
        }
      }
      if (signal.aborted || !createdId) break;

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
    const needEnd = scenesRef.current
      .map((_, i) => i)
      .filter((i) => !sceneIsI2V(scenesRef.current, i));
    const needStart = scenesRef.current
      .map((_, i) => i)
      .filter((i) => sceneNeedsGeneratedStart(scenesRef.current, i));
    if (
      needEnd.some((i) => !scenesRef.current[i]?.bridgeUrl) ||
      needStart.some((i) => !scenesRef.current[i]?.startUrl)
    ) {
      await fetchAllStills();
      needEnd.forEach((i) => {
        if (!scenesRef.current[i]?.bridgeUrl) setStillErrorAt(i, "End still not drawn yet. Retry this cell.", "end");
      });
      needStart.forEach((i) => {
        if (!scenesRef.current[i]?.startUrl) setStillErrorAt(i, "Start still not drawn yet. Retry this cell.", "start");
      });
      if (
        needEnd.some((i) => !scenesRef.current[i]?.bridgeUrl) ||
        needStart.some((i) => !scenesRef.current[i]?.startUrl)
      ) {
        return;
      }
    }
    const snapped = scenes.map((s) => ({
      ...s,
      duration_sec: snapStoryDuration(s.duration_sec, MODEL_FLASH),
    }));
    scenesRef.current = snapped;
    setScenes(snapped);
    const initial: Clip[] = snapped.map(() => ({ status: "waiting" }));
    setClips(initial);
    clipsRef.current = initial;
    setMergeOrder(identityOrder(initial.length));
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
    const ordered = clipOrder.map((i) => clips[i]);
    const urls = ordered.map((c) => c?.url).filter((u): u is string => typeof u === "string" && isPublicHttpsUrl(u));
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

  const allReady = clips.length > 0 && clips.every((c) => c.status === "ready");
  const generatingIndex = clips.findIndex((c) => c.status === "generating");
  const queueRunning = clips.some((c) => c.status === "generating" || c.status === "queued");
  const failedIndex = clips.findIndex((c) => c.status === "failed");
  const studioMode: StudioMode =
    gate === "clips" ? "playback" : gate === "storyboard" ? "board" : "compose";
  const imageCap = studioMode === "compose" ? STORY_COMPOSE_IMAGE_MAX : STORY_BOARD_IMAGE_MAX;
  const audioCap = studioMode === "compose" ? STORY_COMPOSE_AUDIO_MAX : STORY_BOARD_AUDIO_MAX;
  const genStills = generatedImageAliases(characters, scenes);
  const imageCount = studioMode === "compose" ? imageAssets.length : libraryImageTotal(imageAssets, characters, scenes);
  const scene = scenes[selectedScene];
  const clip = clips[selectedScene];
  const sheetI2V = scene ? sceneIsI2V(scenes, selectedScene) : false;
  const needsStart = scene ? sceneNeedsGeneratedStart(scenes, selectedScene) : false;
  const pipelineBusy =
    writing || sheetBusy || (stillBusy && clips.length === 0 && drawingScenes.length !== 1);
  const bootStep = stillBusy ? "stills" : sheetBusy ? "sheets" : "storyboard";
  const bootCopy = stillNote || sheetNote || "Writing the storyboard…";
  const sheetNames = characters.map((c) => c.name.trim()).filter(Boolean);

  function queueLive(): string {
    if (stillBusy || stillNote) return stillNote || "Working on scene stills…";
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

  function requestMode(next: StudioMode) {
    if (next === "compose") {
      setGate("input");
      setBeatFocus("wait");
      setInspectKind(null);
      return;
    }
    if (next === "board") {
      if (scenes.length < STORY_SCENE_MIN) return;
      if (gate === "clips") {
        if (!window.confirm("This throws away generated clips. Storyboard stays.")) return;
        stopQueue();
        setClips([]);
        clipsRef.current = [];
        setMergeOrder([]);
        setMergeChecked(false);
        setMerging(false);
        setMergeError(null);
        setMergedUrl(null);
        setQueueNote("");
      }
      setGate("storyboard");
      setBeatFocus(scene ? "scene" : "wait");
      setInspectKind(null);
      return;
    }
    if (clips.length === 0) return;
    setGate("clips");
    setBeatFocus("scene");
    setInspectKind(null);
  }

  function onCta() {
    if (studioMode === "compose") {
      void writeStoryboard();
      return;
    }
    if (studioMode === "board") {
      void looksGood();
      return;
    }
    if (mergedUrl) {
      window.open(mergedUrl, "_blank", "noopener,noreferrer");
      return;
    }
    void mergeClips();
  }

  const ctaDisabled =
    studioMode === "compose"
      ? writing || assetStoring
      : studioMode === "board"
        ? writing ||
          sheetBusy ||
          assetStoring ||
          stillBusy ||
          characters.length === 0 ||
          characters.some((c) => !c.stillUrl) ||
          scenes.some((s) => !shotReady(s))
        : mergedUrl
          ? false
          : !allReady || !mergeChecked || merging;

  const ctaLabel =
    studioMode === "compose"
      ? writing
        ? "Writing…"
        : "Write storyboard"
      : studioMode === "board"
        ? "Looks good"
        : mergedUrl
          ? "Download MP4"
          : merging
            ? "Merging…"
            : "Merge clips";

  function stillTiles(): { src: string; label: string; kind: "start" | "end" | "sheet"; index: number }[] {
    if (!scene) return [];
    if (sheetI2V) {
      const refs = (scene.i2vRefs ?? []).filter((r) => r.url || r.id);
      if (refs.length > 0) {
        return refs.map((ref, i) => ({
          src: mediaPreview(ref.id, ref.url),
          label: `Ref ${i + 1}`,
          kind: "start" as const,
          index: selectedScene,
        }));
      }
      const wanted = (scene.cast ?? []).map((n) => n.toLowerCase());
      const castSheets = (
        wanted.length > 0 ? characters.filter((c) => wanted.includes(c.name.toLowerCase())) : characters
      ).filter((c) => c.stillUrl || c.stillId);
      return castSheets.map((ch, i) => ({
        src: mediaPreview(ch.stillId, ch.stillUrl),
        label: `Sheet · ${ch.name}`,
        kind: "sheet" as const,
        index: characters.findIndex((c) => c.name === ch.name) >= 0 ? characters.findIndex((c) => c.name === ch.name) : i,
      }));
    }
    const tiles: { src: string; label: string; kind: "start" | "end" | "sheet"; index: number }[] = [];
    const prev = selectedScene > 0 ? scenes[selectedScene - 1] : null;
    const startSrc = needsStart
      ? mediaPreview(scene.startId, scene.startUrl)
      : prev
        ? mediaPreview(prev.bridgeId, prev.bridgeUrl)
        : "";
    if (startSrc) {
      tiles.push({
        src: startSrc,
        label: "Start still",
        kind: needsStart ? "start" : "end",
        index: needsStart ? selectedScene : selectedScene - 1,
      });
    }
    const endSrc = mediaPreview(scene.bridgeId, scene.bridgeUrl);
    if (endSrc) tiles.push({ src: endSrc, label: "End still", kind: "end", index: selectedScene });
    return tiles;
  }

  const boardStillTiles = stillTiles();
  const inspectorTitle =
    beatFocus === "cast" && selectedCast != null
      ? "Character"
      : inspectKind === "start" || inspectKind === "end"
        ? "Scene images"
        : scene
          ? "Scene"
          : "Details";

  function openInspector(kind: "sheet" | "start" | "end", index: number) {
    if (studioMode === "compose") return;
    setInspectKind(kind);
    if (kind === "sheet") {
      setSelectedCast(index);
      setBeatFocus("cast");
    } else {
      setSelectedScene(index);
      setBeatFocus("scene");
    }
    if (isPhoneStory()) setMobilePane("details");
  }

  const mappedImages = imageAssets.filter(
    (img) => img.selected && (img.sceneIndex === null || img.sceneIndex === selectedScene),
  );
  const mappedAudios = audioAssets.filter(
    (a) => a.selected && (a.sceneIndex === null || a.sceneIndex === selectedScene),
  );

  return (
    <div
      className="story-root"
      data-mode={studioMode}
      data-pane={mobilePane}
      style={!active ? { display: "none" } : undefined}
      aria-hidden={!active}
    >
      <header className="story-topbar story-glass">
        <div className="story-brand">
          <span className="story-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M5 12h14M12 5v14" />
            </svg>
          </span>
          <b>Agnes</b>
        </div>
        <div className="story-proj" title={text || story || "New sequence"}>
          {text.trim() || story.trim() || "New sequence"}
        </div>
        <span className="story-chip">{formatStoryLength(totalSec || targetMinutes * 60)}</span>
        <div className="story-modes" role="group" aria-label="Editor mode">
          {(["compose", "board", "playback"] as StudioMode[]).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={studioMode === id}
              disabled={
                (id === "board" && scenes.length < STORY_SCENE_MIN) ||
                (id === "playback" && clips.length === 0)
              }
              onClick={() => requestMode(id)}
            >
              {id === "compose" ? "Compose" : id === "board" ? "Board" : "Playback"}
            </button>
          ))}
        </div>
        <div className="story-menu-wrap">
          <button
            type="button"
            className="story-icon-btn"
            aria-haspopup="true"
            aria-expanded={moreOpen}
            aria-label="More actions"
            onClick={() => setMoreOpen((v) => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="6" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="18" cy="12" r="1.7" />
            </svg>
          </button>
          <div className={`story-menu story-glass${moreOpen ? " is-on" : ""}`}>
            {studioMode === "board" ? (
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  if (!window.confirm("Replace these scenes? Edits go away. Clips have not started.")) return;
                  void writeStoryboard(true);
                }}
              >
                Rewrite board
              </button>
            ) : null}
            {studioMode !== "compose" ? (
              <button
                type="button"
                disabled={stillBusy || !scenes.some((s) => s.bridgeUrl || s.startUrl)}
                onClick={() => {
                  setMoreOpen(false);
                  void checkAndFixStills();
                }}
              >
                Check &amp; fix stills
              </button>
            ) : null}
          </div>
        </div>
        <label className="story-confirm">
          <input
            type="checkbox"
            checked={mergeChecked}
            disabled={!allReady || merging || Boolean(mergedUrl)}
            onChange={(e) => setMergeChecked(e.target.checked)}
          />
          These clips are correct
        </label>
        <button type="button" className="story-abort" disabled={!queueRunning} onClick={() => stopQueue(true)}>
          Abort
        </button>
        <button type="button" className="story-cta" disabled={ctaDisabled} onClick={onCta}>
          {ctaLabel}
        </button>
      </header>

      <div className="story-pane-tabs" role="tablist" aria-label="Studio pane">
        {(
          [
            ["canvas", "Canvas"],
            ["library", "Library"],
            ["details", "Details"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mobilePane === id}
            onClick={() => setMobilePane(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="story-studio" ref={studioRef}>
        <aside className="story-bin story-glass" aria-label="Library">
          <div className="story-pane-h">Library</div>
          <div className="story-bin-body">
            <details className="story-sec" open>
              <summary>Cast</summary>
              {characters.length === 0 ? <p className="story-hint">Cast appears after Write.</p> : null}
              {characters.map((ch, index) => (
                <button
                  key={`cast-${index}`}
                  type="button"
                  className={`story-asset${beatFocus === "cast" && selectedCast === index ? " is-on" : ""}`}
                  onClick={() => {
                    if (studioMode === "compose") return;
                    setSelectedCast(index);
                    setBeatFocus("cast");
                    setInspectKind("sheet");
                    if (isPhoneStory()) setMobilePane("details");
                  }}
                >
                  {ch.stillUrl || ch.stillId ? (
                    <StoryCachedImg className="story-thumb" src={mediaPreview(ch.stillId, ch.stillUrl)} alt="" />
                  ) : (
                    <span className="story-thumb" />
                  )}
                  <div>
                    <b>{ch.name}</b>
                    <small>{ch.role || "character"}</small>
                  </div>
                </button>
              ))}
            </details>
            <details className="story-sec" open>
              <summary>
                Stills <span className="story-count">{imageCount}/{imageCap}</span>
              </summary>
              <div className="story-subtabs" role="tablist" aria-label="Stills source">
                <button type="button" aria-selected={stillTab === "up"} onClick={() => setStillTab("up")}>
                  Uploaded
                </button>
                <button type="button" aria-selected={stillTab === "gen"} onClick={() => setStillTab("gen")}>
                  Generated
                </button>
              </div>
              {stillTab === "up" ? (
                <>
                  <label className="story-tiny story-upload">
                    Add images
                    <input
                      type="file"
                      accept={IMAGE_ACCEPT}
                      multiple
                      disabled={writing || assetStoring || imageCount >= imageCap}
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        e.target.value = "";
                        void uploadImageFiles(files);
                      }}
                    />
                  </label>
                  <div className="story-thumb-grid">
                    {imageAssets.map((img) => (
                      <StoryCachedImg
                        key={img.key}
                        className="story-mini-still"
                        src={mediaPreview(img.id, img.url)}
                        alt={img.name}
                      />
                    ))}
                  </div>
                </>
              ) : genStills.length === 0 ? (
                <p className="story-hint">Generated sheets appear after Write storyboard.</p>
              ) : (
                genStills.map((item) => {
                  const key = `${item.regen.kind}-${item.regen.index}`;
                  const on = inspectKind === item.regen.kind && item.regen.index ===
                    (item.regen.kind === "sheet" ? selectedCast : selectedScene);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`story-asset${on ? " is-on" : ""}`}
                      onClick={() => openInspector(item.regen.kind, item.regen.index)}
                    >
                      <StoryCachedImg className="story-thumb" src={item.url} alt="" />
                      <div>
                        <b>{item.name}</b>
                        <small>
                          {item.regen.kind === "sheet"
                            ? "Character sheet"
                            : item.regen.kind === "start"
                              ? "Start still"
                              : "End still"}
                        </small>
                      </div>
                    </button>
                  );
                })
              )}
            </details>
            <details className="story-sec" open>
              <summary>
                Audio <span className="story-count">{audioAssets.length}/{audioCap}</span>
              </summary>
              <label className="story-tiny story-upload">
                Add audio
                <input
                  type="file"
                  accept={AUDIO_ACCEPT}
                  multiple
                  disabled={writing || assetStoring || audioAssets.length >= audioCap}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    void uploadAudioFiles(files);
                  }}
                />
              </label>
              {audioAssets.map((aud) => (
                <div className="story-audio-chip" key={aud.key}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                    <path d="M4 12h3l5-6v12l-5-6H4z" />
                  </svg>
                  {aud.name}
                </div>
              ))}
            </details>
          </div>
        </aside>

        <section className="story-stage story-glass" aria-label="Canvas">
          <div className="story-stage-glow" aria-hidden="true" />
          <form className="story-composer story-glass" onSubmit={onWriteSubmit} noValidate>
            <h2>New sequence</h2>
            <fieldset className="seg" style={{ border: 0, margin: "0 0 0.6rem" }}>
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
                <span>Paste</span>
              </label>
            </fieldset>
            <label className="story-field" htmlFor="story-topic">
              {source === "topic" ? "Topic" : "Story"}
            </label>
            <textarea
              id="story-topic"
              className={source === "story" ? "textarea-story" : undefined}
              rows={source === "story" ? 8 : 3}
              required
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="story-pair story-compose-meta">
              <div>
                <label className="story-field" htmlFor="story-minutes">
                  Length
                </label>
                <select
                  id="story-minutes"
                  value={targetMinutes}
                  onChange={(e) => setTargetMinutes(Number(e.target.value))}
                >
                  {STORY_MINUTES_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <p className="story-field">Aspect</p>
                <FlashAspectPills name="story-aspect" value={flashAspect} onChange={setFlashAspect} />
              </div>
            </div>
            <p className="story-hint">
              About {planClips} clips · {FLASH_STORY_SECONDS}s default. Total film, not one Agnes call.
            </p>
            {writeError ? <p className="form-error">{writeError}</p> : null}
          </form>
          <div className="story-viewer">
            <span className="story-badge">
              {sheetI2V ? "I2V" : "Keyframe"}
            </span>
            <div
              className={`story-stills${sheetI2V ? " sheets" : ""}`}
              data-count={String(Math.min(Math.max(boardStillTiles.length, 1), 3))}
            >
              {boardStillTiles.map((tile) => (
                <button
                  key={`${tile.kind}-${tile.index}-${tile.label}`}
                  type="button"
                  className="story-still"
                  onClick={() => openInspector(tile.kind, tile.index)}
                >
                  <StoryCachedImg src={tile.src} alt="" />
                  <span className="story-still-chip">{tile.label}</span>
                </button>
              ))}
            </div>
            <div className="story-player-wrap">
              {mergedUrl ? <span className="story-merged-note">Merged sequence</span> : null}
              {mergedUrl ? (
                <video ref={mergedPlayerRef} src={mergedUrl} controls playsInline tabIndex={-1} />
              ) : clip?.url ? (
                <video src={clip.url} controls playsInline />
              ) : (
                <p className="story-hint">{queueLive()}</p>
              )}
            </div>
          </div>
          <div className={`story-overlay${pipelineBusy ? " is-on" : ""}`} aria-live="polite">
            <div className="story-boot">
              <span className="story-boot-spin" aria-hidden="true" />
              <p className="story-boot-copy">{bootCopy}</p>
              <ol className="story-boot-steps">
                <li className={bootStep === "storyboard" ? "is-on" : "is-done"}>Storyboard</li>
                <li className={bootStep === "sheets" ? "is-on" : bootStep === "stills" ? "is-done" : ""}>
                  Sheets{sheetNames.length > 0 ? ` · ${sheetNames.join(", ")}` : ""}
                </li>
                <li className={bootStep === "stills" ? "is-on" : ""}>Scene stills</li>
              </ol>
            </div>
          </div>
        </section>

        <aside className="story-beat story-glass" id="beat-pane" aria-label={inspectorTitle}>
          <button
            type="button"
            className="story-grip"
            aria-label={`Resize ${inspectorTitle} pane`}
            onPointerDown={(e) => {
              beatDragRef.current = e.clientX;
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (beatDragRef.current == null) return;
              const studio = studioRef.current;
              if (!studio) return;
              const max = studio.clientWidth * 0.5;
              const styles = getComputedStyle(e.currentTarget.closest(".story-root") as HTMLElement);
              const cur = parseFloat(styles.getPropertyValue("--story-beat-w")) || 360;
              const next = Math.min(max, Math.max(260, cur - (e.clientX - beatDragRef.current)));
              beatDragRef.current = e.clientX;
              (e.currentTarget.closest(".story-root") as HTMLElement).style.setProperty(
                "--story-beat-w",
                `${next}px`,
              );
            }}
            onPointerUp={() => {
              beatDragRef.current = null;
            }}
          >
            <span />
          </button>
          <div className="story-pane-h">{inspectorTitle}</div>
          <div className="story-beat-scroll">
            {studioMode === "compose" || !scene ? (
              <div className="story-wait">
                <p>Write a storyboard to edit a scene.</p>
              </div>
            ) : beatFocus === "cast" && selectedCast != null && characters[selectedCast] ? (
              <>
                <p className="story-kicker">Cast</p>
                <h3>{characters[selectedCast].name}</h3>
                <label className="story-field" htmlFor="beat-cast-name">
                  Name
                </label>
                <input
                  id="beat-cast-name"
                  type="text"
                  value={characters[selectedCast].name}
                  onChange={(e) => {
                    const name = e.target.value;
                    const prevName = characters[selectedCast].name;
                    patchCharacter(selectedCast, { name });
                    if (prevName) {
                      setImageAssets((prev) =>
                        prev.map((img) =>
                          img.characterName === prevName ? { ...img, characterName: name } : img,
                        ),
                      );
                    }
                  }}
                />
                <label className="story-field" htmlFor="beat-cast-look">
                  Appearance
                </label>
                <textarea
                  id="beat-cast-look"
                  value={characters[selectedCast].appearance}
                  onChange={(e) => patchCharacter(selectedCast, { appearance: e.target.value })}
                />
                <ImageModelSelect
                  id="beat-cast-model"
                  value={characters[selectedCast].imageModel}
                  onChange={(imageModel) => patchCharacter(selectedCast, { imageModel })}
                />
                <label className="story-field" htmlFor="beat-cast-prompt">
                  Prompt
                </label>
                <textarea
                  id="beat-cast-prompt"
                  value={characters[selectedCast].generatePrompt}
                  placeholder="Optional prompt for this sheet"
                  onChange={(e) => patchCharacter(selectedCast, { generatePrompt: e.target.value })}
                />
                <button
                  type="button"
                  className="story-tiny"
                  disabled={sheetBusy}
                  onClick={() => void regenOneSheet(selectedCast)}
                >
                  {sheetBusy ? "Drawing…" : "Regenerate"}
                </button>
                {sheetError ? <p className="form-error">{sheetError}</p> : null}
              </>
            ) : scene && (inspectKind === "start" || inspectKind === "end") ? (
              <>
                <p className="story-kicker">
                  S{selectedScene + 1} of {scenes.length}
                </p>
                <h3>{inspectKind === "start" ? "Start still" : "End still"}</h3>
                <label className="story-field" htmlFor="beat-still-prompt">
                  Prompt
                </label>
                <textarea
                  id="beat-still-prompt"
                  className="story-prompt-edit"
                  value={
                    inspectKind === "start"
                      ? composeStartStillPrompt(scene, characters, filmStyle, story)
                      : composeStillPrompt(scene, characters, filmStyle, story)
                  }
                  onChange={(e) =>
                    patchScene(
                      selectedScene,
                      inspectKind === "start"
                        ? { startPrompt: e.target.value }
                        : { stillPrompt: e.target.value },
                    )
                  }
                />
                <ImageModelSelect
                  id="beat-still-model"
                  value={scene.imageModel}
                  onChange={(imageModel) => patchScene(selectedScene, { imageModel })}
                />
                <button
                  type="button"
                  className="story-tiny"
                  disabled={stillBusy}
                  onClick={() => void regenSceneStill(selectedScene, inspectKind)}
                >
                  {stillBusy ? "Drawing…" : "Regenerate"}
                </button>
                {(inspectKind === "start" ? startErrors[selectedScene] : stillErrors[selectedScene]) ? (
                  <p className="form-error">
                    {inspectKind === "start" ? startErrors[selectedScene] : stillErrors[selectedScene]}
                  </p>
                ) : null}
              </>
            ) : scene ? (
              <>
                <p className="story-kicker">
                  S{selectedScene + 1} of {scenes.length}
                </p>
                <label className="story-field" htmlFor="beat-title">
                  Title
                </label>
                <input
                  id="beat-title"
                  type="text"
                  value={scene.title}
                  onChange={(e) => patchScene(selectedScene, { title: e.target.value })}
                />
                <SceneDurationPicker
                  id="beat-dur"
                  scene={scene}
                  onPatch={(partial) => patchScene(selectedScene, partial)}
                />
                <label className="story-field" htmlFor="beat-setting">
                  Setting
                </label>
                <textarea
                  id="beat-setting"
                  value={scene.setting}
                  onChange={(e) => patchScene(selectedScene, { setting: e.target.value })}
                />
                <label className="story-field" htmlFor="beat-subject">
                  Subject
                </label>
                <textarea
                  id="beat-subject"
                  value={scene.subject}
                  onChange={(e) => patchScene(selectedScene, { subject: e.target.value })}
                />
                <label className="story-field" htmlFor="beat-action">
                  Action
                </label>
                <textarea
                  id="beat-action"
                  value={scene.action}
                  onChange={(e) => patchScene(selectedScene, { action: e.target.value })}
                />
                <label className="story-field" htmlFor="beat-cam">
                  Camera
                </label>
                <textarea
                  id="beat-cam"
                  value={scene.camera_movement}
                  onChange={(e) => patchScene(selectedScene, { camera_movement: e.target.value })}
                />
                <label className="story-field" htmlFor="beat-light">
                  Lighting
                </label>
                <textarea
                  id="beat-light"
                  value={scene.lighting}
                  onChange={(e) => patchScene(selectedScene, { lighting: e.target.value })}
                />
                <label className="story-field" htmlFor="beat-style">
                  Style
                </label>
                <input
                  id="beat-style"
                  type="text"
                  value={scene.style}
                  onChange={(e) => patchScene(selectedScene, { style: e.target.value })}
                />
                <DialogueTurnsEditor
                  turns={dialogueTurnsFromUnknown(scene.dialogue)}
                  onChange={(turns) => patchScene(selectedScene, { dialogue: serializeDialogueJson(turns) })}
                />
                <div className="story-map-tray">
                  <p className="story-field">CREATE mapping</p>
                  <p className="story-hint">
                    This clip sends ≤{FLASH_IMAGE_MAX} images and ≤{FLASH_AUDIO_MAX} audios.
                    Mapped now: {Math.min(mappedImages.length, FLASH_IMAGE_MAX)} images,{" "}
                    {Math.min(mappedAudios.length, FLASH_AUDIO_MAX)} audios.
                  </p>
                  {imageAssets.map((img) => (
                    <div className="story-map-row" key={img.key}>
                      <label>
                        <input
                          type="checkbox"
                          checked={img.selected && (img.sceneIndex === null || img.sceneIndex === selectedScene)}
                          onChange={(e) =>
                            setImageAssets((prev) =>
                              prev.map((item) =>
                                item.key === img.key
                                  ? {
                                      ...item,
                                      selected: e.target.checked,
                                      sceneIndex: e.target.checked ? selectedScene : item.sceneIndex,
                                    }
                                  : item,
                              ),
                            )
                          }
                        />{" "}
                        {fileStem(img.name) || img.name}
                      </label>
                      <select
                        value={img.sceneIndex === null ? "all" : String(img.sceneIndex)}
                        onChange={(e) =>
                          setImageAssets((prev) =>
                            prev.map((item) =>
                              item.key === img.key
                                ? {
                                    ...item,
                                    sceneIndex: e.target.value === "all" ? null : Number(e.target.value),
                                  }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="all">All scenes</option>
                        {scenes.map((s, i) => (
                          <option key={s.title + i} value={String(i)}>
                            S{i + 1}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                  {audioAssets.map((aud) => (
                    <div className="story-map-row" key={aud.key}>
                      <label>
                        <input
                          type="checkbox"
                          checked={aud.selected && (aud.sceneIndex === null || aud.sceneIndex === selectedScene)}
                          onChange={(e) =>
                            setAudioAssets((prev) =>
                              prev.map((item) =>
                                item.key === aud.key
                                  ? {
                                      ...item,
                                      selected: e.target.checked,
                                      sceneIndex: e.target.checked ? selectedScene : item.sceneIndex,
                                    }
                                  : item,
                              ),
                            )
                          }
                        />{" "}
                        {fileStem(aud.name) || aud.name}
                      </label>
                      <select
                        value={aud.sceneIndex === null ? "all" : String(aud.sceneIndex)}
                        onChange={(e) =>
                          setAudioAssets((prev) =>
                            prev.map((item) =>
                              item.key === aud.key
                                ? {
                                    ...item,
                                    sceneIndex: e.target.value === "all" ? null : Number(e.target.value),
                                  }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="all">All scenes</option>
                        {scenes.map((s, i) => (
                          <option key={s.title + i} value={String(i)}>
                            S{i + 1}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <div className="story-insp-actions">
                  {studioMode === "playback" && clip?.status === "ready" && clip.url ? (
                    <>
                      <a className="story-ghost-full" href={clip.url} download target="_blank" rel="noopener noreferrer">
                        Download
                      </a>
                      <button type="button" className="story-ghost-full" onClick={() => regenScene(selectedScene)}>
                        Regenerate this scene
                      </button>
                    </>
                  ) : null}
                  {studioMode === "playback" && clip?.status === "failed" ? (
                    <button
                      type="button"
                      className="story-ghost-full story-danger"
                      onClick={() => resumeFrom(selectedScene)}
                    >
                      Retry this scene
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="story-ghost-full story-danger"
                    disabled={scenes.length <= STORY_SCENE_MIN}
                    onClick={() => dropScene(selectedScene)}
                  >
                    Drop scene
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </aside>
      </div>

      <footer className="story-dock story-glass" aria-label="Timeline">
        <div className="story-dock-h">
          <span>
            {bridgeNote
              ? bridgeNote
              : studioMode === "compose"
                ? "No scenes yet"
                : studioMode === "board"
                  ? stillBusy
                    ? stillNote || "Drawing stills…"
                    : `${scenes.length} scenes`
                  : queueNote || queueLive()}
          </span>
          <button
            ref={addBtnRef}
            type="button"
            className="story-tiny story-add-beat is-scene"
            onClick={() => setAddModal("scene")}
          >
            + Add scene
          </button>
          <button
            type="button"
            className="story-tiny story-add-beat is-clip"
            ref={addClipBtnRef}
            disabled={!allReady}
            title={!allReady ? "Add clip when all clips are ready" : "Add clip"}
            onClick={() => {
              if (!allReady) return;
              setAddModal("clip");
            }}
          >
            + Add clip
          </button>
          {studioMode === "playback" && !allReady ? (
            <span className="story-clip-hint">Add clip when all clips are ready</span>
          ) : null}
        </div>
        <div className="story-empty-dock">Write a topic to add scenes</div>
        <div className="story-track" role="listbox" aria-label="Scene cards">
          {scenes.map((s, index) => {
            const clipSt = clips[index]?.status;
            const drawingThis = drawingScenes.includes(index);
            const st = clipSt ?? (drawingThis ? "generating" : "waiting");
            const showStatus = Boolean(clipSt) || drawingThis;
            const firstRef = (s.i2vRefs ?? [])[0];
            const thumb =
              (firstRef ? mediaPreview(firstRef.id, firstRef.url) : "") ||
              mediaPreview(s.startId, s.startUrl) ||
              mediaPreview(s.bridgeId, s.bridgeUrl) ||
              (characters[0] ? mediaPreview(characters[0].stillId, characters[0].stillUrl) : "");
            const i2v = sceneIsI2V(scenes, index);
            return (
              <button
                key={`card-${index}`}
                type="button"
                role="option"
                draggable={false}
                aria-selected={selectedScene === index}
                className={`story-scene${selectedScene === index ? " is-on" : ""}${st === "generating" && showStatus ? " is-gen" : ""}${!s.setting.trim() ? " is-blank" : ""}`}
                data-drawing={drawingThis ? "true" : undefined}
                onClick={() => {
                  setSelectedScene(index);
                  setBeatFocus("scene");
                  setInspectKind(null);
                  if (isPhoneStory()) setMobilePane("details");
                }}
              >
                {thumb ? <StoryCachedImg className="pic" src={thumb} alt="" /> : <span className="pic" />}
                <span className="meta">
                  <span className="ttl">{s.title.trim() || `Scene ${index + 1}`}</span>
                  <span className="dur">{s.duration_sec}s</span>
                </span>
                <span className="st">
                  <span className="story-shot-tag">{i2v ? "I2V" : "Keyframe"}</span>
                  {showStatus ? (clipSt ? statusLabel(clipSt) : "DRAWING") : null}
                </span>
              </button>
            );
          })}
        </div>
        {studioMode === "playback" && allReady && !mergedUrl ? (
          <ClipTimeline
            scenes={scenes}
            clips={clips}
            order={clipOrder}
            onReorder={setMergeOrder}
            disabled={merging || !allReady}
          />
        ) : null}
        {mergeError ? <p className="form-error">{mergeError}</p> : null}
        {queueRunning ? null : failedIndex >= 0 && generatingIndex < 0 && !merging && !mergedUrl ? (
          <p className="story-hint">
            <button type="button" className="story-tiny" onClick={() => resumeFrom(failedIndex)}>
              Resume from scene {failedIndex + 1}
            </button>
          </p>
        ) : null}
      </footer>

      {addModal ? (
        <AddSceneModal
          kind={addModal}
          scenes={scenes}
          ratio={flashAspect}
          onClose={() => {
            const kind = addModal;
            setAddModal(null);
            queueMicrotask(() => (kind === "clip" ? addClipBtnRef : addBtnRef).current?.focus());
          }}
          onAdd={(form) => {
            const generate = addModal === "clip";
            const kind = addModal;
            setAddModal(null);
            insertBeat(form, generate);
            queueMicrotask(() => (kind === "clip" ? addClipBtnRef : addBtnRef).current?.focus());
          }}
        />
      ) : null}
      {zoom ? <ZoomLightbox src={zoom.src} alt={zoom.alt} onClose={closeZoom} /> : null}
    </div>
  );
});

