export type VideoProbe = {
  width: number;
  height: number;
  fps: number | null;
};

export type ConcatScale = "none" | "pad";

export function parseFfmpegVideoProbe(stderr: string): VideoProbe | null {
  const stream = stderr.match(/Stream #.*Video:.*$/m);
  const line = stream?.[0] ?? stderr;
  const size = line.match(/\b(\d{2,5})x(\d{2,5})\b/);
  if (!size) return null;
  const width = Number(size[1]);
  const height = Number(size[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) return null;
  const fpsMatch = line.match(/\b(\d+(?:\.\d+)?)\s*fps\b/i);
  let fps: number | null = null;
  if (fpsMatch) {
    const n = Number(fpsMatch[1]);
    if (Number.isFinite(n) && n > 0 && n <= 240) fps = n;
  }
  return { width, height, fps };
}

export function concatFilterArgs(options: {
  inputs: string[];
  outputPath: string;
  width: number;
  height: number;
  fps: number | null;
  scale: ConcatScale;
}): string[] {
  const { inputs, outputPath, width, height, fps, scale } = options;
  const n = inputs.length;
  const args: string[] = ["-y"];
  for (const input of inputs) {
    args.push("-i", input);
  }

  let filter: string;
  if (scale === "none") {
    const labels = inputs.map((_, i) => `[${i}:v]`).join("");
    filter = `${labels}concat=n=${n}:v=1:a=0[v]`;
  } else {
    const fpsPart = fps !== null && fps > 0 ? `,fps=${fps}` : "";
    const prepared = inputs
      .map(
        (_, i) =>
          `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1${fpsPart},format=yuv420p[v${i}]`,
      )
      .join(";");
    const labels = inputs.map((_, i) => `[v${i}]`).join("");
    filter = `${prepared};${labels}concat=n=${n}:v=1:a=0[v]`;
  }

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  );
  return args;
}
