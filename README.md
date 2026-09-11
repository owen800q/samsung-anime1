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

For a separate Pages project, the same `dist/` supports Pages advanced-mode Functions. The optional `wrangler.pages.jsonc` declares that output directory; deploy it with `npx wrangler pages deploy dist --config wrangler.pages.jsonc`. The existing Workers integration does not need changing. Cross-device history requires the SQLite Durable Object binding in the main Workers configuration; a separate Pages project would need an externally deployed Durable Object binding.

## Playback changes

The landing page is an anime library rather than an empty video screen. It browses the Anime1 catalogue by title, year, season, release status, format, and Bangumi topic. Selecting a card shows its description and loads the source episode list; selecting an episode opens the existing player. Returning to the library pauses playback and preserves the current filters.

The catalogue refreshes from `https://anime1.me/animelist.json` with a five-minute cache. Bangumi subject IDs are conservatively matched against Japanese and translated aliases in **bangumi-data**, with release year used to disambiguate duplicate names. Unmatched or changed names keep an Anime1-only card; an uncertain match is never silently selected. Format filters include unknown items separately. Topic browsing uses Bangumi's community tags and only returns the intersection with matched Anime1 entries, so unmatched shows are absent from topic-filtered results.

Bangumi's public `/v0/subjects/{id}` and `/v0/search/subjects` endpoints provide metadata and topic results. Subject metadata and covers are cached for 24 hours, and cover delivery is restricted to validated Bangumi image URLs. All browser requests stay on the same Cloudflare origin. Neither Bangumi nor ChatGPT login is required. A metadata outage leaves the Anime1 catalogue and playback available; a source catalogue outage displays a clearly marked bundled snapshot.

To refresh the bundled source snapshot and name mappings, run `node scripts/sync-catalog.mjs`, then `npm run build` and commit the generated files. Node 24 users behind an environment proxy can add `--use-env-proxy`. Normal Cloudflare builds are offline and do not download or regenerate these mappings. Newly listed Anime1 titles remain browsable immediately, with metadata added after the next mapping refresh.

Data attribution: [bangumi-data](https://github.com/bangumi-data/bangumi-data), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), transformed into a source-to-subject mapping; [Bangumi API](https://bangumi.github.io/api/) for descriptions, tags and ratings; Anime1 for its source index and episode listings. Cover artwork remains the property of its respective rights holders. Attribution links also appear in the interface.

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

## Watch history and device sync

Refresh and browser Back/Forward preserve catalogue filters, search results, anime details and episode selection using URL hash routes. The home page has a Watch History tab; detail pages and episode buttons show saved progress. Selecting an unfinished episode restores its last position after metadata loads, then the viewer presses Play. Completed episodes start again from zero.

All history records (episode, series, position, duration, completion and update revision) persist in **SQLite-backed Cloudflare Durable Objects**, using the transactional storage API. `wrangler.jsonc` creates the `WatchHistory` class with a `new_sqlite_classes` migration and binds `WATCH_HISTORY` on deployment. No ChatGPT account, external auth provider or manually created database ID is required.

Open **裝置同步** and copy the sync code from one device into another. Each randomly generated 128-bit code selects a private history profile; possession of the code permits reading and updating that profile. Tokens are sent only in the Authorization header and hashed before selecting a Durable Object. Different codes have separate histories. Connecting another profile switches histories rather than publishing or merging unrelated profiles.

Progress saves every 15 seconds during playback and on pause, seek, end or leaving the page. The server retains the 500 most recently updated episodes per profile. Local storage is only an offline cache/outbox; it is not the cross-device database. Reconnection, page focus, episode selection and a 30-second foreground poll refresh server history. Revision checks prevent an outdated offline write from silently overwriting newer server progress. Forced browser/TV shutdown can lose the last unsent seconds. History from before this feature cannot be reconstructed.

Resolve no longer waits for a redundant MP4 range probe; the real media request validates status and content type. Resolution has a 60-second overall deadline and the client stops waiting at 65 seconds, with a visible retry message. This reduces serial upstream waits but does not fix an unavailable source server.

Optional browser regression: with Node 24, Playwright and its Chromium available, run `node scripts/check-ux.mjs`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when using a separately installed Chromium binary. This checks two isolated browser profiles against a local SQLite test storage adapter; it does not replace a deployed Cloudflare smoke test.
