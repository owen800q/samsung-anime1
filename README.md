# Anime1 TV — Cloudflare Pages

A standalone, anonymous player designed for Samsung TV browsers. No ChatGPT login, SDK, external fonts, CDN scripts, API keys, or browser-side playback cookies are required. This is an independent compatibility interface, not the official Anime1 website.

## Deploy

This repository is intended for the existing Cloudflare Pages Git integration:

- Production branch: `main`
- Framework preset: None
- Build command: `npm run build`
- Output directory: `dist`
- Node.js: 20 or newer
- Environment variables / secrets: none

`wrangler.jsonc` declares the Pages output directory. The generated `dist/` is also committed. Cloudflare must deploy **Pages with Functions**, not a static-file-only host: `dist/_worker.js` handles `/api/*`, while all other paths are static assets. Pushing to the connected production branch triggers deployment.

Open the project's `pages.dev` address directly on the TV. Paste an Anime1 episode URL or search for a title, choose **載入影片**, then **播放**. Arrow keys navigate controls; with the video focused, left/right seek ten seconds. This deployment does not use Cloudflare Access or any application login. Account-level Access policies, if configured separately, are outside this code.

## Playback changes

The original player obtains three short-lived playback cookies from the Anime1 API. A media request without them returned HTTP 403 during investigation; the same request with the API-issued cookies returned MP4 data. Samsung's exact failure remains unconfirmed without TV network logs.

The Pages Function follows that normal API exchange on the server and keeps credentials in bounded, temporary memory. The TV requests a same-origin MP4 stream at `/api/media?id=…`; credentials and upstream media URLs are never returned to the browser. Single byte ranges, seeking, HEAD responses, and streaming are preserved without buffering a whole episode. An explicit play button avoids relying on asynchronous autoplay.

Only numeric Anime1 episode pages and the validated video hosts are supported. Upstream redirects, denials, and unexpected formats are reported as errors. There is no arbitrary-URL proxy or access-control bypass. Videos remain dependent on the source site's availability and acceptance of Cloudflare requests. Successful server checks do not establish playback success on physical TV hardware.

## Development

There are no npm dependencies.

```sh
npm run build
npm test
```

Edit `src/`, then rebuild `dist/` before committing. Tests exercise anonymous routes, normal upstream credential handling, range/HEAD responses, validation, and failure behavior with deterministic mocked upstream responses.

`GET /api/health` should return JSON containing `"authentication":"none"`. A live playback check also needs a successful `/api/resolve` response and an MP4 byte-range response from `/api/media`; a healthy landing page alone does not prove video delivery.
