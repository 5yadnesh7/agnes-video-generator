import "server-only";

import { MODEL_FLASH, MODEL_V20, STORY_CHARACTER_MAX, storyTiming } from "./constants";

export function storyboardMessages(
  source: "topic" | "story",
  text: string,
  videoModel: typeof MODEL_V20 | typeof MODEL_FLASH,
  minutes: number,
  fps: number,
  maxFrames: number,
): { role: "system" | "user"; content: string }[] {
  const timing = storyTiming(videoModel, fps, maxFrames);
  const durationRule =
    videoModel === MODEL_FLASH
      ? `Each duration_sec is an integer from ${timing.min} to ${timing.max} matching THAT beat. Short glance near ${timing.min}, long action up to ${timing.max}. Do NOT set every scene to ${timing.max}.`
      : `Each duration_sec must be one of: ${timing.options.join(", ")} (legal at ${fps} fps for this resolution; max ${timing.max}s). Pick the length that fits the beat. Do NOT set every scene to ${timing.max}.`;

  const system = `You are a cinematic storyboard artist. Reply with one JSON object only. No markdown.

Schema:
{
  "story": string,
  "style": string,
  "characters": [
    {
      "name": string,
      "role": string,
      "appearance": string,
      "sheet_prompt": string
    }
  ],
  "scenes": [
    {
      "title": string,
      "duration_sec": number,
      "cast": [string],
      "setting": string,
      "subject": string,
      "action": string,
      "camera_movement": string,
      "lighting": string,
      "style": string,
      "dialogue": string
    }
  ]
}

Rules:
- story: cinematic piece in the SAME LANGUAGE as the user input, paced for about ${minutes} minute(s) on screen. Follow the user's genre, audience, and tone. If they asked for kids, keep it kids. If they asked for adult, thriller, documentary, photoreal, anime, etc., follow that. Do not rewrite it as a children's film unless the input is for children.
- style: one line art direction for the whole film, taken from the user's brief — not assumed children's animation.
- characters: extract the MAIN named people from the story. 1 to ${STORY_CHARACTER_MAX} inclusive. Never more than ${STORY_CHARACTER_MAX}. Skip crowds and unnamed extras.
- Each character is a separate person. Never merge two people into one sheet.
- character.name: short name as in the story.
- character.role: protagonist, ally, antagonist, mentor, etc.
- character.appearance: extracted from the story — age, body, face, hair, clothes, colors, props. Detailed enough to redraw identically. If the story is vague, invent a locked look that fits.
- character.sheet_prompt: English extras for a LABELED character MODEL SHEET of THIS ONE person only. Must say the character's NAME is printed large on the sheet. Layout: hero pose + Turnaround Views (Front/Side/Back, captioned) + Facial Expressions (captioned) + Close-up Details + Key Props + Color Palette. Same face and outfit in every panel. Not a film still, not a group photo, not an unlabeled 3-pose strip. Repeat appearance details.
- scenes: as many as needed so the SUM of duration_sec is about ${minutes * 60} seconds (the ${minutes} min film). At least 2. There is no small scene cap.
- title: a few words, no numbers.
- ${durationRule}
- Duration depends on the scene: a look or line is short; a chase or song can use a long clip. Never make every scene the maximum.
- cast: names from characters[] who appear in this shot. 1 or more. Never a character who is not in characters[].
- setting: place only.
- subject: who is on screen and what they wear (must match those characters' appearance).
- action: what happens in this clip, one beat.
- camera_movement: one cinematic move.
- lighting: practical light in the shot.
- style: match the film style.
- dialogue: in the story language, as Name: 'line' — or the string None.
- Do NOT write a long prose paragraph.
- Cover the whole story in order.`;

  const user =
    source === "topic"
      ? `Write a cinematic story from this topic, in the same language as the topic, paced for about ${minutes} minute(s). Follow the topic's genre, audience, and tone — do not turn it into a children's story unless the topic is for children. Extract up to ${STORY_CHARACTER_MAX} main characters with separate labeled model-sheet extras (name printed on each sheet). Then fill the JSON. Scene lengths must follow each beat, not all max.\n\nTopic:\n${text}`
      : `Refine this story for picture: clearer, cinematic, keep the author's intent, genre, audience, tone, and language, paced for about ${minutes} minute(s). Do not rewrite it as a children's story unless the author wrote one. Extract up to ${STORY_CHARACTER_MAX} main characters from the text with separate labeled model-sheet extras (name printed on each sheet). Then fill the JSON. Scene lengths must follow each beat, not all max.\n\nStory:\n${text}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function storyboardContinueMessages(
  story: string,
  existingTitles: string[],
  remainingSec: number,
  videoModel: typeof MODEL_V20 | typeof MODEL_FLASH,
  fps: number,
  maxFrames: number,
): { role: "system" | "user"; content: string }[] {
  const timing = storyTiming(videoModel, fps, maxFrames);
  const durationRule =
    videoModel === MODEL_FLASH
      ? `duration_sec ${timing.min}–${timing.max} per beat, not all ${timing.max}.`
      : `duration_sec one of ${timing.options.join(", ")} at ${fps} fps, max ${timing.max}s, per beat.`;
  const listed = existingTitles.map((title, i) => `${i + 1}. ${title}`).join("\n");
  const system = `You continue a cinematic storyboard. Reply with one JSON object only. No markdown.

Schema:
{
  "scenes": [
    {
      "title": string,
      "duration_sec": number,
      "cast": [string],
      "setting": string,
      "subject": string,
      "action": string,
      "camera_movement": string,
      "lighting": string,
      "style": string,
      "dialogue": string
    }
  ]
}

Rules:
- Add new scenes after the ones already written. Do not repeat them.
- Need about ${remainingSec} more seconds of picture. Sum of new duration_sec should be about that.
- ${durationRule}
- Same characters, genre, audience, and film style as the story. Do not switch it to a children's film unless the story is one. cast uses existing character names.
- Fields as in the schema.`;

  const user = `Story:\n${story}\n\nAlready written (do not repeat):\n${listed}\n\nReturn only the next scenes (~${remainingSec}s more).`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Stored as extras only — generate always composes the labeled layout. */
export function defaultSpritesheetPrompt(_name: string, _appearance: string, _style: string): string {
  return "";
}

/** Labeled character model sheet — name on the image so video can map identity. */
export function characterModelSheetPrompt(opts: {
  name: string;
  appearance: string;
  style: string;
  extra?: string;
  sample?: boolean;
}): string {
  const who = opts.name.trim() || "Hero";
  const style = opts.style.trim();
  return [
    "Professional CHARACTER MODEL SHEET / character bible page. Not a movie still. Not a group photo. Not a blank 3-pose strip.",
    "Match the film's medium from the art style — live-action, photoreal, anime, illustration, or cartoon only if that is the style. Do not default to a children's cartoon.",
    `ONE character only. Print their name in large, sharp, readable letters on the sheet, exactly as written: "${who}". The name is the identity key.`,
    "Layout like a concept-art reference board:",
    `LEFT: large full-body hero pose of ${who}, clear face, signature outfit. Optional personal setting or companion animal only if it belongs to this character.`,
    "RIGHT, separate labeled panels of the SAME person:",
    "Turnaround Views — Front, Side, Back, other Side — full body, matching face and outfit. Each cell captioned Front / Side / Back.",
    "Facial Expressions — four heads, each captioned (Neutral, Happy, Determined, Worried or what fits).",
    "Close-up Details — face marks, hair, costume textures, important accessories, each captioned.",
    "Key Props that belong to this character only, captioned.",
    "Color Palette — 5–8 swatches sampled from skin, hair, and costume.",
    `Every panel is ${who}. Same face, body, outfit, and colors. Readable English captions.`,
    opts.appearance.trim(),
    style ? `Art style: ${style}` : "",
    opts.extra?.trim() || "",
    opts.sample
      ? `Keep identity, face, body, and outfit from the sample. The labeled sheet is a turnaround bible of that same person named ${who}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function parseStoryboardContent(content: string): unknown {
  let text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }
  return JSON.parse(text) as unknown;
}

export function asNonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
