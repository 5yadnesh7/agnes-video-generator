# Agnes Video MVP

Local Next.js operator bench for `agnes-video-v2.0` and `agnes-video-2.5-flash`. The browser talks only to this app; Agnes is called from Route Handlers.

## Setup

```bash
cp .env.example .env.local
# set AGNES_API_KEY in .env.local (never NEXT_PUBLIC_)
# AGNES_BASE_URL is optional; OpenAI-style /v1 suffix is ok
# PUBLIC_APP_URL = public https origin Agnes can fetch (not localhost)
npm run dev
```

Open http://localhost:3000

File uploads need `PUBLIC_APP_URL` set to a public `https://` origin (a tunnel or deployed host). Agnes fetches that origin; `localhost` is not reachable from Agnes. Paste a public URL still works without it.

On Vercel, connect a **Blob** store to the project (Storage → Blob). Serverless `/tmp` is not shared across requests, so `/api/media/...` 404s without Blob. The Blob integration sets `BLOB_READ_WRITE_TOKEN`.
