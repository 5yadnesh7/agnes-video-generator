import {
  cookieApiKey,
  envApiKey,
  overrideFromBody,
  setOverrideCookie,
  clearOverrideCookie,
} from "@/lib/agnes/api-key";
import {
  DEFAULT_FRAME_RATE,
  DEFAULT_V20_RESOLUTION,
  MODEL_FLASH,
  MODEL_V20,
  STORY_CHARACTER_MAX,
  STORY_MAX_TOTAL_SEC,
  STORY_SCENE_HARD_MAX,
  STORY_SCENE_MIN,
  V20_ASPECTS,
  V20_FPS_OPTIONS,
  V20_RESOLUTIONS,
  clampStoryMinutes,
  maxFramesForPixels,
  snapStoryDuration,
  storySceneRange,
  v20Size,
  type V20Fps,
  type V20Resolution,
} from "@/lib/agnes/constants";
import {
  parseStoryboardContent,
  storyboardMessages,
  storyboardContinueMessages,
  defaultSpritesheetPrompt,
  asNonEmpty,
} from "@/lib/agnes/storyboard";
import { isModelId } from "@/lib/agnes/types";
import { chatCompletion } from "@/lib/agnes/upstream";

export const runtime = "nodejs";
export const maxDuration = 300;

const TEXT_MAX = 12_000;
const CONTINUE_MAX = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

function withKeyCookie(res: Response, override: string | null): Response {
  const headers = new Headers(res.headers);
  headers.set("Set-Cookie", override ? setOverrideCookie(override) : clearOverrideCookie());
  return new Response(res.body, { status: res.status, headers });
}

type CharacterOut = {
  name: string;
  role: string;
  appearance: string;
  sheet_prompt: string;
};

type SceneOut = {
  title: string;
  duration_sec: number;
  cast: string[];
  setting: string;
  subject: string;
  action: string;
  camera_movement: string;
  lighting: string;
  style: string;
  dialogue: string;
};

function field(item: Record<string, unknown>, key: string): string {
  return asNonEmpty(item[key]);
}

function shapeCast(raw: unknown, names: string[]): string[] {
  const allowed = new Set(names.map((n) => n.toLowerCase()));
  const out: string[] = [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  for (const item of list) {
    const name = typeof item === "string" ? item.trim() : "";
    if (!name) continue;
    const match = names.find((n) => n.toLowerCase() === name.toLowerCase());
    if (match && !out.includes(match)) out.push(match);
    else if (!allowed.size && !out.includes(name)) out.push(name);
  }
  return out;
}

function shapeCharacters(raw: unknown, style: string): CharacterOut[] {
  const list: unknown[] = [];
  if (Array.isArray(raw)) list.push(...raw);
  else if (isRecord(raw)) list.push(raw);
  const characters: CharacterOut[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isRecord(item)) continue;
    if (characters.length >= STORY_CHARACTER_MAX) break;
    const name = field(item, "name") || `Character ${characters.length + 1}`;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const appearance = field(item, "appearance");
    const sheet =
      field(item, "sheet_prompt") || defaultSpritesheetPrompt(name, appearance, style);
    characters.push({
      name,
      role: field(item, "role") || (characters.length === 0 ? "protagonist" : "supporting"),
      appearance,
      sheet_prompt: sheet,
    });
  }
  return characters;
}

function parseStoryFps(value: unknown): V20Fps {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return (V20_FPS_OPTIONS as readonly number[]).includes(n) ? (n as V20Fps) : DEFAULT_FRAME_RATE;
}

function parseStoryResolution(value: unknown): V20Resolution {
  return typeof value === "string" && (V20_RESOLUTIONS as readonly string[]).includes(value)
    ? (value as V20Resolution)
    : DEFAULT_V20_RESOLUTION;
}

function parseStoryAspect(value: unknown): (typeof V20_ASPECTS)[number] {
  return typeof value === "string" && (V20_ASPECTS as readonly string[]).includes(value)
    ? (value as (typeof V20_ASPECTS)[number])
    : "16:9";
}

function shapeScenes(
  raw: unknown,
  model: typeof MODEL_V20 | typeof MODEL_FLASH,
  names: string[],
  fps: number,
  maxFrames: number,
): SceneOut[] | null {
  if (!Array.isArray(raw)) return null;
  const scenes: SceneOut[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (scenes.length >= STORY_SCENE_HARD_MAX) break;
    const title = field(item, "title") || `Scene ${scenes.length + 1}`;
    const durRaw =
      typeof item.duration_sec === "number"
        ? item.duration_sec
        : typeof item.duration_sec === "string"
          ? Number(item.duration_sec)
          : NaN;
    const blob = field(item, "visual_prompt");
    const cast = shapeCast(item.cast, names);
    scenes.push({
      title,
      duration_sec: snapStoryDuration(Number.isFinite(durRaw) ? durRaw : 5, model, fps, maxFrames),
      cast: cast.length > 0 ? cast : names.slice(0, 1),
      setting: field(item, "setting") || blob,
      subject: field(item, "subject"),
      action: field(item, "action"),
      camera_movement: field(item, "camera_movement"),
      lighting: field(item, "lighting"),
      style: field(item, "style"),
      dialogue: field(item, "dialogue") || "None.",
    });
  }
  return scenes;
}

function scenesTotal(scenes: SceneOut[]): number {
  return scenes.reduce((sum, s) => sum + s.duration_sec, 0);
}

function trimToBudget(
  scenes: SceneOut[],
  model: typeof MODEL_V20 | typeof MODEL_FLASH,
  budgetSec: number,
  fps: number,
  maxFrames: number,
): SceneOut[] {
  const cap = Math.min(STORY_MAX_TOTAL_SEC, Math.max(0, budgetSec));
  const out: SceneOut[] = [];
  let acc = 0;
  for (const scene of scenes) {
    if (acc >= cap) break;
    const room = cap - acc;
    const duration = snapStoryDuration(Math.min(scene.duration_sec, room), model, fps, maxFrames);
    if (duration <= 0 || acc + duration > cap) break;
    out.push({ ...scene, duration_sec: duration });
    acc += duration;
  }
  return out;
}

function chatTimeoutMs(sceneGuess: number): number {
  return Math.min(180_000, 90_000 + sceneGuess * 1_500);
}

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON.");
  }
  if (!isRecord(json)) return jsonError(400, "Invalid JSON.");

  const override = overrideFromBody(json.agnes_api_key);
  const key = override ?? cookieApiKey(request) ?? envApiKey();

  const source = json.source;
  if (source !== "topic" && source !== "story") {
    return jsonError(400, "source must be topic or story.");
  }

  const text = typeof json.text === "string" ? json.text.trim() : "";
  if (!text) {
    return jsonError(400, "Enter a topic or paste a story.");
  }
  if (text.length > TEXT_MAX) {
    return jsonError(400, "Text is too long.");
  }

  if (!isModelId(json.video_model)) {
    return jsonError(400, `video_model must be ${MODEL_V20} or ${MODEL_FLASH}.`);
  }
  const videoModel = json.video_model;
  const minutes = clampStoryMinutes(
    typeof json.target_minutes === "number"
      ? json.target_minutes
      : typeof json.target_minutes === "string"
        ? Number(json.target_minutes)
        : 1,
  );
  const fps = parseStoryFps(json.frame_rate);
  const resolution = parseStoryResolution(json.resolution);
  const aspect = parseStoryAspect(json.aspect_ratio);
  const size = v20Size(resolution, aspect);
  const maxFrames = maxFramesForPixels(size.width, size.height);
  const range = storySceneRange(minutes, videoModel, fps, maxFrames);
  const timeoutMs = chatTimeoutMs(range.max);
  const budget = minutes * 60;

  const chat = await chatCompletion(
    storyboardMessages(source, text, videoModel, minutes, fps, maxFrames),
    key,
    timeoutMs,
  );
  if (!chat.ok) {
    console.info("storyboard: failed");
    return withKeyCookie(jsonError(chat.status, chat.detail), override);
  }

  let parsed: unknown;
  try {
    parsed = parseStoryboardContent(chat.content);
  } catch {
    console.info("storyboard: parse failed");
    return withKeyCookie(
      jsonError(502, "The storyboard was not valid JSON. Retry write storyboard."),
      override,
    );
  }

  if (!isRecord(parsed)) {
    console.info("storyboard: parse failed");
    return withKeyCookie(
      jsonError(502, "The storyboard was not valid JSON. Retry write storyboard."),
      override,
    );
  }

  const story = typeof parsed.story === "string" ? parsed.story.trim() : "";
  if (!story) {
    console.info("storyboard: parse failed");
    return withKeyCookie(
      jsonError(502, "The storyboard had no story text. Retry write storyboard."),
      override,
    );
  }

  const style = asNonEmpty(parsed.style);
  let characters = shapeCharacters(parsed.characters ?? parsed.character, style);
  if (characters.length === 0) {
    characters = [
      {
        name: "Hero",
        role: "protagonist",
        appearance: "",
        sheet_prompt: defaultSpritesheetPrompt("Hero", "", style),
      },
    ];
  }
  const names = characters.map((c) => c.name);

  let scenes = shapeScenes(parsed.scenes, videoModel, names, fps, maxFrames) ?? [];
  let continues = 0;
  while (scenesTotal(scenes) < budget * 0.85 && scenes.length < STORY_SCENE_HARD_MAX && continues < CONTINUE_MAX) {
    continues += 1;
    const remaining = Math.max(1, budget - scenesTotal(scenes));
    const more = await chatCompletion(
      storyboardContinueMessages(
        story,
        scenes.map((s) => s.title),
        remaining,
        videoModel,
        fps,
        maxFrames,
      ),
      key,
      timeoutMs,
    );
    if (!more.ok) {
      console.info("storyboard: continue failed");
      return withKeyCookie(jsonError(more.status, more.detail), override);
    }
    let extraParsed: unknown;
    try {
      extraParsed = parseStoryboardContent(more.content);
    } catch {
      break;
    }
    if (!isRecord(extraParsed)) break;
    const extra = shapeScenes(extraParsed.scenes, videoModel, names, fps, maxFrames);
    if (!extra || extra.length === 0) break;
    scenes = scenes.concat(extra).slice(0, STORY_SCENE_HARD_MAX);
  }

  scenes = trimToBudget(
    scenes.map((s, i) => ({ ...s, title: s.title || `Scene ${i + 1}` })),
    videoModel,
    budget,
    fps,
    maxFrames,
  );

  if (scenes.length < STORY_SCENE_MIN) {
    console.info("storyboard: too few scenes");
    return withKeyCookie(
      jsonError(
        502,
        "The model returned only one scene. Story needs at least two. Retry write storyboard.",
      ),
      override,
    );
  }

  const seed = Math.floor(Math.random() * 2_147_483_646) + 1;

  console.info("storyboard: ok %d scenes %d chars %d min", scenes.length, characters.length, minutes);
  const res = Response.json({
    story,
    style,
    characters,
    seed,
    scenes,
    target_minutes: minutes,
  });
  return withKeyCookie(res, override);
}
