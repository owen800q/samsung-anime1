# Samsung TV app (Tizen)

`tv/` is a packaged Tizen web app for Samsung TVs. It uses the navigation of [samsung-hongguo-drama](https://github.com/owen800q/samsung-hongguo-drama): a collapsible icon sidebar, poster grids with spatial focus, a detail page with an episode grid, and a full-screen player with an on-screen control bar. Everything is operated with the TV remote. The app talks to this repository's Worker (`https://anime1.codeboxhk.com` by default), so the website and the TV app share the catalogue, playback, history, danmaku, pairing and remote control.

## Features

| Sidebar | What it does |
|-|-|
| 動畫目錄 | Presets (全部動畫, 當季新番, 連載中, 已完結, 劇場版, 排行榜) and year/season/format/topic filters. More titles load when focus nears the bottom. Bangumi scores load as on the website. |
| 搜尋 | Searches the whole catalogue. Press OK on the field to open the TV keyboard; recent searches are kept on the TV. |
| 觀看紀錄 | Cloud watch history. OK resumes the episode; the blue key opens the anime. |
| 裝置同步 | Shows a QR code and six-digit code so a phone can pair, then confirms the check number. You can also enter another screen's code with the number keys or the on-screen keypad. Also covers the private recovery code, the device name shown to phone remotes, and the online devices. |
| 設定 | Auto-play next episode, seek step, clear recent searches, key guide. |

The detail page shows the Bangumi cover, rating, tags, summary and last-watched reminder. The episode grid shows saved progress (with **載入較早集數** for older archive pages), and Bangumi short comments are paged. Unmatched titles try the Worker's title matching in the background, as on the website.

The player resolves the episode through `/api/resolve`, streams `/api/media`, and resumes saved progress. It starts automatically. Progress saves every 15 seconds and on pause, seek, end and exit. Danmaku is matched automatically and drawn on a canvas over the video. The danmaku panel (blue key) covers on/off, density, the source filter, retry, per-source time offsets, and manual pairing: search Bahamut/彈彈play by name, or enter a Bahamut, Bilibili or 彈彈play URL or a BV id.

**Phone remote.** The TV registers as a `tv` screen on its sync profile (WebSocket, with polling as a fallback). A phone on the same profile can pick an episode, and the TV opens and plays it. Pause/play, ±seconds, skip opening, and previous/next also work from the phone. The TV shows a notice naming the phone and publishes its playback state.

## Remote keys

| Key | Browsing | Player |
|-|-|-|
| Arrows | Move focus | Controls hidden: left/right seek, up shows controls, down opens episodes. Controls shown: move focus; left/right on the progress bar seeks |
| OK | Select | Play / pause |
| Back | Back; on the home screen, asks before exiting | Hide controls, then leave the player |
| Play/Pause, Play, Pause, Stop | — | As labelled |
| Fast-forward / Rewind | — | Seek three steps |
| Channel ▲▼, Next / Previous track | — | Next / previous episode |
| Red / Green / Yellow / Blue | Yellow: reset catalogue filters · Blue: anime details from history | Danmaku on/off / Episodes / Speed / Danmaku settings |
| 0–9 | Pairing code entry | — |

## Worker changes

The packaged app is loaded from `file://`, so its requests carry an opaque origin (`null`/`file://`, or none for media) and a Samsung TV user agent. The Worker accepts those requests in addition to same-origin pages (`tvAppRequest` and `allowedCaller` in `src/adapter.js`). Its API responses include CORS headers, including `OPTIONS` preflights for `Authorization`, and media is sent with `Cross-Origin-Resource-Policy: cross-origin`. Other websites remain blocked, as before. **Deploy this Worker version before using the TV app.** The current production Worker rejects the app with HTTP 403.

## Develop

```sh
cd tv
npm install
npm run dev     # http://localhost:5181 at 1920×1080
npm test
```

In a desktop browser, arrows, Enter, Esc (Back), Space (play/pause), PageUp/PageDown (previous/next) and digits stand in for the remote. The dev server relays `/api` (including the remote-control WebSocket) to `ANIME1_DEV_API`, which defaults to production. It removes the browser origin and sends a TV user agent.

## Package and install

```sh
cd tv
npm run package -- --profile <samsung-certificate-profile>   # build/Anime1TV.wgt
ANIME1_API=https://your-worker.example npm run package -- --profile <profile>   # another deployment
scripts/tv.sh <tv-ip> <profile>   # build, sign, install and launch on a TV in Developer mode
```

Signing and TV Developer-mode setup are the same as for samsung-hongguo-drama: a Samsung TV certificate profile whose distributor certificate lists the TV's DUID. The app ID is `Anime1TV01.Anime1TV` (package IDs must be 10 characters). Without the Tizen CLI, `npm run package` writes an unsigned widget, `build/Anime1TV-unsigned.wgt`.

### Updates

Installed TVs update themselves. The Worker build (`npm run build:tv-update`, run by `wrangler.jsonc`) publishes the TV app at `https://anime1.codeboxhk.com/tv-app/`. The app downloads a new build in the background and uses it from the next launch, so a push to `main` reaches TVs without reinstalling. See [ota/README.md](../ota/README.md).

Every push to `main` also publishes a GitHub release with the widget (`.github/workflows/release.yml`). Reinstall it only after changing `tv/tizen/config.xml`, the icon or the loader. The release is signed when the repository has the certificate secrets listed in ota/README.md.

The icon (`tv/tizen/icon.png`, source `icon-source.png`) was generated for this app; the website's `apple-touch-icon.png` uses the same artwork.

## Compatibility and validation

The app targets 2018+ Samsung TVs (Tizen 4.0+, Chromium 56+). It ships one classic IIFE bundle and fills missing library methods. It avoids `AbortController`/`AbortSignal.timeout`, `crypto.randomUUID`, Unicode property escapes and CSS flex `gap`. The danmaku title comparison reproduces the website's `\p{L}\p{N}` filter with explicit ranges (unit-tested).

Checked in desktop Chrome (1920×1080, keyboard as remote) against the production Worker through the dev proxy:

- Browse, search, detail with Bangumi metadata and comments, and playback with resume
- Danmaku auto-matching and rendering, and the danmaku panel with manual source search
- Watch history sync
- QR/code pairing with a simulated phone, including the profile switch
- Phone remote commands (play, toggle) over the WebSocket
- Focus restoration on Back

Not yet verified:

- Physical Samsung TV, the Tizen emulator, and real Chromium 56
- The cross-origin path from `file://` against a deployed Worker (unit-tested in `tests/worker.test.mjs`)
