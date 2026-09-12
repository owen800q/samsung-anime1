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

Open the Worker's `workers.dev` address directly on the TV. Browse or search the anime catalogue, select a title, choose an episode below the details, then **播放**. Arrow keys navigate controls; with the video focused, left/right seek ten seconds. This deployment does not use Cloudflare Access or any application login. Account-level Access policies, if configured separately, are outside this code.

For a separate Pages project, the same `dist/` supports Pages advanced-mode Functions. The optional `wrangler.pages.jsonc` declares that output directory; deploy it with `npx wrangler pages deploy dist --config wrangler.pages.jsonc`. The existing Workers integration does not need changing. Cross-device history requires the SQLite Durable Object binding in the main Workers configuration; a separate Pages project would need an externally deployed Durable Object binding.

## Playback changes

The landing page is an anime library rather than an empty video screen. It browses the Anime1 catalogue by title, year, season, release status, format, and Bangumi topic. Selecting a card shows its description and loads the source episode list; selecting an episode opens the existing player. Returning to the library pauses playback and preserves the current filters.

The catalogue refreshes from `https://anime1.me/animelist.json` with a five-minute cache. Bangumi subject IDs are conservatively matched against Japanese and translated aliases in **bangumi-data**, with release year used to disambiguate duplicate names. Unmatched or changed names keep an Anime1-only card; an uncertain match is never silently selected. Format filters include unknown items separately. Topic browsing uses Bangumi's community tags and only returns the intersection with matched Anime1 entries, so unmatched shows are absent from topic-filtered results.

Bangumi's public `/v0/subjects/{id}` and `/v0/search/subjects` endpoints provide metadata and topic results. Subject metadata and covers are cached for 24 hours, and cover delivery is restricted to validated Bangumi image URLs. All browser requests stay on the same Cloudflare origin. Neither Bangumi nor ChatGPT login is required. A metadata outage leaves the Anime1 catalogue and playback available; a source catalogue outage displays a clearly marked bundled snapshot.

Anime detail pages also show **Bangumi 評論**: public subject short comments, newest first, with author names, optional scores and dates. Comments load independently of episode selection, 20 per page, with previous/next controls, retry and a link to the original comment page. Unmatched anime and empty comment lists have distinct messages. Comment text is rendered literally, never as HTML.

`GET /api/comments?id=<Anime1 category ID>&page=1` resolves the existing catalogue mapping and reads `https://next.bgm.tv/p1/subjects/{subjectID}/comments?limit=20&offset=…`, cached for five minutes. This is Bangumi's website API, separate from v0; its contract is recorded in [Bangumi's OpenAPI schema](https://github.com/bangumi/server-private/blob/master/openapi.json). No login credentials are forwarded. Website API changes or upstream outages display a retry state without blocking playback. This displays subject short comments, not episode discussions or long reviews.

To refresh the bundled source snapshot and name mappings, run `node scripts/sync-catalog.mjs`, then `npm run build` and commit the generated files. Node 24 users behind an environment proxy can add `--use-env-proxy`. Normal Cloudflare builds are offline and do not download or regenerate these mappings. Newly listed Anime1 titles remain browsable immediately, with metadata added after the next mapping refresh.

Data attribution: [bangumi-data](https://github.com/bangumi-data/bangumi-data), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), transformed into a source-to-subject mapping; [Bangumi API](https://bangumi.github.io/api/) for descriptions, tags and ratings; Anime1 for its source index and episode listings. Cover artwork remains the property of its respective rights holders. Attribution links also appear in the interface.

The full-width episode picker below the anime details or player controls discovers episodes from the current anime's category archive. It uses the page scroll instead of a nested scroll area, so TV remote focus remains visible. The redundant URL-entry/sidebar search controls have been removed; old search links open the catalogue search. It shows numbered buttons in episode order, highlights the current episode, and loads older archive pages on demand. Choosing a different anime refreshes the list. Episode discovery is independent of playback, so a list error does not interrupt the video.

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

## Watch history and device sync

Refresh and browser Back/Forward preserve catalogue filters, search results, anime details and episode selection using URL hash routes. The home page has a Watch History tab; detail pages and episode buttons show saved progress. Selecting an unfinished episode restores its last position after metadata loads, then the viewer presses Play. Completed episodes start again from zero.

All history records (episode, series, position, duration, completion and update revision) persist in **SQLite-backed Cloudflare Durable Objects**, using the transactional storage API. `wrangler.jsonc` creates the `WatchHistory` class with a `new_sqlite_classes` migration and binds `WATCH_HISTORY` on deployment. No ChatGPT account, external auth provider or manually created database ID is required.

Open **裝置同步** and copy the sync code from one device into another. Each randomly generated 128-bit code selects a private history profile; possession of the code permits reading and updating that profile. Tokens are sent only in the Authorization header and hashed before selecting a Durable Object. Different codes have separate histories. Connecting another profile switches histories rather than publishing or merging unrelated profiles.

Progress saves every 15 seconds during playback and on pause, seek, end or leaving the page. The server retains the 500 most recently updated episodes per profile. Local storage is only an offline cache/outbox; it is not the cross-device database. Reconnection, page focus, episode selection and a 30-second foreground poll refresh server history. Revision checks prevent an outdated offline write from silently overwriting newer server progress. Forced browser/TV shutdown can lose the last unsent seconds. History from before this feature cannot be reconstructed.

Resolve no longer waits for a redundant MP4 range probe; the real media request validates status and content type. Resolution has a 60-second overall deadline and the client stops waiting at 65 seconds, with a visible retry message. This reduces serial upstream waits but does not fix an unavailable source server.

Optional browser regression: with Node 24, Playwright and its Chromium available, run `node scripts/check-ux.mjs`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when using a separately installed Chromium binary. This checks two isolated browser profiles against a local SQLite test storage adapter; it does not replace a deployed Cloudflare smoke test.

### Comment checks

Run `npm test` and `npm run build`. With Playwright and Chromium installed, run `node scripts/check-comments.mjs` for fixture-backed browser checks of safe rendering, pagination/retry, reload, stale responses, unmatched/empty states, independent episode loading, and mobile width. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when using a system Chromium. These checks do not verify the live Bangumi service or physical Samsung TV hardware.
# Episode danmaku (Bahamut / Bilibili)

The player supports public Bahamut Anime Crazy danmaku and Bilibili danmaku without a dandanplay App ID. These are independent adapters; the pending dandanplay application is not used yet.

In the player, open **選擇彈幕來源**. Search an anime name on Bahamut or paste a full `https://ani.gamer.com.tw/animeVideo.php?sn=…` link. For Bilibili, paste a `BV…` video (including `?p=2` for split videos), `/bangumi/play/ep…`, or `/bangumi/play/ss…` URL, then choose the matching episode. Short links are not followed. Automatic Bahamut matching only saves a match when the catalogue title or alias, release year and numeric episode all match uniquely. Specials, ambiguous matches, missing years and titles with no source need manual selection; coverage for every anime is not guaranteed.

Mappings and offsets are stored per Anime1 episode in the existing SQLite Durable Object, isolated by the device sync profile. They survive reloads and refresh across devices on focus and a 30-second foreground poll. Concurrent edits use revisions; stale edits show the latest setting instead of overwriting it. Up to 500 mappings are kept per profile. Clearing a mapping prevents automatic rematching until it ages out. A failed save is reported and must be retried; there is no offline mapping outbox. No new database binding or account setup is needed with the existing Workers configuration.

The canvas overlay follows `video.currentTime`, including pause, buffering, seeking, resume and playback speed. Scrolling, top and bottom comments are supported; scripted/special modes are ignored. Density limits reduce crowding and leave the native controls clear. The on/off and density preferences are local to the device. Offsets range from −300 to +300 seconds; positive values delay comments. Use the player's **全螢幕** button to fullscreen the video container with its overlay. Native video-only fullscreen, including iPhone native fullscreen, does not include webpage overlays; use inline playback there.

Server routes:

- `GET /api/danmaku/search?q=…`: Bahamut title search.
- `GET /api/danmaku/resolve?url=…`: list source episodes/CIDs from a supported URL.
- `GET /api/danmaku/comments?provider=bahamut|bilibili&id=…&segment=1`: normalized comments; Bilibili requests the relevant six-minute protobuf segment, with adjacent segments near boundaries.
- `GET/PUT /api/danmaku/settings?episode=…`: private profile settings, using the same Bearer sync code as watch history.

Requests only target fixed source API hosts, reject redirects, time out after 12 seconds including the response body, and limit response bodies to 4 MB and output to 20,000 comments per request. Successful public responses are cached for ten minutes; errors are not cached. No source login credentials, dandanplay secrets, geolocation proxies or third-party shared API servers are used. Upstream restrictions, rate limits or response changes can prevent loading; retry or choose another source. Video playback is independent of these requests.

Protocol references: [Bahamut adapter endpoints and response fields](https://github.com/huangxd-/danmu_api/blob/main/danmu_api/sources/bahamut.js), [Bilibili adapter endpoints](https://github.com/huangxd-/danmu_api/blob/main/danmu_api/sources/bilibili.js). This repository implements its own bounded adapters and wire decoder rather than bundling that server.

Validation: `npm test` includes source parsing, response normalization, protobuf decoding, source failure handling, private per-episode persistence/conflicts and VM-based tests of the actual overlay controller (seek, pause, offset, toggling and stale-response isolation). Live source calls timed out in the development environment, and its browser blocked local preview access. Real upstream responses, visual browser layout and physical Samsung TV/iPhone playback still need deployment smoke testing. These tests do not establish live source availability.
