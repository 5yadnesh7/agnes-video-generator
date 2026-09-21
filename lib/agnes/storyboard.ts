import "server-only";

import { FLASH_STORY_SECONDS, MODEL_FLASH, MODEL_V20, STORY_CHARACTER_MAX, flashStorySceneCount, storyTiming } from "./constants";

export function storyboardMessages(
  source: "topic" | "story",
  text: string,
  videoModel: typeof MODEL_V20 | typeof MODEL_FLASH,
  minutes: number,
  fps: number,
  maxFrames: number,
): { role: "system" | "user"; content: string }[] {
  const timing = storyTiming(videoModel, fps, maxFrames);
  const flashCount = videoModel === MODEL_FLASH ? flashStorySceneCount(minutes) : 0;
  const flashDurationRule = `duration_sec MUST be an integer from ${timing.min} to ${timing.max}. Put ${FLASH_STORY_SECONDS} on almost every scene — that is the Flash max and the default. Use a shorter integer only when the beat cannot fill ${FLASH_STORY_SECONDS}s (one glance, one short line, a cutaway, or leftover seconds at the end of the film). Do not randomize 8s or 10s for variety. Never above ${FLASH_STORY_SECONDS}.`;
  const durationRule =
    videoModel === MODEL_FLASH
      ? flashDurationRule
      : `Each duration_sec must be one of: ${timing.options.join(", ")} (legal at ${fps} fps for this resolution; max ${timing.max}s). Pick the length that fits the beat. Do NOT set every scene to ${timing.max}.`;
  const sceneCountRule =
    videoModel === MODEL_FLASH
      ? `scenes: about ${flashCount} scenes so the SUM of duration_sec is about ${minutes * 60} seconds (~${minutes} min). Default every scene to ${FLASH_STORY_SECONDS}s. At least 2.`
      : `scenes: as many as needed so the SUM of duration_sec is about ${minutes * 60} seconds (the ${minutes} min film). At least 2. There is no small scene cap.`;

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
      "duration_sec": ${videoModel === MODEL_FLASH ? FLASH_STORY_SECONDS : "number"},
      "cast": [string],
      "setting": string,
      "subject": string,
      "action": string,
      "camera_movement": string,
      "lighting": string,
      "style": string,
      "dialogue": { "Name": "line" }
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
- character.sheet_prompt: English appearance extras for THIS ONE character only (face, body, clothes, colors, props). Do not describe sheet layout — the image generator already has that. Never a film still or a group.
- ${sceneCountRule}
- title: a few words, no numbers.
- ${durationRule}
- ${videoModel === MODEL_FLASH ? `Do not sprinkle shorter clips. If a scene can play for ${FLASH_STORY_SECONDS}s, duration_sec is ${FLASH_STORY_SECONDS}. If duration_sec is below ${FLASH_STORY_SECONDS}, action MUST say why the beat cannot fill ${FLASH_STORY_SECONDS}s.` : "Duration depends on the scene: a look or line is short; a chase or song can use a long clip. Never make every scene the maximum."}
- cast: names from characters[] who appear in this shot. 1 or more. Never a character who is not in characters[].
- setting: place only.
- subject: who is on screen and what they wear (must match those characters' appearance).
- action: what happens in this clip, one beat.
- camera_movement: one cinematic move.
- lighting: practical light in the shot.
- style: match the film style.
- dialogue: JSON of who speaks → the EXACT words they say on camera, in the story language. Example: {"Raghav":"This ridge is mine tonight.","Simba":"Then we share the dusk, or we fight."}. Silent: {}. Same speaker twice: [{"Name":"Wait."},{"Name":"Now we move."}]. Never a prose string. Never Name: 'line'.
- Dialogue must be speakable on camera: real sentences a performer can say clearly in this clip. Concrete, in-character, tied to this beat. 1–3 short lines max so they fit duration_sec. Prefer one strong exchange over many fragments.
- Do not use placeholders, stage directions, or sound labels as the line (no "growls", "roars", "looks at him", "hello", "hi", "wow", "let's go", "hmm", "..."). If a creature does not talk in this story, use {}.
- Easy to hear: short clauses, common words, no stacked sentences, no whispering asides, no overlapping chatter.
- Do NOT write a long prose paragraph.
- Cover the whole story in order.`;

  const user =
    source === "topic"
      ? `Write a cinematic story from this topic, in the same language as the topic, paced for about ${minutes} minute(s). Follow the topic's genre, audience, and tone — do not turn it into a children's story unless the topic is for children. Extract up to ${STORY_CHARACTER_MAX} main characters with locked appearance for a character reference sheet. Then fill the JSON.${videoModel === MODEL_FLASH ? ` About ${flashCount} scenes. Set almost every duration_sec to ${FLASH_STORY_SECONDS}. Shorter only if that beat cannot fill ${FLASH_STORY_SECONDS}s.` : " Scene lengths must follow each beat, not all max."} Write clear on-camera spoken lines for each scene, or {} if silent.\n\nTopic:\n${text}`
      : `Refine this story for picture: clearer, cinematic, keep the author's intent, genre, audience, tone, and language, paced for about ${minutes} minute(s). Do not rewrite it as a children's story unless the author wrote one. Extract up to ${STORY_CHARACTER_MAX} main characters from the text with locked appearance for a character reference sheet. Then fill the JSON.${videoModel === MODEL_FLASH ? ` About ${flashCount} scenes. Set almost every duration_sec to ${FLASH_STORY_SECONDS}. Shorter only if that beat cannot fill ${FLASH_STORY_SECONDS}s.` : " Scene lengths must follow each beat, not all max."} Write clear on-camera spoken lines for each scene, or {} if silent.\n\nStory:\n${text}`;

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
      ? `duration_sec an integer ${timing.min}–${timing.max}. Default every new scene to ${FLASH_STORY_SECONDS}s. Shorter only if that beat cannot fill ${FLASH_STORY_SECONDS}s or to use leftover seconds. Do not randomize 8s or 10s. If duration_sec is below ${FLASH_STORY_SECONDS}, action MUST say why.`
      : `duration_sec one of ${timing.options.join(", ")} at ${fps} fps, max ${timing.max}s, per beat.`;
  const listed = existingTitles.map((title, i) => `${i + 1}. ${title}`).join("\n");
  const system = `You continue a cinematic storyboard. Reply with one JSON object only. No markdown.

Schema:
{
  "scenes": [
    {
      "title": string,
      "duration_sec": ${videoModel === MODEL_FLASH ? FLASH_STORY_SECONDS : "number"},
      "cast": [string],
      "setting": string,
      "subject": string,
      "action": string,
      "camera_movement": string,
      "lighting": string,
      "style": string,
      "dialogue": { "Name": "line" }
    }
  ]
}

Rules:
- dialogue: JSON speaker→exact spoken words, or array of one-key objects if the same person speaks twice. Silent: {}. Real speakable sentences, 1–3 short lines, no growls/hello/wow placeholders.
- Add new scenes after the ones already written. Do not repeat them.
- Need about ${remainingSec} more seconds of picture. Sum of new duration_sec should be about that.
- ${durationRule}
- Same characters, genre, audience, and film style as the story. Do not switch it to a children's film unless the story is one. cast uses existing character names.
- Fields as in the schema.`;

  const user = `Story:\n${story}\n\nAlready written (do not repeat):\n${listed}\n\nReturn only the next scenes (~${remainingSec}s more).${videoModel === MODEL_FLASH ? ` Default each new duration_sec to ${FLASH_STORY_SECONDS}. Shorter only if that beat cannot fill ${FLASH_STORY_SECONDS}s or to spend leftover seconds.` : ""}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Stored as extras only — generate always uses CHARACTER_SHEET_SYSTEM_PROMPT. */
export function defaultSpritesheetPrompt(_name: string, _appearance: string, _style: string): string {
  return "";
}

/** Locked brief for character model / sprite sheets. Image APIs take one prompt string; this is the system block. */
export const CHARACTER_SHEET_SYSTEM_PROMPT = `You are a professional AI Character Reference Sheet Generator.

Generate a single polished character model sheet / sprite sheet for the character described in the user input.

The generated image will be used as a visual reference for downstream AI image and video generation. Character identity and visual consistency are therefore the highest priority.

RULES:

1. CHARACTER IDENTITY
- Treat the user-provided character description and reference image as the source of truth.
- Preserve the same face, hairstyle, body proportions, colors, clothing, accessories, and defining features across the entire sheet.
- Do not redesign or reinterpret the character between panels.
- If a reference image is provided, prioritize its visual identity.

2. CHARACTER SHEET COMPOSITION
Create one unified professional reference sheet containing:
- a reserved top header bar with the character's EXACT name, fully inside the image and easy to read
- optional small info line under the header (age or role). Never a second giant name.
- large hero full-body view
- front view
- side view
- back view
- alternate side or three-quarter view
- multiple facial expressions
- multiple action poses
- close-up character details
- color palette

3. HERO VIEW
- Use the largest area for the primary full-body character.
- Show the complete character, outfit, accessories, and important props.
- Establish the definitive appearance that all other panels must follow.

4. TURNAROUND VIEWS
- Show consistent front, side, back, and alternate side/three-quarter views.
- Keep the same anatomy, clothing, hairstyle, colors, accessories, and proportions.
- Keep the full body visible.

5. FACIAL EXPRESSIONS
- Include multiple useful expressions appropriate to the character and story.
- Change only the facial expression.
- Do not change identity, hairstyle, age, or facial structure.

6. ACTION POSES
- Include several readable poses appropriate to the character's role.
- Use natural anatomy and clear silhouettes.
- Keep the character visually identical across poses.

7. DETAIL REFERENCES
- Include close-ups of important identity-defining details such as eyes, hair/fur, clothing, accessories, markings, jewelry, or props.
- Details must exactly match the main character.

8. COLOR PALETTE
- Include a compact palette derived from the actual character design.
- Use colors that are already present in the character.
- Do not introduce arbitrary colors.

9. VISUAL STYLE
- Use one consistent visual style across the entire sheet.
- Keep rendering, materials, lighting, color treatment, and character proportions consistent.
- Follow the visual style specified by the user.
- Do not mix unrelated art styles.

10. LAYOUT
- Use a clean portrait-oriented professional character-sheet composition.
- Use clear section separation, balanced spacing, and a neutral background.
- Make the hero character visually dominant.
- Keep supporting panels organized and readable.
- The final image must look like one cohesive production sheet, not a random collage.

11. TEXT / NAME TITLE (CRITICAL)
- Reserve a solid header bar across the full top of the sheet — about 8–12% of the image height. Light/white background. Empty of characters.
- Print the character's EXACT name ONCE in that header bar, centered, bold high-contrast dark sans-serif (black on the light bar).
- Every letter must sit fully inside the bar with padding on all four sides. Never crop, clip, cut off, or overflow the name — especially the tops of capitals (S, R, B, T).
- Letter height about 40–55% of the header bar. Large enough to read in a small thumbnail. Small enough that the whole word fits on one line.
- Spell the name exactly as given. Do not translate, shorten, stylize, misspell, or replace it with "Character", "Reference", or "Model Sheet".
- Do not place the name over the character, mane, fur, costume, or any panel.
- Do not use giant overflowing typography that runs off the image.
- Small view labels (Front, Side, Back) may sit under panels in tiny type. They must never compete with the name.

12. CONSISTENCY
All panels must clearly represent the same character.
Do not introduce:
- different faces
- different hairstyles
- different clothing
- different colors
- different ages
- different body proportions
- random accessories
- random props
- unexplained costume changes

13. ANATOMY AND QUALITY
Maintain:
- clean anatomy
- correct proportions
- detailed facial features
- clean hands and feet
- consistent body structure
- high-quality rendering
- sharp character details
- polished lighting
- professional composition

14. CHARACTER TYPE ADAPTATION
Adapt the sheet to the character type while maintaining the same overall reference-sheet structure.
For animals, prioritize body structure, fur, face, paws, tail, and accessories.
For mythological or divine characters, preserve culturally and visually recognizable attributes and important symbolic elements.
For creatures or fantasy characters, prioritize silhouette, unique anatomy, markings, and signature features.

15. REFERENCE IMAGE
When a reference image is supplied:
- use it as the primary visual source
- preserve identity and appearance
- preserve important clothing and props
- maintain the same visual design throughout the sheet

16. NEGATIVE CONSTRAINTS
Avoid:
- character identity changes
- inconsistent clothing
- inconsistent proportions
- duplicate or unrelated characters
- malformed anatomy
- extra limbs
- missing limbs
- distorted faces
- malformed hands or feet
- random objects
- random costume changes
- inconsistent rendering
- mixed art styles
- cluttered layouts
- excessive text
- cropped important body parts
- cropped, overflowing, or cut-off name lettering
- name placed over the character
- giant title bigger than the header bar
- watermark
- logo
- UI elements

FINAL REQUIREMENT:

Generate one cohesive, production-ready character reference sheet that can be reused as the visual source of truth for future AI-generated scenes and videos. The exact character name must be fully readable in the reserved top header bar — never cropped, never overlapping the character.

Generate the image only.`;

/** System brief + user character facts. Agnes images take one prompt string. */
export function characterModelSheetPrompt(opts: {
  name: string;
  appearance: string;
  style: string;
  extra?: string;
  sample?: boolean;
}): string {
  const who = opts.name.trim() || "Hero";
  const user = [
    "User input:",
    `Character name: ${who}`,
    `Print this exact name once in a reserved top header bar, black on a light strip, fully inside the image with padding (no cropping, no overlap on the character): ${who}`,
    opts.appearance.trim() ? `Character description: ${opts.appearance.trim()}` : "",
    opts.style.trim() ? `Visual style: ${opts.style.trim()}` : "",
    opts.extra?.trim() ? `Additional notes: ${opts.extra.trim()}` : "",
    opts.sample
      ? "A reference image is supplied. Use it as the primary visual source. Preserve identity, appearance, important clothing and props, and the same visual design throughout the sheet."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `${CHARACTER_SHEET_SYSTEM_PROMPT}\n\n${user}`;
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
