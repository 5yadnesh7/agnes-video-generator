"use client";

import { useRef, useState } from "react";

export type TimelineClip = {
  url?: string;
  lastFrameSrc?: string;
};

export type TimelineScene = {
  title: string;
  duration_sec: number;
};

export function ClipTimeline({
  scenes,
  clips,
  order,
  onReorder,
  disabled,
}: {
  scenes: TimelineScene[];
  clips: TimelineClip[];
  order: number[];
  onReorder: (next: number[]) => void;
  disabled?: boolean;
}) {
  const [showTiming, setShowTiming] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [playAt, setPlayAt] = useState(0);
  const dragFrom = useRef<number | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const totalSec = order.reduce((sum, i) => sum + (scenes[i]?.duration_sec ?? 0), 0);

  function move(from: number, to: number) {
    if (disabled || from === to || to < 0 || to >= order.length) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onReorder(next);
  }

  function playFrom(slot: number) {
    const idx = order[slot];
    const url = typeof idx === "number" ? clips[idx]?.url : undefined;
    const el = previewRef.current;
    if (!url || !el) return;
    setPlayAt(slot);
    setPlaying(true);
    if (el.src !== url) el.src = url;
    void el.play();
  }

  function togglePlay() {
    const el = previewRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      return;
    }
    playFrom(playAt < order.length ? playAt : 0);
  }

  function onEnded() {
    const next = playAt + 1;
    if (next < order.length) {
      playFrom(next);
      return;
    }
    setPlaying(false);
  }

  const currentScene = typeof order[playAt] === "number" ? scenes[order[playAt]] : undefined;
  const elapsedBase = order.slice(0, playAt).reduce((sum, i) => sum + (scenes[i]?.duration_sec ?? 0), 0);

  return (
    <div className="clip-timeline">
      <div className="tl-toolbar">
        <label className="tl-timing">
          <input
            type="checkbox"
            checked={showTiming}
            onChange={(e) => setShowTiming(e.target.checked)}
          />
          Show timing
        </label>
        <div className="tl-transport">
          <button type="button" className="btn" onClick={togglePlay} disabled={disabled || order.length === 0}>
            {playing ? "Pause" : "Play"}
          </button>
          <span className="mono">
            {formatClock(elapsedBase)} / {formatClock(totalSec)}
            {currentScene ? ` · S${(order[playAt] ?? 0) + 1}` : ""}
          </span>
        </div>
        <p className="hint">
          Clips start in generation order. Drag to change merge order only. Scene numbers stay.
        </p>
      </div>
      <video
        ref={previewRef}
        className="visually-hidden"
        playsInline
        onEnded={onEnded}
        onPause={() => {
          const el = previewRef.current;
          if (el && el.ended) return;
          if (el && !el.seeking) setPlaying(false);
        }}
      />
      <ol className="tl-strip">
        {order.map((sceneIndex, slot) => {
          const scene = scenes[sceneIndex];
          const clip = clips[sceneIndex];
          const sec = scene?.duration_sec ?? 0;
          return (
            <li
              key={`${sceneIndex}-${slot}`}
              className={`tl-block${playAt === slot && playing ? " is-active" : ""}`}
              style={{ width: `max(7.5rem, ${sec * 1.35}rem)` }}
              draggable={!disabled}
              onDragStart={() => {
                dragFrom.current = slot;
              }}
              onDragOver={(e) => {
                e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragFrom.current;
                dragFrom.current = null;
                if (from === null) return;
                move(from, slot);
              }}
              onDragEnd={() => {
                dragFrom.current = null;
              }}
            >
              <button
                type="button"
                className="tl-hit"
                disabled={disabled}
                aria-label={`Scene ${sceneIndex + 1} ${scene?.title ?? ""}. Move with Alt Left or Alt Right.`}
                onClick={() => playFrom(slot)}
                onKeyDown={(e) => {
                  if (e.altKey && e.key === "ArrowLeft") {
                    e.preventDefault();
                    move(slot, slot - 1);
                  }
                  if (e.altKey && e.key === "ArrowRight") {
                    e.preventDefault();
                    move(slot, slot + 1);
                  }
                }}
              >
                {clip?.lastFrameSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={clip.lastFrameSrc} alt="" />
                ) : (
                  <span className="tl-empty" aria-hidden="true" />
                )}
                <span className="tl-meta">
                  <span>
                    S{sceneIndex + 1} {scene?.title ?? ""}
                  </span>
                  {showTiming ? <span>{sec}s</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function formatClock(sec: number): string {
  const n = Math.max(0, sec);
  const m = Math.floor(n / 60);
  const s = n - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}
