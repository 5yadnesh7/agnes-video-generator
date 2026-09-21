export type StoryShot = {
  title: string;
  duration_sec: number;
  setting: string;
  subject: string;
  action: string;
  camera_movement: string;
  lighting: string;
  style: string;
  dialogue: string;
};

export type DialogueTurn = { speaker: string; line: string };

/** Empty: {}. Unique speakers: {"Strange":"…"}. Same speaker twice: [{"Strange":"a"},{"Strange":"b"}]. */
export function serializeDialogueJson(turns: DialogueTurn[]): string {
  const clean = turns
    .map((t) => ({ speaker: t.speaker.trim(), line: t.line.trim() }))
    .filter((t) => t.speaker || t.line)
    .map((t) => ({ speaker: t.speaker || "Speaker", line: t.line }));
  if (clean.length === 0) return "{}";
  const names = clean.map((t) => t.speaker);
  if (new Set(names).size === names.length) {
    const obj: Record<string, string> = {};
    for (const t of clean) obj[t.speaker] = t.line;
    return JSON.stringify(obj);
  }
  return JSON.stringify(clean.map((t) => ({ [t.speaker]: t.line })));
}

export function dialogueTurnsFromUnknown(raw: unknown): DialogueTurn[] {
  if (raw == null) return [];
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text || /^none\.?$/i.test(text) || text === "{}") return [];
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return dialogueTurnsFromUnknown(JSON.parse(text) as unknown);
      } catch {
        /* legacy Name: 'line' */
      }
    }
    const turns: DialogueTurn[] = [];
    const re = /(?:^|[;\n])\s*([^:\n;]+?)\s*:\s*['"]([^'"]*)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const speaker = m[1].trim();
      const line = m[2].trim();
      if (speaker || line) turns.push({ speaker, line });
    }
    if (turns.length > 0) return turns;
    return [{ speaker: "", line: text }];
  }
  if (Array.isArray(raw)) {
    const turns: DialogueTurn[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.speaker === "string" && typeof rec.line === "string") {
        turns.push({ speaker: rec.speaker, line: rec.line });
        continue;
      }
      const entries = Object.entries(rec).filter(([, v]) => typeof v === "string");
      if (entries.length === 1) turns.push({ speaker: entries[0][0], line: entries[0][1] as string });
    }
    return turns;
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string")
      .map(([speaker, line]) => ({ speaker, line: line as string }));
  }
  return [];
}

export function normalizeDialogueJson(raw: unknown): string {
  return serializeDialogueJson(dialogueTurnsFromUnknown(raw));
}

/** Video-model copy: exact spoken words, not a JSON blob. */
export function spokenDialogueBlock(raw: unknown): string {
  const turns = dialogueTurnsFromUnknown(raw).filter((t) => t.line.trim());
  if (turns.length === 0) {
    return "Spoken dialogue: none. Do not invent lines. Ambient sound only. Mouths are not talking.";
  }
  const spoken = turns.map((t) => {
    const who = t.speaker.trim() || "Speaker";
    const line = t.line.trim().replace(/^["“”']+|["“”']+$/g, "");
    return `${who} speaks these exact words, clearly and fully, at a natural pace: "${line}"`;
  });
  return [
    "Spoken dialogue (required):",
    ...spoken,
    "The named character must say that line out loud. Lip-sync the words. Full syllables — not a mumble, growl, roar, or whisper that hides the line. No subtitles, captions, or narrator. No extra ad-lib lines.",
  ].join("\n");
}

export type StoryCharacterLock = {
  name: string;
  appearance: string;
};

export function sceneTimeRange(durations: number[], index: number): { start: number; end: number } {
  let start = 0;
  for (let i = 0; i < index; i += 1) start += durations[i] ?? 0;
  const len = durations[index] ?? 0;
  return { start, end: start + len };
}

export function isComposedShotPrompt(text: string, index: number): boolean {
  return text.trim().startsWith(`Scene ${index + 1} — Duration:`);
}

export function applyShotDurationLine(prompt: string, index: number, durations: number[]): string {
  const { start, end } = sceneTimeRange(durations, index);
  const line = `Scene ${index + 1} — Duration: ${start}–${end} sec`;
  const next = prompt.replace(/^Scene \d+ — Duration: [^\n]*/m, line);
  return next === prompt && !prompt.startsWith("Scene ") ? `${line}\n${prompt}` : next;
}

export function formatStoryShot(
  index: number,
  durations: number[],
  shot: Pick<
    StoryShot,
    "setting" | "subject" | "action" | "camera_movement" | "lighting" | "style" | "dialogue"
  >,
  characters: StoryCharacterLock[],
  keyframes?: {
    hasStart: boolean;
    hasEnd: boolean;
    startIsGenerated?: boolean;
    prevEnd?: Pick<StoryShot, "setting" | "subject" | "action">;
    extraPrompt?: string;
  },
): string {
  const { start, end } = sceneTimeRange(durations, index);
  const action = shot.action.trim();
  const lines = [`Scene ${index + 1} — Duration: ${start}–${end} sec`];

  if (keyframes?.hasStart && keyframes.hasEnd) {
    const prev = keyframes.prevEnd;
    if (keyframes.startIsGenerated) {
      lines.push(
        "Continuity: OPEN on the START image (first attached still). That picture is the opening of this scene after the previous image-to-video beat. First frames must match it — same people, pose, place, framing.",
      );
    } else {
      lines.push(
        "Continuity: OPEN on the START image (first attached still). That picture is the last frame of the previous scene. First frames must match it — same people, pose, place, framing. Do not cut in on a new angle.",
      );
      if (prev) {
        const bits = [prev.setting.trim(), prev.subject.trim(), prev.action.trim() ? `after: ${prev.action.trim()}` : ""]
          .filter(Boolean)
          .join(". ");
        if (bits) lines.push(`The start image is that previous landing: ${bits}.`);
      }
    }
    lines.push(
      `Then continue from that exact picture into this scene's action: ${action}`,
      "LAND on the END image (last attached still). That still is the first frame of the next scene. One live shot between the two pictures — not a cut, not a slideshow.",
    );
  } else if (keyframes?.hasEnd) {
    lines.push(
      `Action: ${action}`,
      "LAND on the END image (attached still). That picture is the first frame of the next scene.",
    );
  } else {
    lines.push(`Action: ${action}`);
  }

  lines.push(
    `Scene: ${shot.setting.trim()}`,
    `Subject: ${shot.subject.trim()}`,
    `Camera_Movement: ${shot.camera_movement.trim()}`,
    `Lighting: ${shot.lighting.trim()}`,
    `Style: ${shot.style.trim()}`,
    spokenDialogueBlock(shot.dialogue),
  );
  const extra = keyframes?.extraPrompt?.trim();
  if (extra) lines.push(`Director note: ${extra}`);
  if (characters.length > 0) {
    lines.push(
      "Identity lock: Each named person matches their own labeled character model sheet — the large printed NAME on that sheet is who they are. Same face, body, outfit, and colors. The video is one live cinematic shot — not the model sheet, not a pose grid, not a collage, not multiple panels.",
    );
    for (const c of characters) {
      const look = c.appearance.trim();
      lines.push(
        `Character ${c.name.trim()}: ${look || "match the labeled model sheet"}. Same face, body, outfit, and colors as the person named ${c.name.trim()} on that sheet.`,
      );
    }
  }
  return lines.join("\n");
}

function castKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Scene 1, and any later beat that introduces a named character who has not
 * appeared yet, is image-to-video from character sheets — no generated start/end stills.
 */
export type ShotMode = "i2v" | "keyframe";

export function isShotMode(value: unknown): value is ShotMode {
  return value === "i2v" || value === "keyframe";
}

export function sceneUsesSheetI2V(scenes: { cast?: string[] }[], index: number): boolean {
  if (index <= 0) return true;
  const seen = new Set<string>();
  for (let i = 0; i < index; i += 1) {
    for (const name of scenes[i]?.cast ?? []) {
      const key = castKey(name);
      if (key) seen.add(key);
    }
  }
  const mine = (scenes[index]?.cast ?? []).map(castKey).filter(Boolean);
  if (mine.length === 0) return false;
  if (seen.size === 0) return true;
  return mine.some((name) => !seen.has(name));
}

/** Explicit shotMode wins; missing mode falls back to cast inference. */
export function sceneIsI2V(
  scenes: { shotMode?: string; cast?: string[] }[],
  index: number,
): boolean {
  const mode = scenes[index]?.shotMode;
  if (mode === "i2v") return true;
  if (mode === "keyframe") return false;
  return sceneUsesSheetI2V(scenes, index);
}

/**
 * Keyframe scene needs its own opening still when the previous shot is I2V
 * (no end frame to inherit), or when it is the first scene.
 * Otherwise start of N is the end still of N-1.
 */
export function sceneNeedsGeneratedStart(
  scenes: { shotMode?: string; cast?: string[] }[],
  index: number,
): boolean {
  if (sceneIsI2V(scenes, index)) return false;
  if (index <= 0) return true;
  return sceneIsI2V(scenes, index - 1);
}

const STORY_BRIEF_MAX = 700;

export function clipStoryBrief(story: string, max = STORY_BRIEF_MAX): string {
  const t = story.trim().replace(/\s+/g, " ");
  if (!t) return "";
  if (t.length <= max) return t;
  return `${t.slice(0, max).trim()}…`;
}

type StillScene = Pick<
  StoryShot,
  "title" | "setting" | "subject" | "action" | "camera_movement" | "lighting" | "style" | "dialogue"
>;

function sceneStillContext(
  scene: StillScene,
  characters: StoryCharacterLock[],
  filmStyle: string,
  storyBrief?: string,
): string[] {
  const who = characters
    .map((c) => `${c.name.trim()}${c.appearance.trim() ? `: ${c.appearance.trim()}` : ""}`)
    .filter((line) => line.trim())
    .join(". ");
  const names = characters.map((c) => c.name.trim()).filter(Boolean);
  const brief = clipStoryBrief(storyBrief ?? "");
  const tone = filmStyle.trim() || scene.style.trim();
  const dialogue = scene.dialogue.trim();
  return [
    scene.title.trim() ? `Scene title: ${scene.title.trim()}` : "",
    brief ? `Story (world and tone to follow): ${brief}` : "",
    `Setting: ${scene.setting.trim()}`,
    `Who is on screen: ${scene.subject.trim()}`,
    names.length > 0 ? `Named cast (each once): ${names.join(", ")}` : "",
    `Action in this clip: ${scene.action.trim()}`,
    scene.camera_movement.trim() ? `Camera move through the clip: ${scene.camera_movement.trim()}` : "",
    scene.lighting.trim() ? `Lighting: ${scene.lighting.trim()}` : "",
    dialogue && dialogue !== "{}"
      ? `If a mouth is open mid-speech, it matches: ${dialogueTurnsFromUnknown(dialogue)
          .filter((t) => t.line.trim())
          .map((t) => `${t.speaker.trim()}: "${t.line.trim()}"`)
          .join(" / ")}`
      : "",
    who ? `Characters must match: ${who}` : "",
    tone ? `Art style: ${tone}` : "",
    "Rules: one live movie frame only. Not a spritesheet, character model sheet, turnaround, pose grid, collage, comic panel, storyboard, split screen, or bible page.",
    "Each named character appears exactly once. No duplicate of the same named character.",
    "No printed names, captions, color palettes, or reference-board chrome.",
    "Follow this story's genre, audience, medium, and tone only. Do not substitute a different genre.",
    "Clear faces, same outfits as described, no text overlay, no watermark.",
  ];
}

export function sceneBridgeStillPrompt(
  scene: StillScene,
  characters: StoryCharacterLock[],
  filmStyle: string,
  storyBrief?: string,
): string {
  return [
    "TASK: Generate the END KEYFRAME only — the last live camera frame of this scene.",
    "Use the same scene below. This is AFTER the action has finished: landed poses, new blocking, later camera moment.",
    "Must be clearly different from the opening of this same scene. Do not redraw the start pose. Do not freeze the beat mid-action.",
    ...sceneStillContext(scene, characters, filmStyle, storyBrief),
    "END FRAME: the action has just completed. Bodies, eyelines, and framing show the result of the beat.",
  ]
    .filter(Boolean)
    .join(" ");
}

export const SCENE_STILL_RETRY_TAIL =
  "Previous frame failed the still rules. Draw one live movie still only. Each named character once. No duplicates, spritesheet, turnaround, collage, labels, or grid.";

export const SCENE_STILL_MAX_ATTEMPTS = 3;

export function sceneStartStillPrompt(
  scene: StillScene,
  characters: StoryCharacterLock[],
  filmStyle: string,
  storyBrief?: string,
): string {
  return [
    "TASK: Generate the START KEYFRAME only — the first live camera frame of this scene.",
    "Use the same scene below. This is BEFORE the action plays: starting poses, earlier blocking, opening camera.",
    "Do not draw the landing/end pose. Do not skip ahead to the finished beat.",
    ...sceneStillContext(scene, characters, filmStyle, storyBrief),
    "START FRAME: the action is about to begin. Bodies wound up or approaching, not finished.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function isComposedStillPrompt(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith("TASK: Generate the START KEYFRAME") ||
    t.startsWith("TASK: Generate the END KEYFRAME") ||
    t.startsWith("One cinematic last-frame still") ||
    t.startsWith("One cinematic opening-frame still")
  );
}

export function sceneStillJudgeSystem(): string {
  return `You are a strict stills QC judge for a film pipeline. Reply with one JSON object only. No markdown.
Schema: { "pass": boolean, "reasons": string[] }
FAIL (pass=false) if ANY rule is broken:
- more than one frame in the image (spritesheet, model sheet, bible, turnaround, pose grid, collage, comic panels, storyboard, split screen)
- printed name labels, captions, color palette swatches, reference-board chrome
- the same named character appears more than once
- a named character from the provided cast is missing
- extra unnamed foreground people who are not extras in the far background
PASS (pass=true) only if it is one live cinematic movie frame and each named character in the provided cast appears exactly once. Distinct named characters in the same frame is allowed.
reasons: short English phrases, empty if pass.`;
}

export function parseStillVerdict(content: string): { pass: boolean; reasons: string[] } {
  let text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const rec = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (typeof rec === "object" && rec !== null) {
        const pass = (rec as { pass?: unknown }).pass === true;
        const raw = (rec as { reasons?: unknown }).reasons;
        const reasons: string[] = [];
        if (Array.isArray(raw)) {
          for (const item of raw) {
            if (typeof item === "string" && item.trim()) reasons.push(item.trim());
          }
        }
        return { pass, reasons };
      }
    } catch {
      /* fall through */
    }
  }
  const lower = text.toLowerCase();
  if (lower.includes('"pass": true') || lower.includes('"pass":true')) {
    return { pass: true, reasons: [] };
  }
  return { pass: false, reasons: [text.slice(0, 180) || "Failed gold standard."] };
}

export const FLASH_STORY_NEGATIVE_LINE =
  "Avoid: spritesheet as the video, pose grid, comic panels, split screen, collage, slideshow of stills, unnamed extra people, duplicate clones, outfit change, extra limbs, warped face, on-screen text, subtitles, captions, unintelligible speech, mumbled dialogue, silent mouths when a line is written, watermark, logo, blurry, low quality.";
