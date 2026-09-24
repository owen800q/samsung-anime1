# Device pairing

## Everyday use

TV/desktop: open **裝置同步** to display a QR code and six digits. Phone: scan with the camera or type the digits under **連接電視／電腦**, verify the matching code and confirm. QR generation stays on the device; no third-party QR service, login or common Wi-Fi network is required.

Pair the office computer with the phone once. Close the office computer, go home and pair the TV with that same phone/browser. Both retain access to the same cloud profile. The phone is not a relay and is not required during later viewing. Five-minute invitations are distinct from persistent profile access.

Avoid private browsing for durable access. Keep a private recovery code or another paired browser. Without either, this anonymous service cannot identify a lost profile. Clearing a browser does not delete its cloud history.

## Merge semantics

The requester displays a code; the approver scans/types it. Explicit approval copies requester cloud history/settings into the approver profile. The requester then saves the shared profile and returns to its previous screen. An initially empty phone can become the shared profile while preserving computer records.

The confirmation shows both record counts, warns about an empty phone/browser and requires a checkbox confirming the displayed code and merge. Pending local progress must upload before starting/approving. A failed import leaves the invitation pending without switching the requester.

Duplicate conflicts use the latest original server `updatedAt`, including intentional rewinds; ties keep the destination. Import preserves activity timestamps and increments destination revisions. Existing retention applies: a union over 500 keeps the newest 500 episodes/settings. Source cloud records are not deleted. Other devices on the requester's old profile stay unchanged; pair them individually as needed.

Private recovery is different: it switches to an existing profile without merging, with a separate checkbox explaining that behavior.

## Implementation and limits

Same-origin JSON `POST /api/pairing/{create,preview,approve,status,cancel,ack}` uses existing 128-bit Bearer authorization. The existing `WATCH_HISTORY` Durable Object namespace hosts `pairing:v1`. No new binding, migration, environment secret or external service is required. `/pairing-export` and `/pairing-import` are internal-only object routes, never publicly forwarded.

Invitations last five minutes. Six digits are random, zero-padded and reserved uniquely. Each requester also has a 256-bit poll secret, stored hashed. QR links contain a separate 192-bit temporary ticket in the fragment, not a permanent credential; the browser removes the fragment on opening. Scanning alone never approves. Preview issues an actor-bound confirmation secret; a new preview invalidates the previous one.

Creation is limited to 10 requests per client IP and profile per ten-minute window, plus 1,000 globally per window. Preview/approval share 30 requests per IP/window, including invalid guesses. Cloudflare's client-IP header is hashed; JSON cannot choose that key. Shared office IPs can encounter these conservative limits. This is not a replacement for platform-level distributed-abuse protection.

Only the requester's original profile and separate poll secret retrieve the approved shared credential. Delivery lasts 60 seconds and retries are supported until acknowledgment. Acknowledgment removes the credential; alarms remove expired sessions, indexes and rate records. Responses are no-store. Credentials are not included in query strings, external QR services or application logs.

Approval is serialized across cross-object imports. Import is transactional and idempotent for equal timestamps. If interrupted after import but before delivery, merged records remain stored and the requester may need a new invitation. The phone reports approval, not a guarantee that an offline TV received it. Expired codes never silently rotate; renewal is explicit.

Established devices still share the existing bearer. This is not a full OAuth implementation, account system or independently revocable device registry. Per-device revocation requires a separate authorization migration and is not offered here.

QR rendering vendors the MIT Kazuhiko Arase encoder from qrcode-terminal 0.12.0, with its license. Generation is offline with error correction M and a four-module quiet zone. No npm dependencies are added to production.

## Validation

```sh
npm run build
npm test
# Optional browser tooling only:
npm install --no-save --package-lock=false playwright@1.57.0 jsqr@1.4.0
npx playwright install chromium
node scripts/check-pairing.mjs
```

`PLAYWRIGHT_CHROMIUM_EXECUTABLE` chooses an installed browser; `PLAYWRIGHT_MODULE_PATH` selects a Playwright module. `PAIRING_ARTIFACT_DIR` chooses a screenshot directory.

Unit tests cover authorization, JSON size bounds, expiry, retries, explicit approval, secrets, cancellation, rate limits, competing approvals, cleanup, merge conflicts, failure and retention. Browser checks use the built Worker, SQLite storage and isolated office/phone/TV browser contexts. An independent QR decoder reads the rendered canvas before opening the phone confirmation. Checks include fallback digits, waiting-page reload, closing the office browser before TV linking, durable sync after invitation removal, resume position, failures and responsive focus behavior.

Catalogue and video media are fixtures. These checks do not establish live playback, physical Samsung TV behavior, Apple Safari behavior or deployed Cloudflare compatibility. Before production, run a preview Worker pairing/alarm smoke test and scan/control it on the physical TV and phone. Merging to the production main branch is a separate action.
