import { concatFilterArgs, parseFfmpegVideoProbe } from "./concat-filter.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const portraitLine =
  "Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 720x1280 [SAR 1:1 DAR 9:16], 42 kb/s, 25 fps, 25 tbr, 12800 tbn (default)";
const landscapeLine =
  "Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1280x720 [SAR 1:1 DAR 16:9], 42 kb/s, 24 fps, 24 tbr, 12288 tbn (default)";

const portrait = parseFfmpegVideoProbe(portraitLine);
assert(portrait !== null && portrait.width === 720 && portrait.height === 1280 && portrait.fps === 25, "9:16 probe");
const landscape = parseFfmpegVideoProbe(landscapeLine);
assert(landscape !== null && landscape.width === 1280 && landscape.height === 720 && landscape.fps === 24, "16:9 probe");

const match9 = concatFilterArgs({
  inputs: ["a.mp4", "b.mp4"],
  outputPath: "out.mp4",
  width: 720,
  height: 1280,
  fps: 25,
  scale: "none",
});
const match9Join = match9.join(" ");
assert(!match9Join.includes("1280x720"), "9:16 must not emit 1280x720");
assert(!match9Join.includes("scale="), "matching sizes must not scale");
assert(match9Join.includes("-crf 18"), "crf 18");
assert(match9.includes("-an"), "video-only");
assert(match9Join.includes("-preset medium"), "preset medium");
assert(match9Join.includes("[0:v][1:v]concat=n=2:v=1:a=0[v]"), "concat video-only");

const match16 = concatFilterArgs({
  inputs: ["a.mp4", "b.mp4"],
  outputPath: "out.mp4",
  width: 1280,
  height: 720,
  fps: 24,
  scale: "none",
});
assert(match16.join(" ").includes("-crf 18") && !match16.join(" ").includes("scale="), "16:9 match no scale");

const pad = concatFilterArgs({
  inputs: ["a.mp4", "b.mp4"],
  outputPath: "out.mp4",
  width: 720,
  height: 1280,
  fps: 25,
  scale: "pad",
});
const padJoin = pad.join(" ");
assert(padJoin.includes("force_original_aspect_ratio=decrease"), "pad decrease");
assert(padJoin.includes("pad=720:1280:"), "pad to first clip");
assert(!padJoin.includes("-s"), "never -s stretch");
assert(padJoin.includes("-an") && padJoin.includes("-crf 18"), "pad encoder");

process.stdout.write("concat-filter checks ok\n");
