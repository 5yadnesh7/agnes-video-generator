"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type FormEvent, type SetStateAction } from "react";

import { StoryWorkbench, type StoryWorkbenchHandle } from "@/components/story-workbench";
import {
  allowedV20Durations,
  clampV20Duration,
  DEFAULT_DURATION_SEC,
  DEFAULT_FRAME_RATE,
  DEFAULT_V20_NEGATIVE_PROMPT,
  DEFAULT_V20_RESOLUTION,
  FLASH_ASPECT_RATIOS,
  FLASH_AUDIO_MAX,
  FLASH_DEFAULT_SECONDS,
  FLASH_IMAGE_MAX,
  FLASH_SECONDS_MAX,
  FLASH_SECONDS_MIN,
  framesForDuration,
  MODEL_FLASH,
  MODEL_V20,
  THEME_STORAGE_KEY,
  V20_ASPECTS,
  V20_FPS_OPTIONS,
  V20_I2V_MAX,
  V20_KEYFRAME_MAX,
  V20_KEYFRAME_MIN,
  V20_MAX_FRAMES,
  V20_REFERENCE_HINT,
  V20_RESOLUTIONS,
  v20Size,
  type V20Duration,
  type V20Fps,
  type V20Resolution,
} from "@/lib/agnes/constants";
import {
  isAgnesMediaRef,
  isJobStatus,
  isPublicHttpsUrl,
  type CreateRequest,
  type CreateSuccess,
  type FlashAspectRatio,
  type FlashMode,
  type JobStatus,
  type ModelId,
  type StatusSuccess,
  type ThemeId,
  type V20FrameSizeId,
  type V20Mode,
} from "@/lib/agnes/types";

const ARCH_HELPER =
  "Choosing a file stores it here; no PUBLIC_APP_URL needed locally. Paste a public https:// URL still works.";
const PASTE_HELPER =
  "Use this if the file is already on a public host. Agnes fetches it. This app does not send the bytes to Agnes.";
const IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";
const AUDIO_ACCEPT = "audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav,.m4a,.aac,.mp4";
const MP4_HINT =
  "If the player fails, the file host may be unreachable on this network. Try another network or DNS. Do not disable TLS.";
const KEY_BANNER = "Add an Agnes API key in the header, or set AGNES_API_KEY in .env and restart.";

type FieldErrors = Partial<Record<string, string>>;

type JobView =
  | { phase: "idle" }
  | { phase: "posting" }
  | {
      phase: "generating";
      videoId: string;
      model: ModelId;
      status: JobStatus | null;
      progress?: number;
    }
  | { phase: "completed"; videoId: string; url: string | null }
  | { phase: "failed"; videoId?: string; message: string }
  | {
      phase: "timeout";
      videoId: string;
      model: ModelId;
      status?: JobStatus;
      progress?: number;
    }
  | { phase: "poll_error"; videoId: string; model: ModelId; message: string };

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

function parseStatusBody(body: unknown): StatusSuccess | null {
  if (typeof body !== "object" || body === null) return null;
  const rec = body as Record<string, unknown>;
  if (!isJobStatus(rec.status)) return null;
  const metadata =
    rec.metadata &&
    typeof rec.metadata === "object" &&
    rec.metadata !== null &&
    typeof (rec.metadata as { url?: unknown }).url === "string"
      ? { url: (rec.metadata as { url: string }).url }
      : null;
  const error =
    rec.error &&
    typeof rec.error === "object" &&
    rec.error !== null &&
    typeof (rec.error as { message?: unknown }).message === "string"
      ? { message: (rec.error as { message: string }).message }
      : null;
  return {
    status: rec.status,
    metadata,
    error,
    video_id: typeof rec.video_id === "string" ? rec.video_id : undefined,
    progress: typeof rec.progress === "number" ? rec.progress : undefined,
  };
}

function parseEventPayload(raw: string): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(raw);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    /* ignore malformed event bodies */
  }
  return null;
}

type StatusFetch =
  | { ok: true; data: StatusSuccess }
  | { ok: false; kind: "http"; status: number; detail: string }
  | { ok: false; kind: "network" };

async function fetchStatus(
  videoId: string,
  model: ModelId,
  signal: AbortSignal,
): Promise<StatusFetch> {
  try {
    const params = new URLSearchParams({
      video_id: videoId,
      model_name: model,
    });
    const res = await fetch(`/api/videos/status?${params.toString()}`, { signal });
    if (!res.ok) {
      return { ok: false, kind: "http", status: res.status, detail: await readDetail(res) };
    }
    const body: unknown = await res.json();
    const data = parseStatusBody(body);
    if (!data) {
      return {
        ok: false,
        kind: "http",
        status: 502,
        detail: "Agnes is unavailable or the job was not found.",
      };
    }
    return { ok: true, data };
  } catch (err) {
    if (isAbort(err)) throw err;
    return { ok: false, kind: "network" };
  }
}

function applyTheme(next: ThemeId) {
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new Event("agnes-theme"));
}

function subscribeTheme(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener("agnes-theme", onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener("agnes-theme", onStoreChange);
  };
}

function getThemeSnapshot(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
  } catch {
    /* ignore */
  }
  return "light";
}

function getThemeServerSnapshot(): ThemeId {
  return "light";
}

function optionalInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return undefined;
  return n;
}

function isAcceptedMediaUrl(value: string): boolean {
  return isPublicHttpsUrl(value) || isAgnesMediaRef(value);
}

async function uploadMediaFile(file: File): Promise<{ ok: true; url: string } | { ok: false; detail: string }> {
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/videos/media", { method: "POST", body: fd });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    const detailFromBody =
      typeof parsed === "object" &&
      parsed !== null &&
      "detail" in parsed &&
      typeof (parsed as { detail: unknown }).detail === "string"
        ? (parsed as { detail: string }).detail
        : null;
    if (!res.ok) {
      return {
        ok: false,
        detail: detailFromBody ?? "Could not store this file. Try again, or paste a public https:// URL.",
      };
    }
    const url =
      typeof parsed === "object" &&
      parsed !== null &&
      "url" in parsed &&
      typeof (parsed as { url: unknown }).url === "string"
        ? (parsed as { url: string }).url
        : "";
    if (!url || !isAcceptedMediaUrl(url)) {
      return { ok: false, detail: "Could not store this file. Try again, or paste a public https:// URL." };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, detail: "Could not store this file. Try again, or paste a public https:// URL." };
  }
}

function overflowCopy(kind: "image" | "audio" | "keyframe", remaining: number, kept: number, dropped: number): string {
  const unit = kind === "audio" ? "audio" : kind === "keyframe" ? "keyframe" : "image";
  const slots = remaining === 1 ? "slot" : "slots";
  return `Only ${remaining} ${unit} ${slots} left. Added the first ${kept}; ${dropped} not added.`;
}

type MediaItem = {
  key: string;
  url: string;
  label: string;
  storing: boolean;
  error?: string;
};

type SingleSlot = {
  url: string;
  fileName: string;
  paste: string;
  storing: boolean;
  fileKey: number;
};

const EMPTY_SLOT: SingleSlot = { url: "", fileName: "", paste: "", storing: false, fileKey: 0 };

function clearFieldError(prev: FieldErrors, id: string): FieldErrors {
  if (!prev[id]) return prev;
  const next = { ...prev };
  delete next[id];
  return next;
}

function SingleMediaSlot({
  fileId,
  fileLabel,
  accept,
  required,
  helperId,
  statusId,
  status,
  slot,
  pasteId,
  pasteLabel,
  error,
  errorId,
  extraDescribedBy,
  overflow,
  overflowId,
  multiple,
  onFile,
  onFiles,
  onPaste,
  onRemove,
}: {
  fileId: string;
  fileLabel: string;
  accept: string;
  required?: boolean;
  helperId: string;
  statusId: string;
  status: string;
  slot: SingleSlot;
  pasteId: string;
  pasteLabel: string;
  error?: string;
  errorId?: string;
  extraDescribedBy?: string;
  overflow?: string;
  overflowId?: string;
  multiple?: boolean;
  onFile: (file: File) => void;
  onFiles?: (files: File[]) => void;
  onPaste: (value: string) => void;
  onRemove: () => void;
}) {
  const described = [helperId, extraDescribedBy, statusId, overflow ? overflowId : null, error ? errorId : null]
    .filter(Boolean)
    .join(" ");
  const ready = Boolean(slot.fileName || slot.paste.trim() || slot.url);
  return (
    <div className="slot">
      <div className="slot-head">
        <label className="name" htmlFor={fileId} id={`${fileId}-label`}>
          {fileLabel}
          {required ? (
            <>
              {" "}
              <abbr className="req" title="required">
                *
              </abbr>
            </>
          ) : null}
        </label>
      </div>
      <div className="file-row">
        <input
          key={slot.fileKey}
          id={fileId}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={slot.storing}
          aria-labelledby={`${fileId}-label`}
          aria-required={required ? true : undefined}
          aria-invalid={overflow || error ? true : undefined}
          aria-describedby={described || undefined}
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = "";
            if (files.length === 0) return;
            if (onFiles) onFiles(files);
            else onFile(files[0]);
          }}
        />
      </div>
      <p className="hint" id={statusId}>
        {status}
      </p>
      {overflow && overflowId ? (
        <p className="field-error" id={overflowId}>
          {overflow}
        </p>
      ) : null}
      {ready ? (
        <div className="item-row">
          <p className="mono">{slot.fileName || slot.paste.trim() || slot.url}</p>
          <p className="hint">{slot.storing ? "Storing…" : "Ready"}</p>
          <button type="button" className="btn" onClick={onRemove} disabled={slot.storing}>
            Remove
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      ) : null}
      <details className="paste">
        <summary>Or paste a public https:// URL</summary>
        <div className="row" style={{ margin: "0.5rem 0 0" }}>
          <label className="field" htmlFor={pasteId}>
            {pasteLabel}
          </label>
          <input
            id={pasteId}
            type="url"
            inputMode="url"
            placeholder="https://"
            value={slot.paste}
            disabled={slot.storing}
            aria-describedby={`${pasteId}-helper`}
            onChange={(e) => onPaste(e.target.value)}
          />
          <p className="hint" id={`${pasteId}-helper`}>
            {PASTE_HELPER}
          </p>
        </div>
      </details>
    </div>
  );
}

function MediaListField({
  legend,
  required,
  countId,
  countText,
  helperId,
  helperText,
  fileId,
  fileLabel,
  accept,
  fileDisabled,
  orderHint,
  items,
  itemPrefix,
  remainId,
  remainText,
  overflow,
  overflowId,
  pasteId,
  pasteValue,
  pasteDisabled,
  error,
  errorId,
  extraDescribedBy,
  onFiles,
  onRemove,
  onPasteChange,
  onPasteAdd,
}: {
  legend: string;
  required?: boolean;
  countId: string;
  countText: string;
  helperId: string;
  helperText: string;
  fileId: string;
  fileLabel: string;
  accept: string;
  fileDisabled: boolean;
  orderHint: string;
  items: MediaItem[];
  itemPrefix: string;
  remainId?: string;
  remainText?: string;
  overflow?: string;
  overflowId?: string;
  pasteId: string;
  pasteValue: string;
  pasteDisabled: boolean;
  error?: string;
  errorId?: string;
  extraDescribedBy?: string;
  onFiles: (files: File[]) => void;
  onRemove: (key: string) => void;
  onPasteChange: (value: string) => void;
  onPasteAdd: () => void;
}) {
  const chooserDescribed = [helperId, extraDescribedBy, remainId, overflow ? overflowId : null, error ? errorId : null]
    .filter(Boolean)
    .join(" ");
  return (
    <fieldset
      className="group"
      aria-describedby={[helperId, extraDescribedBy, countId, remainId, overflow ? overflowId : null, error ? errorId : null]
        .filter(Boolean)
        .join(" ")}
    >
      <legend>
        {legend}
        {required ? (
          <>
            {" "}
            <abbr className="req" title="required">
              *
            </abbr>
          </>
        ) : null}{" "}
        <span className="count" id={countId} aria-live="polite">
          {countText}
        </span>
      </legend>
      <p className="hint" id={helperId}>
        {helperText}
      </p>
      <div className="slot">
        <label className="field" htmlFor={fileId}>
          {fileLabel}
        </label>
        <div className="file-row">
          <input
            id={fileId}
            type="file"
            accept={accept}
            multiple
            disabled={fileDisabled}
            aria-invalid={overflow || error ? true : undefined}
            aria-describedby={chooserDescribed || undefined}
            onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = "";
              if (files.length > 0) onFiles(files);
            }}
          />
        </div>
        <p className="hint" id={`${fileId}-order`}>
          {orderHint}
        </p>
        {remainText && remainId ? (
          <p className="hint" id={remainId}>
            {remainText}
          </p>
        ) : null}
        {overflow && overflowId ? (
          <p className="field-error" id={overflowId}>
            {overflow}
          </p>
        ) : null}
        {items.length > 0 ? (
          <ol className="picked">
            {items.map((item, index) => (
              <li className="item-row" key={item.key}>
                <span className="ord" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="mono">
                  {itemPrefix} {index + 1} · {item.label}
                </span>
                <span className="hint">{item.storing ? "Storing…" : item.error ? "Failed" : "Ready"}</span>
                <button type="button" className="btn" onClick={() => onRemove(item.key)}>
                  Remove
                </button>
                {item.error ? <p className="field-error">{item.error}</p> : null}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      {error ? (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      ) : null}
      <details className="paste">
        <summary>Or paste a public https:// URL</summary>
        <div className="file-row" style={{ marginTop: "0.45rem" }}>
          <label className="visually-hidden" htmlFor={pasteId}>
            {legend} URL
          </label>
          <input
            id={pasteId}
            type="url"
            placeholder="https://"
            value={pasteValue}
            disabled={pasteDisabled}
            onChange={(e) => onPasteChange(e.target.value)}
          />
          <button type="button" className="btn" onClick={onPasteAdd} disabled={pasteDisabled}>
            Add URL
          </button>
        </div>
        <p className="hint">{PASTE_HELPER}</p>
      </details>
    </fieldset>
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

export function GenerateForm() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot);
  const [model, setModel] = useState<ModelId>(MODEL_V20);
  const [v20Mode, setV20Mode] = useState<V20Mode>("text");
  const [flashMode, setFlashMode] = useState<FlashMode>("text");
  const [prompt, setPrompt] = useState("");
  const [frameSize, setFrameSize] = useState<V20FrameSizeId>("16:9");
  const [v20Resolution, setV20Resolution] = useState<V20Resolution>(DEFAULT_V20_RESOLUTION);
  const [duration, setDuration] = useState<V20Duration>(DEFAULT_DURATION_SEC);
  const [fps, setFps] = useState<V20Fps>(DEFAULT_FRAME_RATE);
  const [imageSlot, setImageSlot] = useState<SingleSlot>(EMPTY_SLOT);
  const [keyframeItems, setKeyframeItems] = useState<MediaItem[]>([]);
  const [kfPaste, setKfPaste] = useState("");
  const [kfOverflow, setKfOverflow] = useState<string | undefined>();
  const [imageOverflow, setImageOverflow] = useState<string | undefined>();
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_V20_NEGATIVE_PROMPT);
  const [v20Seed, setV20Seed] = useState("");
  const [inferenceSteps, setInferenceSteps] = useState("");
  const [flashSeconds, setFlashSeconds] = useState(FLASH_DEFAULT_SECONDS);
  const [flashAspect, setFlashAspect] = useState<FlashAspectRatio>("16:9");
  const [firstSlot, setFirstSlot] = useState<SingleSlot>(EMPTY_SLOT);
  const [lastSlot, setLastSlot] = useState<SingleSlot>(EMPTY_SLOT);
  const [firstOverflow, setFirstOverflow] = useState<string | undefined>();
  const [lastOverflow, setLastOverflow] = useState<string | undefined>();
  const [refImageItems, setRefImageItems] = useState<MediaItem[]>([]);
  const [refAudioItems, setRefAudioItems] = useState<MediaItem[]>([]);
  const [refImgPaste, setRefImgPaste] = useState("");
  const [refAudPaste, setRefAudPaste] = useState("");
  const [refImgOverflow, setRefImgOverflow] = useState<string | undefined>();
  const [refAudOverflow, setRefAudOverflow] = useState<string | undefined>();
  const [flashSeed, setFlashSeed] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [keyMissing, setKeyMissing] = useState(false);
  const [agnesApiKey, setAgnesApiKey] = useState("");
  const [job, setJob] = useState<JobView>({ phase: "idle" });
  const [benchMode, setBenchMode] = useState<"generate" | "story">("generate");
  const storyRef = useRef<StoryWorkbenchHandle | null>(null);

  const pollAbort = useRef<AbortController | null>(null);
  const eventSource = useRef<EventSource | null>(null);
  const imageGen = useRef(0);
  const firstGen = useRef(0);
  const lastGen = useRef(0);

  const maxFrames = V20_MAX_FRAMES[v20Resolution];
  const durationOptions = useMemo(
    () => allowedV20Durations(fps, maxFrames),
    [fps, maxFrames],
  );
  const frames = framesForDuration(duration, fps, maxFrames);
  const actualSec = frames / fps;
  const maxAtFps = (maxFrames / fps).toFixed(2);

  function changeResolution(next: V20Resolution) {
    setV20Resolution(next);
    setDuration((d) => clampV20Duration(d, fps, V20_MAX_FRAMES[next]));
  }

  function changeFps(next: V20Fps) {
    setFps(next);
    setDuration((d) => clampV20Duration(d, next, maxFrames));
  }

  useEffect(() => {
    return () => {
      pollAbort.current?.abort();
      eventSource.current?.close();
    };
  }, []);

  const storing =
    imageSlot.storing ||
    firstSlot.storing ||
    lastSlot.storing ||
    keyframeItems.some((i) => i.storing) ||
    refImageItems.some((i) => i.storing) ||
    refAudioItems.some((i) => i.storing);
  const busy = job.phase === "posting" || job.phase === "generating" || storing;

  function stopJobStream() {
    pollAbort.current?.abort();
    pollAbort.current = null;
    eventSource.current?.close();
    eventSource.current = null;
  }

  function changeTheme(next: ThemeId) {
    applyTheme(next);
  }

  function changeModel(next: ModelId) {
    setModel(next);
    setErrors({});
    setFormError(null);
    if (next === MODEL_V20) {
      setV20Mode("text");
      imageGen.current += 1;
      firstGen.current += 1;
      lastGen.current += 1;
      setFirstSlot(EMPTY_SLOT);
      setLastSlot(EMPTY_SLOT);
      setFirstOverflow(undefined);
      setLastOverflow(undefined);
      setRefImageItems([]);
      setRefAudioItems([]);
      setRefImgPaste("");
      setRefAudPaste("");
      setRefImgOverflow(undefined);
      setRefAudOverflow(undefined);
    } else {
      setFlashMode("text");
      imageGen.current += 1;
      setImageSlot(EMPTY_SLOT);
      setKeyframeItems([]);
      setKfPaste("");
      setKfOverflow(undefined);
      setImageOverflow(undefined);
    }
  }

  function changeV20Mode(next: V20Mode) {
    setV20Mode(next);
    setErrors({});
    if (next !== "image") {
      imageGen.current += 1;
      setImageSlot(EMPTY_SLOT);
      setImageOverflow(undefined);
    }
    if (next !== "keyframes") {
      setKeyframeItems([]);
      setKfPaste("");
      setKfOverflow(undefined);
    }
  }

  function changeFlashMode(next: FlashMode) {
    setFlashMode(next);
    setErrors({});
    if (next !== "keyframe") {
      firstGen.current += 1;
      lastGen.current += 1;
      setFirstSlot(EMPTY_SLOT);
      setLastSlot(EMPTY_SLOT);
      setFirstOverflow(undefined);
      setLastOverflow(undefined);
    }
    if (next !== "reference") {
      setRefImageItems([]);
      setRefAudioItems([]);
      setRefImgPaste("");
      setRefAudPaste("");
      setRefImgOverflow(undefined);
      setRefAudOverflow(undefined);
    }
  }

  function resetForm() {
    const needsConfirm =
      job.phase === "generating" ||
      job.phase === "completed" ||
      job.phase === "timeout" ||
      job.phase === "posting" ||
      job.phase === "poll_error";
    if (needsConfirm && !window.confirm("Clear this job and start over?")) return;
    stopJobStream();
    setModel(MODEL_V20);
    setV20Mode("text");
    setFlashMode("text");
    setPrompt("");
    setFrameSize("16:9");
    setV20Resolution(DEFAULT_V20_RESOLUTION);
    setDuration(DEFAULT_DURATION_SEC);
    setFps(DEFAULT_FRAME_RATE);
    imageGen.current += 1;
    firstGen.current += 1;
    lastGen.current += 1;
    setImageSlot(EMPTY_SLOT);
    setKeyframeItems([]);
    setKfPaste("");
    setKfOverflow(undefined);
    setImageOverflow(undefined);
    setNegativePrompt(DEFAULT_V20_NEGATIVE_PROMPT);
    setV20Seed("");
    setInferenceSteps("");
    setFlashSeconds(FLASH_DEFAULT_SECONDS);
    setFlashAspect("16:9");
    setFirstSlot(EMPTY_SLOT);
    setLastSlot(EMPTY_SLOT);
    setFirstOverflow(undefined);
    setLastOverflow(undefined);
    setRefImageItems([]);
    setRefAudioItems([]);
    setRefImgPaste("");
    setRefAudPaste("");
    setRefImgOverflow(undefined);
    setRefAudOverflow(undefined);
    setFlashSeed("");
    setErrors({});
    setFormError(null);
    setKeyMissing(false);
    setJob({ phase: "idle" });
  }

  function applySingleFile(
    genRef: { current: number },
    setSlot: Dispatch<SetStateAction<SingleSlot>>,
    errorId: string,
    file: File,
  ) {
    const gen = ++genRef.current;
    setSlot((prev) => ({
      url: "",
      fileName: file.name,
      paste: "",
      storing: true,
      fileKey: prev.fileKey,
    }));
    setErrors((prev) => clearFieldError(prev, errorId));
    void uploadMediaFile(file).then((result) => {
      if (gen !== genRef.current) return;
      if (result.ok) {
        setSlot((prev) => ({ ...prev, url: result.url, storing: false }));
        return;
      }
      setSlot((prev) => ({
        url: "",
        fileName: "",
        paste: "",
        storing: false,
        fileKey: prev.fileKey + 1,
      }));
      setErrors((prev) => ({ ...prev, [errorId]: result.detail }));
    });
  }

  function applySinglePaste(
    genRef: { current: number },
    setSlot: Dispatch<SetStateAction<SingleSlot>>,
    value: string,
  ) {
    genRef.current += 1;
    setSlot((prev) => ({
      url: value.trim(),
      fileName: "",
      paste: value,
      storing: false,
      fileKey: prev.fileName || prev.storing ? prev.fileKey + 1 : prev.fileKey,
    }));
  }

  function clearSingle(genRef: { current: number }, setSlot: Dispatch<SetStateAction<SingleSlot>>) {
    genRef.current += 1;
    setSlot((prev) => ({ ...EMPTY_SLOT, fileKey: prev.fileKey + 1 }));
  }

  function appendUploads(
    setter: Dispatch<SetStateAction<MediaItem[]>>,
    files: File[],
    errorId: string,
  ) {
    const additions: MediaItem[] = files.map((file) => ({
      key:
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `media-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      url: "",
      label: file.name,
      storing: true,
    }));
    setter((prev) => [...prev, ...additions]);
    setErrors((prev) => clearFieldError(prev, errorId));
    additions.forEach((item, i) => {
      const file = files[i];
      void uploadMediaFile(file).then((result) => {
        setter((prev) =>
          prev.map((row) => {
            if (row.key !== item.key) return row;
            if (result.ok) return { ...row, url: result.url, storing: false };
            return { ...row, storing: false, url: "", error: result.detail };
          }),
        );
      });
    });
  }

  function appendPasteUrl(
    setter: Dispatch<SetStateAction<MediaItem[]>>,
    raw: string,
    errorId: string,
    onConsumed: () => void,
  ) {
    const url = raw.trim();
    if (!url || !isPublicHttpsUrl(url)) {
      setErrors((prev) => ({ ...prev, [errorId]: "Use a public https:// URL." }));
      return;
    }
    setter((prev) => [
      ...prev,
      { key: crypto.randomUUID(), url, label: url, storing: false },
    ]);
    setErrors((prev) => clearFieldError(prev, errorId));
    onConsumed();
  }

  function onImageFiles(files: File[]) {
    if (files.length === 0) return;
    if (files.length > V20_I2V_MAX) {
      setImageOverflow(
        `Image-to-video allows ${V20_I2V_MAX} image. Added the first; ${files.length - V20_I2V_MAX} not added.`,
      );
    } else {
      setImageOverflow(undefined);
    }
    applySingleFile(imageGen, setImageSlot, "image-file", files[0]);
  }

  function onFirstFrameFiles(files: File[]) {
    if (files.length === 0) return;
    if (files.length > 1) {
      setFirstOverflow(`First frame allows 1 image. Added the first; ${files.length - 1} not added.`);
    } else {
      setFirstOverflow(undefined);
    }
    applySingleFile(firstGen, setFirstSlot, "first-file", files[0]);
  }

  function onLastFrameFiles(files: File[]) {
    if (files.length === 0) return;
    if (files.length > 1) {
      setLastOverflow(`Last frame allows 1 image. Added the first; ${files.length - 1} not added.`);
    } else {
      setLastOverflow(undefined);
    }
    applySingleFile(lastGen, setLastSlot, "last-file", files[0]);
  }

  function onKeyframeFiles(files: File[]) {
    const remaining = V20_KEYFRAME_MAX - keyframeItems.length;
    if (remaining <= 0) {
      setKfOverflow(`Keyframe limit reached (${V20_KEYFRAME_MAX}/${V20_KEYFRAME_MAX}).`);
      return;
    }
    const keep = files.slice(0, remaining);
    const dropped = files.length - keep.length;
    setKfOverflow(dropped > 0 ? overflowCopy("keyframe", remaining, keep.length, dropped) : undefined);
    appendUploads(setKeyframeItems, keep, "kf-files");
  }

  function onRefImageFiles(files: File[]) {
    const remaining = FLASH_IMAGE_MAX - refImageItems.length;
    if (remaining <= 0) {
      setRefImgOverflow(`Image limit reached (${FLASH_IMAGE_MAX}/${FLASH_IMAGE_MAX}).`);
      return;
    }
    const keep = files.slice(0, remaining);
    const dropped = files.length - keep.length;
    setRefImgOverflow(dropped > 0 ? overflowCopy("image", remaining, keep.length, dropped) : undefined);
    appendUploads(setRefImageItems, keep, "ref-images");
  }

  function onRefAudioFiles(files: File[]) {
    const remaining = FLASH_AUDIO_MAX - refAudioItems.length;
    if (remaining <= 0) {
      setRefAudOverflow(`Audio limit reached (${FLASH_AUDIO_MAX}/${FLASH_AUDIO_MAX}).`);
      return;
    }
    const keep = files.slice(0, remaining);
    const dropped = files.length - keep.length;
    setRefAudOverflow(dropped > 0 ? overflowCopy("audio", remaining, keep.length, dropped) : undefined);
    appendUploads(setRefAudioItems, keep, "ref-audios");
  }

  function validateAndBuild(): { request: CreateRequest } | { firstId: string } {
    const next: FieldErrors = {};
    let firstId: string | null = null;
    const mark = (id: string, message: string) => {
      next[id] = message;
      if (!firstId) firstId = id;
    };

    if (!prompt.trim()) mark("prompt", "Enter a prompt.");

    if (model === MODEL_V20) {
      if (v20Mode === "image") {
        if (!imageSlot.url.trim()) {
          mark("image-file", "Add an image file or paste a public https:// URL.");
        } else if (!isAcceptedMediaUrl(imageSlot.url.trim())) {
          mark("image-file", "Use a public https:// URL.");
        }
      }
      if (v20Mode === "keyframes") {
        const filled = keyframeItems.map((item) => item.url.trim()).filter(Boolean);
        if (filled.length < V20_KEYFRAME_MIN) {
          mark("kf-files", "Add at least two keyframe images.");
        } else if (filled.length > V20_KEYFRAME_MAX) {
          mark("kf-files", "Use at most 3 keyframe images.");
        } else if (filled.some((u) => !isAcceptedMediaUrl(u)) || keyframeItems.some((item) => !item.url.trim())) {
          mark("kf-files", "Use a public https:// URL.");
        }
      }
      if (v20Seed.trim() && optionalInt(v20Seed) === undefined) mark("v20-seed", "Invalid seed.");
      if (inferenceSteps.trim() && optionalInt(inferenceSteps) === undefined) {
        mark("steps", "Invalid inference steps.");
      }
    } else {
      const sec = Number.parseInt(flashSeconds, 10);
      if (!Number.isInteger(sec) || sec < FLASH_SECONDS_MIN || sec > FLASH_SECONDS_MAX) {
        mark("flash-duration", "Flash duration must be 4–12 seconds.");
      }
      if (flashMode === "keyframe") {
        const first = firstSlot.url.trim();
        const last = lastSlot.url.trim();
        if (!first && !last) {
          mark("first-file", "Add at least one frame (first, last, or both).");
        } else {
          if (first && !isAcceptedMediaUrl(first)) mark("first-file", "Use a public https:// URL.");
          if (last && !isAcceptedMediaUrl(last)) mark("last-file", "Use a public https:// URL.");
        }
      }
      if (flashMode === "reference") {
        const images = refImageItems.map((item) => item.url.trim()).filter(Boolean);
        const audios = refAudioItems.map((item) => item.url.trim()).filter(Boolean);
        if (images.length === 0 && audios.length === 0) {
          mark("ref-images", "Add at least one image or audio.");
        } else {
          if (refImageItems.some((item) => !item.url.trim() || !isAcceptedMediaUrl(item.url.trim()))) {
            mark("ref-images", "Use a public https:// URL.");
          }
          if (refAudioItems.some((item) => !item.url.trim() || !isAcceptedMediaUrl(item.url.trim()))) {
            mark("ref-audios", "Use a public https:// URL.");
          }
        }
      }
      if (flashSeed.trim() && optionalInt(flashSeed) === undefined) mark("flash-seed", "Invalid seed.");
    }

    setErrors(next);
    if (firstId) return { firstId };

    if (model === MODEL_V20) {
      const size = v20Size(v20Resolution, frameSize);
      const request: CreateRequest = {
        model: MODEL_V20,
        mode: v20Mode,
        prompt: prompt.trim(),
        width: size.width,
        height: size.height,
        num_frames: frames,
        frame_rate: fps,
      };
      if (v20Mode === "image") request.image = imageSlot.url.trim();
      if (v20Mode === "keyframes") {
        request.keyframe_images = keyframeItems.map((item) => item.url.trim()).filter(Boolean);
      }
      const neg = negativePrompt.trim();
      if (neg) request.negative_prompt = neg;
      const seed = optionalInt(v20Seed);
      if (seed !== undefined) request.seed = seed;
      const steps = optionalInt(inferenceSteps);
      if (steps !== undefined) request.num_inference_steps = steps;
      return { request };
    }

    const request: CreateRequest = {
      model: MODEL_FLASH,
      mode: flashMode,
      prompt: prompt.trim(),
      seconds: String(Number.parseInt(flashSeconds, 10)),
      aspect_ratio: flashAspect,
    };
    if (flashMode === "keyframe") {
      if (firstSlot.url.trim()) request.first_frame = firstSlot.url.trim();
      if (lastSlot.url.trim()) request.last_frame = lastSlot.url.trim();
    }
    if (flashMode === "reference") {
      const images = refImageItems.map((item) => item.url.trim()).filter(Boolean);
      const audios = refAudioItems.map((item) => item.url.trim()).filter(Boolean);
      if (images.length) request.images = images;
      if (audios.length) request.audios = audios;
    }
    const seed = optionalInt(flashSeed);
    if (seed !== undefined) request.seed = seed;
    return { request };
  }

  function applyHttpError(status: number, detail: string, videoId?: string) {
    if (status === 401) {
      setKeyMissing(true);
      setFormError(null);
      setJob({ phase: "idle" });
      return;
    }
    if (status === 400) {
      setFormError(detail);
      setJob(videoId ? { phase: "failed", videoId, message: detail } : { phase: "idle" });
      return;
    }
    setFormError("Agnes is unavailable or the job was not found.");
    if (videoId) {
      setJob({ phase: "failed", videoId, message: "Agnes is unavailable or the job was not found." });
    } else {
      setJob({ phase: "idle" });
    }
  }

  function startJobStream(videoId: string, pollModel: ModelId) {
    stopJobStream();
    const ac = new AbortController();
    pollAbort.current = ac;
    const params = new URLSearchParams({
      video_id: videoId,
      model_name: pollModel,
    });
    const es = new EventSource(`/api/videos/events?${params.toString()}`);
    eventSource.current = es;
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      es.close();
      if (eventSource.current === es) eventSource.current = null;
    };

    ac.signal.addEventListener("abort", settle);

    setJob({
      phase: "generating",
      videoId,
      model: pollModel,
      status: null,
    });

    const failStream = (message: string) => {
      if (settled || ac.signal.aborted) return;
      settle();
      setJob({
        phase: "poll_error",
        videoId,
        model: pollModel,
        message,
      });
    };

    es.addEventListener("status", (e: MessageEvent) => {
      if (settled || ac.signal.aborted) return;
      const data = parseEventPayload(e.data);
      if (!data || !isJobStatus(data.status)) return;
      if (data.status !== "queued" && data.status !== "in_progress") return;
      setJob({
        phase: "generating",
        videoId,
        model: pollModel,
        status: data.status,
        progress:
          typeof data.progress === "number" && Number.isFinite(data.progress)
            ? data.progress
            : undefined,
      });
    });

    es.addEventListener("completed", (e: MessageEvent) => {
      if (settled || ac.signal.aborted) return;
      settle();
      const data = parseEventPayload(e.data);
      const url = data && typeof data.url === "string" ? data.url : null;
      setJob({ phase: "completed", videoId, url });
    });

    es.addEventListener("failed", (e: MessageEvent) => {
      if (settled || ac.signal.aborted) return;
      settle();
      const data = parseEventPayload(e.data);
      const message =
        data && typeof data.message === "string" && data.message.length > 0
          ? data.message
          : "Generation failed.";
      setJob({ phase: "failed", videoId, message });
    });

    es.addEventListener("timeout", (e: MessageEvent) => {
      if (settled || ac.signal.aborted) return;
      settle();
      const data = parseEventPayload(e.data);
      setJob({
        phase: "timeout",
        videoId,
        model: pollModel,
        status: data && isJobStatus(data.status) ? data.status : undefined,
      });
    });

    es.addEventListener("stream_error", (e: MessageEvent) => {
      if (settled || ac.signal.aborted) return;
      const data = parseEventPayload(e.data);
      failStream(
        data && typeof data.message === "string" && data.message.length > 0
          ? data.message
          : "Status check failed. You can check status.",
      );
    });

    es.addEventListener("error", () => {
      if (settled || ac.signal.aborted) return;
      failStream("Status check failed. You can check status.");
    });
  }

  async function pollOnce(videoId: string, pollModel: ModelId) {
    const ac = new AbortController();
    pollAbort.current = ac;
    try {
      const result = await fetchStatus(videoId, pollModel, ac.signal);
      if (result.ok) {
        const st = result.data.status;
        if (st === "completed") {
          setJob({ phase: "completed", videoId, url: result.data.metadata?.url ?? null });
          return;
        }
        if (st === "failed") {
          setJob({
            phase: "failed",
            videoId,
            message: result.data.error?.message ?? "Generation failed.",
          });
          return;
        }
        setJob({
          phase: "timeout",
          videoId,
          model: pollModel,
          status: st,
          progress: result.data.progress,
        });
        return;
      }
      if (result.kind === "http") {
        applyHttpError(result.status, result.detail, videoId);
        return;
      }
      setJob({
        phase: "poll_error",
        videoId,
        model: pollModel,
        message: "Status check failed. You can check status.",
      });
    } catch (err) {
      if (!isAbort(err)) {
        setJob({
          phase: "poll_error",
          videoId,
          model: pollModel,
          message: "Status check failed. You can check status.",
        });
      }
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setKeyMissing(false);
    const built = validateAndBuild();
    if ("firstId" in built) {
      document.getElementById(built.firstId)?.focus();
      return;
    }

    setJob({ phase: "posting" });
    try {
      const payload: Record<string, unknown> = { ...built.request };
      const typedKey = agnesApiKey.trim();
      if (typedKey) payload.agnes_api_key = typedKey;
      const res = await fetch("/api/videos", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = await readDetail(res);
        applyHttpError(res.status, detail);
        return;
      }
      const body: unknown = await res.json();
      const created = body as CreateSuccess;
      if (typeof created.video_id !== "string" || !created.video_id) {
        setFormError("Agnes is unavailable or the job was not found.");
        setJob({ phase: "idle" });
        return;
      }
      startJobStream(created.video_id, built.request.model);
    } catch {
      setFormError("Agnes is unavailable or the job was not found.");
      setJob({ phase: "idle" });
    }
  }

  const generateLabel =
    job.phase === "posting" ? "Starting…" : job.phase === "generating" ? "Generating…" : "Generate video";

  return (
    <div className="app">
      <header className="shell">
        <p className="brand">Agnes Video</p>
        <fieldset className="seg" style={{ border: 0, margin: 0 }}>
          <legend className="visually-hidden">Mode</legend>
          <label>
            <input
              type="radio"
              name="bench-mode"
              value="generate"
              checked={benchMode === "generate"}
              onChange={() => setBenchMode("generate")}
            />
            <span>Generate</span>
          </label>
          <label>
            <input
              type="radio"
              name="bench-mode"
              value="story"
              checked={benchMode === "story"}
              onChange={() => setBenchMode("story")}
            />
            <span>Story</span>
          </label>
        </fieldset>
        <div className="key-field">
          <label htmlFor="agnes-api-key">Agnes API key</label>
          <input
            id="agnes-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Optional"
            value={agnesApiKey}
            onChange={(e) => setAgnesApiKey(e.target.value)}
          />
        </div>
        <div className="shell-actions">
          <fieldset className="seg" style={{ border: 0, margin: 0 }}>
            <legend className="visually-hidden">Theme</legend>
            <label>
              <input
                type="radio"
                name="theme"
                value="light"
                checked={theme === "light"}
                onChange={() => changeTheme("light")}
              />
              <span>Light</span>
            </label>
            <label>
              <input
                type="radio"
                name="theme"
                value="dark"
                checked={theme === "dark"}
                onChange={() => changeTheme("dark")}
              />
              <span>Dark</span>
            </label>
          </fieldset>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (benchMode === "story") {
                storyRef.current?.reset();
                return;
              }
              resetForm();
            }}
          >
            {benchMode === "story" ? "Reset story" : "Reset form"}
          </button>
        </div>
      </header>

      {keyMissing ? <p className="banner">{KEY_BANNER}</p> : null}

      <div
        className="layout"
        style={benchMode === "generate" ? undefined : { display: "none" }}
        aria-hidden={benchMode !== "generate"}
      >
        <form className="request" onSubmit={onSubmit} noValidate>
          <h2 className="block">Model</h2>
          <fieldset className="group">
            <legend>Model</legend>
            <div className="choice-row">
              <label className="radio">
                <input
                  type="radio"
                  name="model"
                  value={MODEL_V20}
                  checked={model === MODEL_V20}
                  onChange={() => changeModel(MODEL_V20)}
                />
                v2.0 <span className="api">{MODEL_V20}</span>
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="model"
                  value={MODEL_FLASH}
                  checked={model === MODEL_FLASH}
                  onChange={() => changeModel(MODEL_FLASH)}
                />
                2.5 Flash <span className="api">{MODEL_FLASH}</span>
              </label>
            </div>
          </fieldset>

          <h2 className="block">Mode</h2>
          {model === MODEL_V20 ? (
            <fieldset className="group">
              <legend>Mode</legend>
              <div className="choice-row">
                <label className="radio">
                  <input
                    type="radio"
                    name="mode-v20"
                    value="text"
                    checked={v20Mode === "text"}
                    onChange={() => changeV20Mode("text")}
                  />
                  Text to video
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="mode-v20"
                    value="image"
                    checked={v20Mode === "image"}
                    onChange={() => changeV20Mode("image")}
                  />
                  Image to video
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="mode-v20"
                    value="keyframes"
                    checked={v20Mode === "keyframes"}
                    onChange={() => changeV20Mode("keyframes")}
                  />
                  Keyframes
                </label>
              </div>
            </fieldset>
          ) : (
            <fieldset className="group">
              <legend>Mode</legend>
              <div className="choice-row">
                <label className="radio">
                  <input
                    type="radio"
                    name="mode-flash"
                    value="text"
                    checked={flashMode === "text"}
                    onChange={() => changeFlashMode("text")}
                  />
                  Text
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="mode-flash"
                    value="keyframe"
                    checked={flashMode === "keyframe"}
                    onChange={() => changeFlashMode("keyframe")}
                  />
                  Keyframe
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="mode-flash"
                    value="reference"
                    checked={flashMode === "reference"}
                    onChange={() => changeFlashMode("reference")}
                  />
                  Reference (images / audio)
                </label>
              </div>
            </fieldset>
          )}

          <div className="row">
            <label className="field" htmlFor="prompt">
              Prompt{" "}
              <abbr className="req" title="required">
                *
              </abbr>
            </label>
            <textarea
              id="prompt"
              name="prompt"
              rows={5}
              required
              aria-required="true"
              aria-invalid={errors.prompt ? true : undefined}
              aria-describedby={
                [errors.prompt ? "prompt-error" : null, model === MODEL_FLASH && flashMode === "reference" ? "ref-helper" : null]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            {errors.prompt ? (
              <p className="field-error" id="prompt-error">
                {errors.prompt}
              </p>
            ) : null}
            {model === MODEL_FLASH && flashMode === "reference" ? (
              <p className="hint" id="ref-helper">
                Name each input in the prompt, in order: {"<Picture 1>"}, {"<Picture 2>"}, {"<Audio 1>"}, …
              </p>
            ) : null}
          </div>

          {model === MODEL_V20 ? (
            <div>
              <h2 className="block">v2.0 settings</h2>
              <div className="settings-grid">
              <PillRow
                legend="Resolution"
                name="v20-resolution"
                options={V20_RESOLUTIONS}
                value={v20Resolution}
                onChange={changeResolution}
                hint={`${v20Resolution} · max ${maxFrames} frames`}
              />
              <PillRow
                legend="FPS"
                name="v20-fps"
                options={V20_FPS_OPTIONS}
                value={fps}
                onChange={changeFps}
              />
              <PillRow
                legend="Duration"
                name="v20-duration"
                options={durationOptions}
                value={duration}
                format={(sec) => `${sec}s`}
                onChange={setDuration}
                hint={`≈ ${actualSec.toFixed(2)} s · ${frames} frames @ ${fps} fps. Max ≈ ${maxAtFps} s at this fps.`}
              />
              <fieldset className="group">
                <legend>Aspect</legend>
                <div className="pill-row">
                  {V20_ASPECTS.map((opt) => (
                    <label key={opt}>
                      <input
                        type="radio"
                        name="frame-size"
                        value={opt}
                        checked={frameSize === opt}
                        onChange={() => setFrameSize(opt)}
                      />
                      <span>{opt}</span>
                    </label>
                  ))}
                </div>
                <p className="hint">Agnes may normalize. Trust the file, not these pixels.</p>
              </fieldset>
              </div>

              {v20Mode === "image" ? (
                <fieldset className="group" aria-describedby="image-helper">
                  <legend>
                    Image{" "}
                    <abbr className="req" title="required">
                      *
                    </abbr>
                  </legend>
                  <p className="hint" id="image-helper">
                    {ARCH_HELPER} Exactly one image. If you pick more, only the first is kept. {V20_REFERENCE_HINT}
                  </p>
                  <SingleMediaSlot
                    fileId="image-file"
                    fileLabel="Image file"
                    accept={IMAGE_ACCEPT}
                    required
                    multiple
                    helperId="image-helper"
                    statusId="image-status"
                    status={
                      imageSlot.storing
                        ? "Storing on this app…"
                        : imageSlot.fileName
                          ? "Ready — this app stored the file. Agnes will fetch the public URL."
                          : imageSlot.paste.trim()
                            ? "Pasted URL. Agnes will fetch this host directly."
                            : "No file yet. Exactly one image — extras from a multi pick are dropped."
                    }
                    slot={imageSlot}
                    pasteId="image-url"
                    pasteLabel="Image URL"
                    error={errors["image-file"]}
                    errorId="image-error"
                    overflow={imageOverflow}
                    overflowId="image-overflow"
                    onFile={(file) => applySingleFile(imageGen, setImageSlot, "image-file", file)}
                    onFiles={onImageFiles}
                    onPaste={(value) => {
                      applySinglePaste(imageGen, setImageSlot, value);
                      setImageOverflow(undefined);
                      setErrors((prev) => clearFieldError(prev, "image-file"));
                    }}
                    onRemove={() => {
                      clearSingle(imageGen, setImageSlot);
                      setImageOverflow(undefined);
                      setErrors((prev) => clearFieldError(prev, "image-file"));
                    }}
                  />
                </fieldset>
              ) : null}

              {v20Mode === "keyframes" ? (
                <MediaListField
                  legend="Keyframe images"
                  required
                  countId="kf-count"
                  countText={`${keyframeItems.length}/${V20_KEYFRAME_MAX} images · ${V20_KEYFRAME_MIN}–${V20_KEYFRAME_MAX}`}
                  helperId="kf-helper"
                  helperText={`${ARCH_HELPER} ${V20_KEYFRAME_MIN}–${V20_KEYFRAME_MAX} images. Choose several in one picker. ${V20_REFERENCE_HINT}`}
                  fileId="kf-files"
                  fileLabel="Choose keyframe images"
                  accept={IMAGE_ACCEPT}
                  fileDisabled={
                    keyframeItems.some((item) => item.storing) || keyframeItems.length >= V20_KEYFRAME_MAX
                  }
                  orderHint="Added in chooser order, appended to the list. Pick again to add more, up to 3."
                  items={keyframeItems}
                  itemPrefix="Keyframe"
                  remainId="kf-remain"
                  remainText={
                    keyframeItems.length >= V20_KEYFRAME_MAX
                      ? `0 remaining. Keyframe limit reached (${V20_KEYFRAME_MAX}/${V20_KEYFRAME_MAX}).`
                      : `${V20_KEYFRAME_MAX - keyframeItems.length} remaining.`
                  }
                  overflow={kfOverflow}
                  overflowId="kf-overflow"
                  pasteId="kf-url"
                  pasteValue={kfPaste}
                  pasteDisabled={
                    keyframeItems.some((item) => item.storing) || keyframeItems.length >= V20_KEYFRAME_MAX
                  }
                  error={errors["kf-files"]}
                  errorId="kf-error"
                  onFiles={onKeyframeFiles}
                  onRemove={(key) => {
                    setKeyframeItems((prev) => prev.filter((item) => item.key !== key));
                    setKfOverflow(undefined);
                  }}
                  onPasteChange={setKfPaste}
                  onPasteAdd={() => {
                    if (keyframeItems.length >= V20_KEYFRAME_MAX) {
                      setKfOverflow(`Keyframe limit reached (${V20_KEYFRAME_MAX}/${V20_KEYFRAME_MAX}).`);
                      return;
                    }
                    appendPasteUrl(setKeyframeItems, kfPaste, "kf-files", () => setKfPaste(""));
                  }}
                />
              ) : null}

              <details className="advanced">
                <summary>Advanced</summary>
                <div className="row" style={{ marginTop: "0.5rem" }}>
                  <label className="field" htmlFor="negative">
                    Negative prompt
                  </label>
                  <textarea
                    id="negative"
                    rows={4}
                    value={negativePrompt}
                    aria-describedby="negative-helper"
                    onChange={(e) => setNegativePrompt(e.target.value)}
                  />
                  <p className="hint" id="negative-helper">
                    Default avoids turning a character sheet into the video. Edit or clear anytime.
                  </p>
                </div>
                <div className="row">
                  <label className="field" htmlFor="v20-seed">
                    Seed
                  </label>
                  <input
                    id="v20-seed"
                    type="number"
                    value={v20Seed}
                    aria-invalid={errors["v20-seed"] ? true : undefined}
                    onChange={(e) => setV20Seed(e.target.value)}
                  />
                </div>
                <div className="row">
                  <label className="field" htmlFor="steps">
                    Inference steps
                  </label>
                  <input
                    id="steps"
                    type="number"
                    value={inferenceSteps}
                    aria-invalid={errors.steps ? true : undefined}
                    onChange={(e) => setInferenceSteps(e.target.value)}
                  />
                </div>
              </details>
            </div>
          ) : (
            <div>
              <h2 className="block">2.5 Flash settings</h2>
              <div className="flash-timing">
              <div className="row">
                <label className="field" htmlFor="flash-duration">
                  Duration (seconds)
                </label>
                <input
                  id="flash-duration"
                  type="number"
                  min={FLASH_SECONDS_MIN}
                  max={FLASH_SECONDS_MAX}
                  step={1}
                  value={flashSeconds}
                  aria-invalid={errors["flash-duration"] ? true : undefined}
                  aria-describedby={
                    ["flash-duration-hint", errors["flash-duration"] ? "flash-duration-error" : null]
                      .filter(Boolean)
                      .join(" ")
                  }
                  onChange={(e) => setFlashSeconds(e.target.value)}
                />
                <p className="hint" id="flash-duration-hint">
                  Flash has no fps. Duration is seconds as sent.
                </p>
                {errors["flash-duration"] ? (
                  <p className="field-error" id="flash-duration-error">
                    {errors["flash-duration"]}
                  </p>
                ) : null}
              </div>
              <fieldset className="group">
                <legend>Aspect ratio</legend>
                <div className="chip-row">
                  {FLASH_ASPECT_RATIOS.map((ar) => (
                    <label key={ar}>
                      <input
                        type="radio"
                        name="flash-aspect"
                        value={ar}
                        checked={flashAspect === ar}
                        onChange={() => setFlashAspect(ar)}
                      />
                      <span>{ar}</span>
                    </label>
                  ))}
                </div>
                <p className="hint">720P.</p>
              </fieldset>
              </div>

              {flashMode === "keyframe" ? (
                <fieldset className="group" aria-describedby="frame-helper">
                  <legend>Frames</legend>
                  <p className="hint" id="frame-helper">
                    {ARCH_HELPER} At least one of first or last. Each slot is 1 image (2 frames max).
                  </p>
                  <SingleMediaSlot
                    fileId="first-file"
                    fileLabel="First frame"
                    accept={IMAGE_ACCEPT}
                    multiple
                    helperId="frame-helper"
                    statusId="first-status"
                    status={
                      firstSlot.storing
                        ? "Storing on this app…"
                        : "One file. Extra files from a multi pick are dropped."
                    }
                    slot={firstSlot}
                    pasteId="first-url"
                    pasteLabel="First frame URL"
                    error={errors["first-file"]}
                    errorId="first-error"
                    overflow={firstOverflow}
                    overflowId="first-overflow"
                    onFile={(file) => applySingleFile(firstGen, setFirstSlot, "first-file", file)}
                    onFiles={onFirstFrameFiles}
                    onPaste={(value) => {
                      applySinglePaste(firstGen, setFirstSlot, value);
                      setFirstOverflow(undefined);
                      setErrors((prev) => clearFieldError(prev, "first-file"));
                    }}
                    onRemove={() => {
                      clearSingle(firstGen, setFirstSlot);
                      setFirstOverflow(undefined);
                      setErrors((prev) => clearFieldError(prev, "first-file"));
                    }}
                  />
                  <SingleMediaSlot
                    fileId="last-file"
                    fileLabel="Last frame"
                    accept={IMAGE_ACCEPT}
                    multiple
                    helperId="frame-helper"
                    statusId="last-status"
                    status={
                      lastSlot.storing
                        ? "Storing on this app…"
                        : "One file. Extra files from a multi pick are dropped."
                    }
                    slot={lastSlot}
                    pasteId="last-url"
                    pasteLabel="Last frame URL"
                    error={errors["last-file"]}
                    errorId="last-error"
                    overflow={lastOverflow}
                    overflowId="last-overflow"
                    onFile={(file) => applySingleFile(lastGen, setLastSlot, "last-file", file)}
                    onFiles={onLastFrameFiles}
                    onPaste={(value) => {
                      applySinglePaste(lastGen, setLastSlot, value);
                      setLastOverflow(undefined);
                      setErrors((prev) => clearFieldError(prev, "last-file"));
                    }}
                    onRemove={() => {
                      clearSingle(lastGen, setLastSlot);
                      setLastOverflow(undefined);
                      setErrors((prev) => clearFieldError(prev, "last-file"));
                    }}
                  />
                </fieldset>
              ) : null}

              {flashMode === "reference" ? (
                <>
                  <MediaListField
                    legend="Images"
                    countId="ref-img-count"
                    countText={`${refImageItems.length}/${FLASH_IMAGE_MAX} images`}
                    helperId="ref-arch-helper"
                    helperText={`${ARCH_HELPER} At most ${FLASH_IMAGE_MAX} images. At least one image or audio.`}
                    extraDescribedBy="ref-img-remain"
                    fileId="ref-img-files"
                    fileLabel="Choose images"
                    accept={IMAGE_ACCEPT}
                    fileDisabled={refImageItems.length >= FLASH_IMAGE_MAX}
                    orderHint="Added in chooser order, appended to the list."
                    items={refImageItems}
                    itemPrefix="Picture"
                    remainId="ref-img-remain"
                    remainText={
                      refImageItems.length >= FLASH_IMAGE_MAX
                        ? `0 remaining. Image limit reached (${FLASH_IMAGE_MAX}/${FLASH_IMAGE_MAX}).`
                        : `${FLASH_IMAGE_MAX - refImageItems.length} remaining.`
                    }
                    overflow={refImgOverflow}
                    overflowId="ref-img-overflow"
                    pasteId="ref-img-url"
                    pasteValue={refImgPaste}
                    pasteDisabled={refImageItems.length >= FLASH_IMAGE_MAX}
                    error={errors["ref-images"]}
                    errorId="ref-images-error"
                    onFiles={onRefImageFiles}
                    onRemove={(key) => {
                      setRefImageItems((prev) => prev.filter((item) => item.key !== key));
                      setRefImgOverflow(undefined);
                    }}
                    onPasteChange={setRefImgPaste}
                    onPasteAdd={() => {
                      if (refImageItems.length >= FLASH_IMAGE_MAX) {
                        setRefImgOverflow(`Image limit reached (${FLASH_IMAGE_MAX}/${FLASH_IMAGE_MAX}).`);
                        return;
                      }
                      appendPasteUrl(setRefImageItems, refImgPaste, "ref-images", () => setRefImgPaste(""));
                    }}
                  />
                  <MediaListField
                    legend="Audios"
                    countId="ref-aud-count"
                    countText={`${refAudioItems.length}/${FLASH_AUDIO_MAX} audios`}
                    helperId="ref-aud-helper"
                    helperText="Empty list is fine if there is at least one image (or the reverse)."
                    extraDescribedBy="ref-aud-remain"
                    fileId="ref-aud-files"
                    fileLabel="Choose audios"
                    accept={AUDIO_ACCEPT}
                    fileDisabled={refAudioItems.length >= FLASH_AUDIO_MAX}
                    orderHint="Added in chooser order, appended to the list."
                    items={refAudioItems}
                    itemPrefix="Audio"
                    remainId="ref-aud-remain"
                    remainText={
                      refAudioItems.length >= FLASH_AUDIO_MAX
                        ? `0 remaining. Audio limit reached (${FLASH_AUDIO_MAX}/${FLASH_AUDIO_MAX}).`
                        : `${FLASH_AUDIO_MAX - refAudioItems.length} remaining.`
                    }
                    overflow={refAudOverflow}
                    overflowId="ref-aud-overflow"
                    pasteId="ref-aud-url"
                    pasteValue={refAudPaste}
                    pasteDisabled={refAudioItems.length >= FLASH_AUDIO_MAX}
                    error={errors["ref-audios"]}
                    errorId="ref-audios-error"
                    onFiles={onRefAudioFiles}
                    onRemove={(key) => {
                      setRefAudioItems((prev) => prev.filter((item) => item.key !== key));
                      setRefAudOverflow(undefined);
                    }}
                    onPasteChange={setRefAudPaste}
                    onPasteAdd={() => {
                      if (refAudioItems.length >= FLASH_AUDIO_MAX) {
                        setRefAudOverflow(`Audio limit reached (${FLASH_AUDIO_MAX}/${FLASH_AUDIO_MAX}).`);
                        return;
                      }
                      appendPasteUrl(setRefAudioItems, refAudPaste, "ref-audios", () => setRefAudPaste(""));
                    }}
                  />
                </>
              ) : null}

              <details className="advanced">
                <summary>Advanced</summary>
                <div className="row" style={{ marginTop: "0.5rem" }}>
                  <label className="field" htmlFor="flash-seed">
                    Seed
                  </label>
                  <input
                    id="flash-seed"
                    type="number"
                    value={flashSeed}
                    aria-invalid={errors["flash-seed"] ? true : undefined}
                    onChange={(e) => setFlashSeed(e.target.value)}
                  />
                </div>
              </details>
            </div>
          )}

          <div className="generate-bar">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {generateLabel}
            </button>
            <p className="hint">Disabled while a file is storing, or while starting / generating.</p>
            {formError ? <p className="form-error">{formError}</p> : null}
          </div>
        </form>

        <JobPane
          job={job}
          onCheckStatus={(videoId, pollModel) => {
            void pollOnce(videoId, pollModel);
          }}
          onPollAgain={(videoId, pollModel) => {
            startJobStream(videoId, pollModel);
          }}
        />
      </div>

      <StoryWorkbench
        ref={storyRef}
        active={benchMode === "story"}
        agnesApiKey={agnesApiKey}
        onAuthError={() => setKeyMissing(true)}
        onAuthOk={() => setKeyMissing(false)}
      />
    </div>
  );
}

function JobPane({
  job,
  onCheckStatus,
  onPollAgain,
}: {
  job: JobView;
  onCheckStatus: (videoId: string, model: ModelId) => void;
  onPollAgain: (videoId: string, model: ModelId) => void;
}) {
  const live = liveStatus(job);
  const busyWell = job.phase === "posting" || job.phase === "generating";

  return (
    <aside className="job" aria-labelledby="job-heading">
      <h2 className="block" id="job-heading">
        Job
      </h2>
      <div className="job-well" aria-busy={busyWell}>
        {busyWell ? (
          <div className="job-run">
            <span className="spin" aria-hidden="true" />
            <p className="job-line sr-status" aria-live="polite" aria-atomic="true">
              <JobLive job={job} />
            </p>
          </div>
        ) : (
          <p className="sr-status" aria-live="polite" aria-atomic="true">
            {live}
          </p>
        )}
        <JobBody job={job} onCheckStatus={onCheckStatus} onPollAgain={onPollAgain} />
      </div>
    </aside>
  );
}

function liveStatus(job: JobView): string {
  switch (job.phase) {
    case "idle":
      return "Nothing generating yet.";
    case "posting":
      return "Starting job…";
    case "generating":
      if (typeof job.progress === "number") return `In progress ${job.progress}%`;
      if (job.status === "in_progress") return "In progress";
      if (job.status === "queued") return "Queued.";
      return "Generating…";
    case "completed":
      return "Completed.";
    case "failed":
      return "Generation failed.";
    case "timeout":
      return "Still generating?";
    case "poll_error":
      return "Status check failed.";
    default: {
      const _e: never = job;
      return _e;
    }
  }
}

function JobLive({ job }: { job: JobView }) {
  if (job.phase === "generating" && typeof job.progress === "number") {
    return (
      <>
        In progress <span className="job-pct">{job.progress}%</span>
      </>
    );
  }
  return liveStatus(job);
}

function JobBody({
  job,
  onCheckStatus,
  onPollAgain,
}: {
  job: JobView;
  onCheckStatus: (videoId: string, model: ModelId) => void;
  onPollAgain: (videoId: string, model: ModelId) => void;
}) {
  if (job.phase === "idle") {
    return <p className="hint">Fill the form, then Generate. This pane becomes status, then a player.</p>;
  }
  if (job.phase === "posting") {
    return null;
  }
  if (job.phase === "generating") {
    return <p className="mono">video_id: {job.videoId}</p>;
  }
  if (job.phase === "completed") {
    return (
      <>
        {job.url ? (
          <>
            <video className="player" src={job.url} controls playsInline />
            <p>
              <a href={job.url} download target="_blank" rel="noopener noreferrer">
                Download MP4
              </a>
            </p>
          </>
        ) : null}
        <p className="mono">video_id: {job.videoId}</p>
        <p className="hint">{MP4_HINT}</p>
      </>
    );
  }
  if (job.phase === "failed") {
    return (
      <>
        {job.message ? <p className="form-error">{job.message}</p> : null}
        {job.videoId ? <p className="mono">video_id: {job.videoId}</p> : null}
      </>
    );
  }
  if (job.phase === "timeout") {
    return (
      <>
        <p className="hint">Job is not marked failed.</p>
        {job.status ? <p>Last status: {job.status}</p> : null}
        <p className="mono">video_id: {job.videoId}</p>
        <p>
          <button type="button" className="btn" onClick={() => onCheckStatus(job.videoId, job.model)}>
            Check status
          </button>
        </p>
      </>
    );
  }
  return (
    <>
      <p className="form-error">{job.message}</p>
      <p className="mono">video_id: {job.videoId}</p>
      <p>
        <button type="button" className="btn" onClick={() => onPollAgain(job.videoId, job.model)}>
          Resume status
        </button>
      </p>
    </>
  );
}
