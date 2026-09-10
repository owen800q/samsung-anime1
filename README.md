# Anime1 TV — Cloudflare

A standalone, anonymous player designed for Samsung TV browsers. No ChatGPT login, SDK, external fonts, CDN scripts, API keys, or browser-side playback cookies are required. This is an independent compatibility interface, not the official Anime1 website.

## Deploy

GitHub checks confirm the existing integration is **Workers Builds: samsung-anime1**. The default configuration targets that connected Worker:

- Production branch: `main`
- Deploy command: `npx wrangler deploy`
- Build command: optional; Wrangler runs `node scripts/build.mjs`
- Worker entry: `dist/_worker.js`; static assets: `dist`
- Node.js: 20 or newer
- Environment variables / secrets: none

`wrangler.jsonc` declares the Worker and its `ASSETS` binding. The generated `dist/` is also committed. `/api/*` invokes the Worker; other paths serve static assets. `.assetsignore` excludes server code from public assets. Pushing to the connected production branch triggers deployment.

Open the Worker's `workers.dev` address directly on the TV. Paste an Anime1 episode URL or search for a title, choose **載入影片**, then **播放**. Arrow keys navigate controls; with the video focused, left/right seek ten seconds. This deployment does not use Cloudflare Access or any application login. Account-level Access policies, if configured separately, are outside this code.

For a separate Pages project, the same `dist/` supports Pages advanced-mode Functions. The optional `wrangler.pages.jsonc` declares that output directory; deploy it with `npx wrangler pages deploy dist --config wrangler.pages.jsonc`. The existing Workers integration does not need changing.

## Playback changes

The right sidebar discovers episodes from the current anime's category archive. It shows numbered buttons in episode order, highlights the current episode, and loads older archive pages on demand. Choosing a different anime refreshes the list. Episode discovery is independent of playback, so a list error does not interrupt the video.

The original player obtains three short-lived playback cookies from the Anime1 API. A media request without them returned HTTP 403 during investigation; the same request with the API-issued cookies returned MP4 data. Samsung's exact failure remains unconfirmed without TV network logs.

The Worker follows that normal API exchange on the server and keeps credentials in bounded, temporary memory. The TV requests a same-origin MP4 stream at `/api/media?id=…`; credentials and upstream media URLs are never returned to the browser. Single byte ranges, seeking, HEAD responses, and streaming are preserved without buffering a whole episode. An explicit play button avoids relying on asynchronous autoplay.

Only numeric Anime1 episode pages and the validated video hosts are supported. Upstream redirects, denials, and unexpected formats are reported as errors. There is no arbitrary-URL proxy or access-control bypass. Videos remain dependent on the source site's availability and acceptance of Cloudflare requests. Successful server checks do not establish playback success on physical TV hardware.

## Development

There are no npm dependencies.

```sh
npm run build
npm test
```

Edit `src/`, then rebuild `dist/` before committing. Tests exercise anonymous routes, normal upstream credential handling, range/HEAD responses, validation, and failure behavior with deterministic mocked upstream responses.

`GET /api/health` should return JSON containing `"authentication":"none"`. A live playback check also needs a successful `/api/resolve` response and an MP4 byte-range response from `/api/media`; a healthy landing page alone does not prove video delivery.
