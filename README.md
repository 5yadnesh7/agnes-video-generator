# Agnes Video MVP

Local Next.js operator bench for `agnes-video-v2.0` and `agnes-video-2.5-flash`. The browser talks only to this app; Agnes is called from Route Handlers.

## Setup

```bash
cp .env.example .env.local
# set AGNES_API_KEY for video create (Generate + Story clips)
# set AGNES_API_KEY2 for Story write / sheets / stills (never NEXT_PUBLIC_)
# Cloudflare R2 (required): R2_ACCOUNT_ID, R2_ENDPOINT, R2_ACCESS_KEY_ID,
#   R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL
# AGNES_BASE_URL is optional; OpenAI-style /v1 suffix is ok
npm run dev
```

Open http://localhost:3000

Uploads and generated sheets/stills go to **Cloudflare R2** (`uploads/` vs `generated/`). Agnes fetches `R2_PUBLIC_BASE_URL`. Paste a public `https://` URL still works without uploading.

On Vercel, set the same R2 env vars. Expire old files with an R2 **Object lifecycle rule** on the bucket (empty prefix = every object). Merge and last-frame extract use bundled `ffmpeg-static`. Long re-encodes can still hit the 300s Hobby timeout.
