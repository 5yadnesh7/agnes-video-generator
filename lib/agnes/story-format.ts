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
    prevEnd?: Pick<StoryShot, "setting" | "subject" | "action">;
    extraPrompt?: string;
  },
): string {
  const { start, end } = sceneTimeRange(durations, index);
  const dialogue = shot.dialogue.trim() || "None.";
  const action = shot.action.trim();
  const lines = [`Scene ${index + 1} — Duration: ${start}–${end} sec`];

  if (keyframes?.hasStart && keyframes.hasEnd) {
    const prev = keyframes.prevEnd;
    lines.push(
      "Continuity: OPEN on the START image (first attached still). That picture is the last frame of the previous scene. First frames must match it — same people, pose, place, framing. Do not cut in on a new angle.",
    );
    if (prev) {
      const bits = [prev.setting.trim(), prev.subject.trim(), prev.action.trim() ? `after: ${prev.action.trim()}` : ""]
        .filter(Boolean)
        .join(". ");
      if (bits) lines.push(`The start image is that previous landing: ${bits}.`);
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
    `Dialogue: ${dialogue}`,
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

const STORY_BRIEF_MAX = 700;

export function clipStoryBrief(story: string, max = STORY_BRIEF_MAX): string {
  const t = story.trim().replace(/\s+/g, " ");
  if (!t) return "";
  if (t.length <= max) return t;
  return `${t.slice(0, max).trim()}…`;
}

export function sceneBridgeStillPrompt(
  scene: Pick<StoryShot, "setting" | "subject" | "action" | "camera_movement" | "lighting" | "style" | "dialogue">,
  characters: StoryCharacterLock[],
  filmStyle: string,
  storyBrief?: string,
): string {
  const who = characters
    .map((c) => `${c.name.trim()}${c.appearance.trim() ? `: ${c.appearance.trim()}` : ""}`)
    .filter((line) => line.trim())
    .join(". ");
  const names = characters.map((c) => c.name.trim()).filter(Boolean);
  const brief = clipStoryBrief(storyBrief ?? "");
  const tone = filmStyle.trim() || scene.style.trim();
  return [
    "One cinematic last-frame still for this film. A single live camera shot from a finished movie beat.",
    "Rules: one frame only. Not a spritesheet, character model sheet, turnaround, pose grid, collage, comic panel, storyboard, split screen, or bible page.",
    "Each named character appears exactly once. No duplicate of the same named character.",
    "No printed names, captions, color palettes, or reference-board chrome.",
    "Follow this story's genre, audience, medium, and tone only. Do not substitute a different genre.",
    brief ? `Story (world and tone to follow): ${brief}` : "",
    "This is where the scene LANDS — the final pose and framing after the action.",
    `Setting: ${scene.setting.trim()}`,
    `Who is on screen: ${scene.subject.trim()}`,
    names.length > 0 ? `Named cast (each once): ${names.join(", ")}` : "",
    `Action that has just finished: ${scene.action.trim()}`,
    scene.camera_movement.trim() ? `Camera: ${scene.camera_movement.trim()}` : "",
    scene.lighting.trim() ? `Lighting: ${scene.lighting.trim()}` : "",
    who ? `Characters must match: ${who}` : "",
    tone ? `Art style: ${tone}` : "",
    "Clear faces, same outfits as described, no text overlay, no watermark.",
  ]
    .filter(Boolean)
    .join(" ");
}

export const SCENE_STILL_RETRY_TAIL =
  "Previous frame failed the still rules. Draw one live movie still only. Each named character once. No duplicates, spritesheet, turnaround, collage, labels, or grid.";

export const SCENE_STILL_MAX_ATTEMPTS = 3;

export function isComposedStillPrompt(text: string): boolean {
  return text.trim().startsWith("One cinematic last-frame still");
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
  "Avoid: spritesheet as the video, pose grid, comic panels, split screen, collage, slideshow of stills, unnamed extra people, duplicate clones, outfit change, extra limbs, warped face, on-screen text, watermark, logo, blurry, low quality.";
