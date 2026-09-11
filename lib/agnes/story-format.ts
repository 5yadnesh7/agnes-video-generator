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
  const brief = clipStoryBrief(storyBrief ?? "");
  const tone = filmStyle.trim() || scene.style.trim();
  return [
    "One cinematic last-frame still for this film. A single live shot, not a spritesheet, not a collage, not comic panels, not a storyboard grid.",
    "Match this story's genre, audience, and tone. Do not make it a children's film unless the story is for children.",
    brief ? `Story (follow this world and tone): ${brief}` : "",
    "This is where the scene LANDS — the final pose and framing after the action.",
    `Setting: ${scene.setting.trim()}`,
    `Who is on screen: ${scene.subject.trim()}`,
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

export const FLASH_STORY_NEGATIVE_LINE =
  "Avoid: spritesheet as the video, pose grid, comic panels, split screen, collage, slideshow of stills, unnamed extra people, duplicate clones, outfit change, extra limbs, warped face, on-screen text, watermark, logo, blurry, low quality.";
