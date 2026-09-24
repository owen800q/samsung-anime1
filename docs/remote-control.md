# Phone remote control

## Everyday use

1. Pair the phone and the TV once with **裝置同步** (see [device pairing](device-pairing.md)).
2. Leave the website open on the TV.
3. On the phone, tap **📺 遙控**, choose the TV, then **在手機揀動畫**.
4. Search, scroll and tap an episode (or **繼續觀看** in the history) on the phone. The TV opens that episode, resumes from the shared progress and starts playing. The TV shows a short notice naming the phone.
5. The bar at the bottom of the phone shows what the TV is playing. Use it to pause/play, or open it for −10 s, +10 s, skip opening (+90 s), previous and next episode.
6. Tap **✕** on the bar to stop remote control; episodes then play on the phone again.

Rename a device under **此裝置名稱** in the remote panel (for example 客廳電視). The remote button only appears when another TV or computer on the same profile is online.

If the TV does not start playing by itself (a browser autoplay block), the play button is focused on the TV; press OK once.

## How it works

Devices that share a sync profile already share that profile's `WATCH_HISTORY` Durable Object. The same object relays remote commands, so no new binding, migration or secret is needed and a phone can only reach screens on its own profile.

- `GET /api/remote/socket` upgrades to a WebSocket. Browsers cannot set an `Authorization` header on WebSockets, so the profile is sent as a second `Sec-WebSocket-Protocol` value (never in the URL); the response only echoes `anime1-remote.v1`. The same-origin check in the Worker blocks cross-site sockets. Sockets use the hibernation API and are tagged by device, so an idle TV costs nothing and a command reaches only its target. `ping` heartbeats are answered without waking the object.
- If the socket cannot open (blocked proxy, older browser), the page falls back to `POST /api/remote/poll` every 2 seconds while visible (10 seconds for an idle phone, 15 seconds when hidden) and retries the socket after five minutes.
- `POST /api/remote/send` sends a validated command (`play`, `toggle`, `seek` up to ±600 s, `next`, `previous`) to one online device. Commands are queued for 30 seconds only, so a reconnecting TV never replays an old play request.
- `POST /api/remote/state` publishes what a screen is playing (episode, title, position, duration, paused). Screens publish on changes and every 10 seconds while playing, and only when another device is online.

Device ids are random per browser (`anime1-device` in local storage) and are not credentials. At most 20 devices are remembered per profile. A device counts as online while its socket is open or for 25 seconds after its last poll.

Anyone holding the profile (a paired device or the recovery code) can control the other devices on that profile, just as they can read and change its history.

## Validation

```sh
npm run build
npm test
node scripts/check-remote.mjs   # needs Playwright, as for check-pairing.mjs
```

Unit tests cover authorization, command and state validation, profile isolation, offline targets, command expiry, device limits, and the WebSocket path (tagging, push, presence and replay after reconnect) with a fake socket pair. The browser check drives a TV page and a touch phone page against the built Worker: discovery, search and pick on the phone, TV playback from the shared resume point, pause, seek, next episode, now-playing feedback, stopping remote control, narrow layouts and zero page errors. The fixture server has no WebSocket upgrade, so the browser check exercises the polling fallback; the WebSocket path is unit-tested only. Physical Samsung TV autoplay and deployed Cloudflare WebSockets still need a manual smoke test.
