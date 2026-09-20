import type { NextConfig } from "next";

const ffmpegTrace = ["./node_modules/ffmpeg-static/**"];

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static", "aws4fetch"],
  outputFileTracingExcludes: {
    "*": [".data/**"],
  },
  outputFileTracingIncludes: {
    "/api/videos/merge": ffmpegTrace,
    "/api/videos/frame": ffmpegTrace,
    "/app/api/videos/merge": ffmpegTrace,
    "/app/api/videos/frame": ffmpegTrace,
  },
};

export default nextConfig;
