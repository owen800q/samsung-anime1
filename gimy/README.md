# Gimy TV

Independent Gimy frontend based on `owen800q/Samsung-anime1`. This subproject has its own Worker, assets, device profiles and history. Run commands from `gimy/`; the existing Anime1 app keeps its own configuration.

## Implemented

- Compact Traditional Chinese UI for phones, computers and TV remote focus navigation.
- Open a `https://gimytv.io/eps/…html` link; read episode lists and source catalogue/search results.
- Parse direct MP4/HLS sources without executing source scripts, ads or third-party iframe players.
- Native HLS where supported, bundled Hls.js fallback, seeking, previous/next episode and container fullscreen with canvas danmaku.
- Local progress plus durable cloud history, resume, six-digit/QR pairing, phone-to-TV remote control and merged danmaku sources/settings.
- Signed, time-limited media proxy URLs; HLS variants, segments, maps and AES key URLs are rewritten through the same-origin proxy. Range requests and response headers needed for seeking are preserved.

## Current verification limit

**The supplied live page has not played successfully in this environment.** Both the browser and HTTP fetch returned a Cloudflare blocking page for `https://gimytv.io/eps/202653122-zheng-pian.html` on 2026-10-01.

Player extraction currently supports JSON `player_*` assignments (raw, percent-encoded or base64 URLs) and direct `<video>/<source>` MP4/HLS sources. These formats and the catalogue/search URL convention are covered by synthetic fixtures, **not a captured live Gimy page**. A live source HTML/network capture is required to confirm its actual player schema, CDN domains, series paths and search endpoint. Unsupported/blocked players return an explicit error; there is no embedded iframe fallback and no bypass of source verification.

Removing source scripts prevents the original page's popups/ad scripts from loading. Ads already encoded into the video or HLS segments are not removed. Samsung hardware, iPhone playback and production Cloudflare runtime remain unverified.

## Local setup

```sh
cd gimy
npm ci
npm test
npm run build
```

Create an ignored `.dev.vars` containing a random secret at least 32 characters long and **exact CDN hostnames observed from the source**:

```text
GIMY_STREAM_SECRET="<random-secret-at-least-32-characters>"
GIMY_MEDIA_HOSTS="<observed-video-host>,<observed-key-host>"
```

No CDN hostname has been guessed or allowed by default. Every media redirect and HLS child/key URL must remain on the exact allowlist. Do not add IPs or private/internal hosts. Do not commit `.dev.vars`, credentials, copied cookies or signed URLs.

```sh
npm run dev
```

## Deploy a separate Cloudflare Worker

```sh
npx wrangler login
npx wrangler secret put GIMY_STREAM_SECRET
```

Set `GIMY_MEDIA_HOSTS` in this project's `wrangler.jsonc` to the verified comma-separated CDN hostnames. Then run `npm run deploy`. A new `gimy-tv` Worker owns its own `WATCH_HISTORY` Durable Object migration; this does not reuse Anime1's history database.

Optional 彈彈play support requires the user's own `DANDANPLAY_APP_ID` variable and `DANDANPLAY_APP_SECRET` secret. Without them, manual Bilibili/動畫瘋 sources remain available. Automatic matching only runs when the title has an explicit episode number and a unique exact series title match; manual mappings take precedence. Anime1's Bangumi catalogue IDs and LLM fallback are not assumed to be Gimy identities.

## Validation

`npm test` includes the inherited history/pairing/remote regression tests and Gimy-specific parser, signed URL, HLS rewrite, source-blocking and range/redirect integration tests. `npx wrangler deploy --dry-run` checks Cloudflare packaging without publishing. UI smoke checks use DOM emulation and fixtures; they do not establish real browser media playback.

The vendored DPlayer and QR code licenses remain in `src/vendor`. The build copies Hls.js and its license from the pinned dependency. Main Anime1 source is the reference for the reused interaction and synchronization modules.
