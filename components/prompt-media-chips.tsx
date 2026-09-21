import { useEffect, useRef, useState } from "react";

export type PromptChipItem = {
  key: string;
  url: string;
  label: string;
  storing: boolean;
  error?: string;
};

type ChipKind = "picture" | "audio";

type ChipSpec = {
  kind: ChipKind;
  index: number;
  url: string;
};

const TOKEN_RE = /<(Picture|Audio)\s+(\d+)>/g;

export function serializeComposer(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const token = el.getAttribute("data-token");
    if (token) {
      out += token;
      return;
    }
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\s+$/g, "");
}

function parseToken(token: string): { kind: ChipKind; index: number } | null {
  const m = /^<(Picture|Audio)\s+(\d+)>$/.exec(token);
  if (!m) return null;
  return { kind: m[1] === "Audio" ? "audio" : "picture", index: Number(m[2]) };
}

function tokenFor(kind: ChipKind, index: number): string {
  return kind === "picture" ? `<Picture ${index}>` : `<Audio ${index}>`;
}

function displayName(
  kind: ChipKind,
  index: number,
  images: PromptChipItem[] = [],
  audios: PromptChipItem[] = [],
): string {
  const list = kind === "picture" ? images : audios;
  const named = list[index - 1]?.label?.trim();
  if (named) return named;
  return kind === "picture" ? `Image${index}` : `Audio${index}`;
}

function lookupUrl(spec: ChipSpec, images: PromptChipItem[], audios: PromptChipItem[]): string {
  const list = spec.kind === "picture" ? images : audios;
  return list[spec.index - 1]?.url ?? spec.url;
}

function createChipEl(spec: ChipSpec, images: PromptChipItem[], audios: PromptChipItem[]): HTMLSpanElement {
  const token = tokenFor(spec.kind, spec.index);
  const url = lookupUrl(spec, images, audios);
  const chip = document.createElement("span");
  chip.className = "prompt-inline";
  chip.setAttribute("data-token", token);
  chip.setAttribute("contenteditable", "false");
  chip.setAttribute("title", token);
  if (spec.kind === "picture" && url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    chip.appendChild(img);
  } else {
    const glyph = document.createElement("span");
    glyph.className = "prompt-inline-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = spec.kind === "picture" ? "I" : "A";
    chip.appendChild(glyph);
  }
  const name = document.createElement("span");
  name.className = "prompt-inline-name";
  name.textContent = displayName(spec.kind, spec.index, images, audios);
  chip.appendChild(name);
  return chip;
}

function placeCaretAfter(node: Node): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function insertChipAtCaret(
  root: HTMLElement,
  spec: ChipSpec,
  images: PromptChipItem[],
  audios: PromptChipItem[],
): void {
  root.focus();
  const sel = window.getSelection();
  const chip = createChipEl(spec, images, audios);
  const after = document.createTextNode("\u00a0");
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
    root.appendChild(chip);
    root.appendChild(after);
    placeCaretAfter(after);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(after);
  range.insertNode(chip);
  placeCaretAfter(after);
}

function hydrate(root: HTMLElement, value: string, images: PromptChipItem[], audios: PromptChipItem[]): void {
  root.replaceChildren();
  if (!value) return;
  const re = new RegExp(TOKEN_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    if (m.index > last) root.appendChild(document.createTextNode(value.slice(last, m.index)));
    const kind: ChipKind = m[1] === "Audio" ? "audio" : "picture";
    const index = Number(m[2]);
    root.appendChild(createChipEl({ kind, index, url: "" }, images, audios));
    last = m.index + m[0].length;
  }
  if (last < value.length) root.appendChild(document.createTextNode(value.slice(last)));
}

function insertPlain(root: HTMLElement, text: string, images: PromptChipItem[], audios: PromptChipItem[]): void {
  if (!text) return;
  if (/<(Picture|Audio)\s+\d+>/.test(text)) {
    const hold = document.createElement("div");
    hydrate(hold, text, images, audios);
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
      while (hold.firstChild) root.appendChild(hold.firstChild);
      return;
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const frag = document.createDocumentFragment();
    while (hold.firstChild) frag.appendChild(hold.firstChild);
    range.insertNode(frag);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
  root.focus();
  const sel = window.getSelection();
  const node = document.createTextNode(text);
  if (!sel || sel.rangeCount === 0 || !root.contains(sel.anchorNode)) {
    root.appendChild(node);
    placeCaretAfter(node);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(node);
  placeCaretAfter(node);
}

function trailingMentionQuery(text: string): string | null {
  const normalized = text.replace(/\u00a0/g, " ");
  const m = /(?:^|[\s\n])@([^\s]*)$/.exec(normalized);
  return m ? m[1] : null;
}

function mentionQueryAtCaret(root: HTMLElement): { node: Text; at: number; query: string } | null {
  const sel = window.getSelection();
  let prefix = (root.textContent ?? "").replace(/\u00a0/g, " ");
  if (sel && sel.rangeCount > 0) {
    const caret = sel.getRangeAt(0);
    if (root.contains(caret.startContainer) || caret.startContainer === root) {
      const pre = caret.cloneRange();
      pre.selectNodeContents(root);
      try {
        pre.setEnd(caret.startContainer, caret.startOffset);
        prefix = pre.toString().replace(/\u00a0/g, " ");
      } catch {
        /* keep textContent prefix */
      }
    }
  }

  const at = prefix.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/[\s\n]/.test(prefix[at - 1] ?? "")) return null;
  const query = prefix.slice(at + 1);
  if (/[\s\n]/.test(query)) return null;

  let remaining = at;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const node = n as Text;
    const len = node.textContent?.length ?? 0;
    if (remaining < len) return { node, at: remaining, query };
    remaining -= len;
  }
  return null;
}

function readyMentions(images: PromptChipItem[], audios: PromptChipItem[]): ChipSpec[] {
  const out: ChipSpec[] = [];
  images.forEach((item, i) => {
    if (!item.storing && !item.error && item.url) {
      out.push({ kind: "picture", index: i + 1, url: item.url });
    }
  });
  audios.forEach((item, i) => {
    if (!item.storing && !item.error && item.url) {
      out.push({ kind: "audio", index: i + 1, url: item.url });
    }
  });
  return out;
}

function filterMentions(
  items: ChipSpec[],
  query: string,
  images: PromptChipItem[],
  audios: PromptChipItem[],
): ChipSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((spec) => {
    const name = displayName(spec.kind, spec.index, images, audios).toLowerCase();
    return name.includes(q) || String(spec.index) === q;
  });
}

function replaceMention(
  root: HTMLElement,
  found: { node: Text; at: number; query: string },
  spec: ChipSpec,
  images: PromptChipItem[],
  audios: PromptChipItem[],
): void {
  const text = found.node.textContent ?? "";
  const before = text.slice(0, found.at);
  const after = text.slice(found.at + 1 + found.query.length);
  const parent = found.node.parentNode;
  if (!parent) return;
  const chip = createChipEl(spec, images, audios);
  const afterNode = document.createTextNode(after.length > 0 ? after : "\u00a0");
  if (before) parent.insertBefore(document.createTextNode(before), found.node);
  parent.insertBefore(chip, found.node);
  parent.insertBefore(afterNode, found.node);
  parent.removeChild(found.node);
  placeCaretAfter(afterNode);
  root.focus();
}

type MentionMenu = {
  query: string;
  active: number;
  top: number;
  left: number;
};

export function PromptComposer({
  id,
  labelledBy,
  describedBy,
  invalid,
  value,
  images,
  audios,
  onChange,
  required,
  placeholder,
  showChips = true,
  className,
}: {
  id: string;
  labelledBy?: string;
  describedBy?: string;
  invalid?: boolean;
  value: string;
  images: PromptChipItem[];
  audios: PromptChipItem[];
  onChange: (next: string) => void;
  required?: boolean;
  placeholder?: string;
  showChips?: boolean;
  className?: string;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastValue = useRef<string | null>(null);
  const mediaRef = useRef({ images, audios });
  mediaRef.current = { images, audios };
  const [menu, setMenu] = useState<MentionMenu | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;

  function emit(root: HTMLElement) {
    const next = serializeComposer(root);
    lastValue.current = next;
    onChange(next);
  }

  function syncMention(root: HTMLElement) {
    const query = trailingMentionQuery(root.textContent ?? "");
    const found = mentionQueryAtCaret(root);
    if (query === null && !found) {
      setMenu(null);
      return;
    }
    const q = found?.query ?? query ?? "";
    let top = 0;
    let left = 0;
    try {
      if (found) {
        const range = document.createRange();
        range.setStart(found.node, found.at);
        range.setEnd(found.node, Math.min(found.node.length, found.at + 1 + found.query.length));
        const rect = range.getBoundingClientRect();
        top = rect.bottom + 4;
        left = rect.left;
      }
      if (!top && !left) {
        const rect = root.getBoundingClientRect();
        top = rect.bottom + 4;
        left = rect.left;
      }
    } catch {
      const rect = root.getBoundingClientRect();
      top = rect.bottom + 4;
      left = rect.left;
    }
    setMenu((prev) => ({
      query: q,
      active: prev && prev.query === q ? prev.active : 0,
      top,
      left,
    }));
  }

  function scheduleMention() {
    const root = editorRef.current;
    if (!root) return;
    requestAnimationFrame(() => {
      const live = editorRef.current;
      if (live) syncMention(live);
    });
  }

  function pickMention(spec: ChipSpec) {
    const root = editorRef.current;
    if (!root) return;
    const found = mentionQueryAtCaret(root);
    if (!found) return;
    replaceMention(root, found, spec, mediaRef.current.images, mediaRef.current.audios);
    setMenu(null);
    emit(root);
  }

  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    if (lastValue.current === value) return;
    hydrate(root, value, mediaRef.current.images, mediaRef.current.audios);
    lastValue.current = value;
  }, [value]);

  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    const on = () => scheduleMention();
    root.addEventListener("input", on);
    root.addEventListener("keyup", on);
    return () => {
      root.removeEventListener("input", on);
      root.removeEventListener("keyup", on);
    };
  }, []);

  useEffect(() => {
    scheduleMention();
  }, [value]);

  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>("[data-token]").forEach((chip) => {
      const parsed = parseToken(chip.getAttribute("data-token") ?? "");
      if (!parsed) return;
      const url = lookupUrl({ ...parsed, url: "" }, images, audios);
      const img = chip.querySelector("img");
      if (parsed.kind === "picture" && url && img) img.src = url;
      const nameEl = chip.querySelector(".prompt-inline-name");
      if (nameEl) nameEl.textContent = displayName(parsed.kind, parsed.index, images, audios);
    });
  }, [images, audios]);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      const root = editorRef.current;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (root?.contains(t)) return;
      if (t instanceof Element && t.closest(".prompt-mention")) return;
      setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menu]);

  const filtered = menu
    ? filterMentions(readyMentions(images, audios), menu.query, images, audios)
    : [];
  const editorClass = ["prompt-composer", className].filter(Boolean).join(" ");

  return (
    <div className="prompt-composer-wrap">
      {showChips ? (
        <PromptMediaChips
          images={images}
          audios={audios}
          onInsert={(spec) => {
            const root = editorRef.current;
            if (!root) return;
            insertChipAtCaret(root, spec, images, audios);
            emit(root);
          }}
        />
      ) : null}
      <div
        id={id}
        ref={editorRef}
        className={editorClass}
        role="textbox"
        contentEditable
        suppressContentEditableWarning
        aria-labelledby={labelledBy}
        aria-multiline="true"
        aria-required={required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        aria-autocomplete="list"
        aria-expanded={menu ? true : undefined}
        data-placeholder={placeholder ?? "Type @ to mention an image or audio by name"}
        onInput={() => {
          const root = editorRef.current;
          if (!root) return;
          emit(root);
          scheduleMention();
        }}
        onKeyUp={() => {
          scheduleMention();
        }}
        onClick={() => {
          scheduleMention();
        }}
        onKeyDown={(e) => {
          const open = menuRef.current;
          if (open) {
            const choices = filterMentions(
              readyMentions(mediaRef.current.images, mediaRef.current.audios),
              open.query,
              mediaRef.current.images,
              mediaRef.current.audios,
            );
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setMenu((m) =>
                m ? { ...m, active: choices.length === 0 ? 0 : (m.active + 1) % choices.length } : m,
              );
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setMenu((m) =>
                m
                  ? {
                      ...m,
                      active:
                        choices.length === 0 ? 0 : (m.active - 1 + choices.length) % choices.length,
                    }
                  : m,
              );
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMenu(null);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              const pick = choices[Math.min(open.active, Math.max(0, choices.length - 1))];
              if (pick) {
                e.preventDefault();
                pickMention(pick);
                return;
              }
            }
          }
          if (e.key !== "Enter") return;
          e.preventDefault();
          const root = editorRef.current;
          if (!root) return;
          insertPlain(root, "\n", mediaRef.current.images, mediaRef.current.audios);
          emit(root);
        }}
        onPaste={(e) => {
          e.preventDefault();
          const root = editorRef.current;
          if (!root) return;
          insertPlain(root, e.clipboardData.getData("text/plain"), mediaRef.current.images, mediaRef.current.audios);
          emit(root);
        }}
      />
      {menu ? (
        <div
          className="prompt-mention"
          role="listbox"
          style={{ top: menu.top, left: menu.left }}
        >
          {filtered.length === 0 ? (
            <p className="prompt-mention-empty">
              {readyMentions(images, audios).length === 0
                ? "Add an image or audio first."
                : "No match."}
            </p>
          ) : (
            filtered.map((spec, i) => {
              const active = i === menu.active;
              const name = displayName(spec.kind, spec.index, images, audios);
              return (
                <button
                  key={`${spec.kind}-${spec.index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={active ? "is-active" : undefined}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    pickMention(spec);
                  }}
                >
                  {spec.kind === "picture" && spec.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={spec.url} alt="" />
                  ) : (
                    <span className="prompt-inline-glyph" aria-hidden="true">
                      {spec.kind === "picture" ? "I" : "A"}
                    </span>
                  )}
                  <span>{name}</span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

export function PromptMediaChips({
  images,
  audios,
  onInsert,
}: {
  images: PromptChipItem[];
  audios: PromptChipItem[];
  onInsert: (spec: ChipSpec) => void;
}) {
  if (images.length === 0 && audios.length === 0) return null;
  return (
    <div className="prompt-chips" role="group" aria-label="Add images and audio into the prompt">
      {images.map((item, index) => (
        <PickerChip
          key={item.key}
          kind="picture"
          index={index + 1}
          item={item}
          onInsert={onInsert}
        />
      ))}
      {audios.map((item, index) => (
        <PickerChip
          key={item.key}
          kind="audio"
          index={index + 1}
          item={item}
          onInsert={onInsert}
        />
      ))}
    </div>
  );
}

function PickerChip({
  kind,
  index,
  item,
  onInsert,
}: {
  kind: ChipKind;
  index: number;
  item: PromptChipItem;
  onInsert: (spec: ChipSpec) => void;
}) {
  const ready = !item.storing && !item.error && Boolean(item.url);
  const short = item.label.trim() || (kind === "picture" ? `Image${index}` : `Audio${index}`);
  const status = item.storing ? "Storing" : item.error ? "Failed" : ready ? "Ready" : "Empty";
  return (
    <button
      type="button"
      className={`prompt-chip${ready ? "" : " is-muted"}`}
      disabled={!ready}
      aria-label={ready ? `Insert ${short} into prompt` : `${short} ${status}`}
      title={ready ? `Insert ${short}` : status}
      onClick={() => {
        if (ready) onInsert({ kind, index, url: item.url });
      }}
    >
      {kind === "picture" && ready ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.url} alt="" />
      ) : (
        <span className="prompt-chip-glyph" aria-hidden="true">
          {kind === "picture" ? "I" : "A"}
          {index}
        </span>
      )}
      <span className="prompt-chip-label">{short}</span>
    </button>
  );
}
