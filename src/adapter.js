// Source adapter for janime.cc (簡愛動漫): reads its public series pages and streams their MP4s.
// No upstream scripts execute, and no account or secret is needed.
export class PlaybackError extends Error {
    constructor(message, status = 502) { super(message); this.status = status; }
}
// Cloudflare (which fronts anime1) answers with these when anime1's own server is offline,
// overloaded or timing out. Nothing is wrong with the viewer's TV or this deployment.
const SOURCE_DOWN = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const RETRY_WAITS = [250, 750];
// The packaged Samsung TV app (tv/) loads from file:// and calls this Worker directly.
// It is recognised by a TV user agent with a file/opaque (or absent) origin. Real TVs also
// send cross-site fetches without any Origin; browsers always attach Origin to cross-site
// cors and WebSocket requests, so no website can produce that combination.
export function tvAppRequest(request) {
    const h = request.headers, origin = h.get("origin");
    if (!origin && h.get("sec-fetch-site") === "cross-site" && ["cors", "websocket"].includes(h.get("sec-fetch-mode"))) return true;
    return /Tizen|SMART-TV/i.test(h.get("user-agent") || "") && (!origin || origin === "null" || origin === "file://");
}
// Same-origin pages and the TV app only; other websites cannot use the API.
export function allowedCaller(request) {
    if (tvAppRequest(request)) return true;
    const origin = request.headers.get("origin");
    return !((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site");
}
const decoder = new TextDecoder();
const UA = "Mozilla/5.0 Anime1TV/1.0";
// The source moved from anime1.me to janime.cc. Every client (TV app, website, phone remote,
// saved history) names an episode by the handle https://anime1.me/<n>, so that handle stays:
// n = janime series ID × 1000 + episode key. The key is the episode number for whole numbers
// 0–899, else 900 + the episode's place among the other episodes (SP, 12.5, …).
// janime series IDs are Bangumi subject IDs.
export const SOURCE = "https://janime.cc";
const PER_SERIES = 1000;
const MAX_SERIES = 9999999;
export function episodeHandle(seriesId, key) {
    return "https://anime1.me/" + (Number(seriesId) * PER_SERIES + key);
}
export function episodeParts(handle) {
    const n = Number(new URL(episodeUrl(handle)).pathname.slice(1));
    const series = Math.floor(n / PER_SERIES);
    if (series < 1 || series > MAX_SERIES)
        throw new PlaybackError("這不是有效的單集網址，請從動畫目錄重新選擇。", 400);
    return { series, key: n % PER_SERIES };
}
export function episodeUrl(input) {
    if (typeof input !== "string" || input.length > 200)
        throw new PlaybackError("請輸入 Anime1 單集網址。", 400);
    let u;
    try {
        u = new URL(input.trim());
    }
    catch {
        throw new PlaybackError("網址格式不正確，請貼上 https://anime1.me/ 開頭的單集網址。", 400);
    }
    // A janime episode page pasted into the player maps to the same handle.
    if (u.protocol === "https:" && u.hostname === "janime.cc" && !u.port && !u.username && !u.password) {
        const series = u.pathname.match(/^\/(?:zh-tw\/|zh-cn\/)?watch\/(\d{1,7})\/?$/)?.[1];
        const ep = u.searchParams.get("ep");
        if (series && Number(series) >= 1 && /^\d{1,3}$/.test(ep || "") && Number(ep) < 900)
            return episodeHandle(series, Number(ep));
        throw new PlaybackError("請使用含集數的簡愛動漫單集網址（…/watch/編號?ep=集數）。", 400);
    }
    if (u.protocol !== "https:" || u.hostname !== "anime1.me" || u.port || u.username || u.password)
        throw new PlaybackError("只支援 https://anime1.me/ 開頭的單集頁面。", 400);
    if (u.pathname === "/" && /^\d{1,10}$/.test(u.searchParams.get("p") || ""))
        return "https://anime1.me/" + Number(u.searchParams.get("p"));
    if (!/^\/\d{1,10}\/?$/.test(u.pathname))
        throw new PlaybackError("請使用單集網址，而非首頁或分類頁面。", 400);
    return "https://anime1.me/" + Number(u.pathname.split("/")[1]);
}
// Only janime's own MP4 hosts (stream.janime.cc and siblings) are streamed.
export function mediaUrl(input) {
    let u;
    try {
        u = new URL(input);
    }
    catch {
        throw new PlaybackError("原站回傳的影片網址無效。");
    }
    if (u.protocol !== "https:" || !/^[a-z0-9-]+\.janime\.cc$/.test(u.hostname) || u.port || u.username || u.password || !/^\/[A-Za-z0-9_\-/.]+$/.test(u.pathname) || u.pathname.includes("..") || u.search || u.hash)
        throw new PlaybackError("原站影片格式或伺服器已變更，暫未支援。");
    return u.href;
}
export function plainText(html) {
    const names = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    return html.replace(/<[^>]*>/g, "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
        if (entity[0] !== "#")
            return names[entity.toLowerCase()] ?? all;
        const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }).replace(/\s+/g, " ").trim().slice(0, 350);
}
export async function upstream(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);
    try {
        return await fetch(url, { ...init, redirect: "manual", signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal, headers: { "User-Agent": UA, ...Object.fromEntries(new Headers(init.headers)) } });
    }
    catch {
        throw new PlaybackError("原站連線逾時或暫時無法連接，請稍後重試。", 504);
    }
    finally {
        clearTimeout(timer);
    }
}
export async function boundedText(r, max = 2000000, signal) {
    if (!r.body)
        return "";
    const reader = r.body.getReader();
    let timedOut = false;
    const cancel = () => { timedOut = true; void reader.cancel().catch(() => {}); };
    const timer = setTimeout(cancel, 35000);
    signal?.addEventListener("abort", cancel, {once:true});
    if (signal?.aborted) cancel();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            length += value.length;
            if (length > max) {
                void reader.cancel().catch(() => {});
                throw new PlaybackError("原站回應過大，無法處理。");
            }
            chunks.push(value);
        }
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        reader.releaseLock();
    }
    if (timedOut)
        throw new PlaybackError("原站回應逾時，請稍後重試。", 504);
    const bytes = new Uint8Array(length);
    let pos = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, pos);
        pos += chunk.length;
    }
    return decoder.decode(bytes);
}
// A source outage that clears within a moment should not reach the viewer: ask again, briefly.
// Only an answer that came back at once is repeated, so a slow timeout is never multiplied,
// and a refusal (403) is never retried.
async function upstreamPatient(url, init = {}) {
    for (let attempt = 0; ; attempt++) {
        const started = Date.now();
        const response = await upstream(url, init);
        if (!SOURCE_DOWN.has(response.status) || attempt >= RETRY_WAITS.length || Date.now() - started > 3000 || init.signal?.aborted) return response;
        void response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, RETRY_WAITS[attempt]));
    }
}
function checkStatus(r, stage) {
    if (r.ok) return;
    void r.body?.cancel();
    if (SOURCE_DOWN.has(r.status)) {
        const error = new PlaybackError(`${stage}失敗：Anime1 原站伺服器暫時無法連線（原站 ${r.status}）。這並非電視或網絡的問題，原站恢復後即可播放。`, 503);
        error.sourceDown = true;
        throw error;
    }
    throw new PlaybackError(`${stage}失敗（原站 ${r.status}）。${r.status === 403 ? "原站拒絕此部署的連線，並非電視設定問題。" : "請稍後重試。"}`);
}
// ---------- janime series pages ----------
// A series page (/zh-tw/watch/<id>) server-renders its player with every episode and its
// sources as Astro island props: JSON in an HTML attribute, each value wrapped as [type, value].
const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
function htmlEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
        if (entity[0] !== "#")
            return ENTITIES[entity.toLowerCase()] ?? all;
        const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}
function astroValue(wrapped, depth) {
    if (!Array.isArray(wrapped) || depth > 32)
        return null;
    const [type, value] = wrapped;
    if (type === 1)
        return Array.isArray(value) ? value.map(x => astroValue(x, depth + 1)) : [];
    if (type === 3)
        return String(value);
    if (type !== 0)
        return null;
    return value && typeof value === "object" && !Array.isArray(value) ? astroProps(value, depth + 1) : value;
}
function astroProps(object, depth = 0) {
    const out = {};
    for (const [key, value] of Object.entries(object))
        if (key !== "__proto__")
            out[key] = astroValue(value, depth);
    return out;
}
export function playerProps(html) {
    for (const match of html.matchAll(/<astro-island\b([^>]*)>/g)) {
        const attributes = {};
        for (const a of match[1].matchAll(/\s([a-z-]+)="([^"]*)"/g))
            attributes[a[1]] = a[2];
        if (!/\/EpisodePlayer\.[\w-]+\.js$/.test(attributes["component-url"] || ""))
            continue;
        try {
            const props = astroProps(JSON.parse(htmlEntities(attributes.props || "{}")));
            if (Array.isArray(props.episodes))
                return props;
        }
        catch { }
    }
    throw new PlaybackError("原站播放資料無法解析。");
}
// Traditional-Chinese subtitles first (as Anime1 had), then Simplified, then anything else.
function playableMp4(episode) {
    const candidates = [];
    for (const group of Object.values(episode.sources && typeof episode.sources === "object" ? episode.sources : {}))
        if (Array.isArray(group))
            candidates.push(...group);
    candidates.push({ url: episode.url, type: episode.type, lang: "" });
    const rank = lang => lang === "cht" ? 0 : lang === "chs" ? 1 : 2;
    const usable = candidates.filter(s => s && s.type === "mp4" && typeof s.url === "string").map(s => {
        try {
            return { url: mediaUrl(s.url), rank: rank(s.lang) };
        }
        catch {
            return null;
        }
    }).filter(Boolean).sort((a, b) => a.rank - b.rank);
    return usable[0]?.url || null;
}
function labelFor(slug) {
    if (/^\d+$/.test(slug))
        return { tag: String(Number(slug)).padStart(2, "0"), label: "第 " + Number(slug) + " 集" };
    if (/^\d+\.\d+$/.test(slug))
        return { tag: slug, label: "第 " + Number(slug) + " 集" };
    return { tag: slug, label: slug };
}
export function parseSeriesPage(html, seriesId) {
    const props = playerProps(html);
    if (props.animeId != null && String(props.animeId) !== String(seriesId))
        throw new PlaybackError("原站回傳了另一套動畫的資料。");
    const title = plainText(String(props.animeTitle || "")).slice(0, 200) || "Anime1 動畫";
    const ordered = props.episodes.filter(e => e && typeof e === "object" && /^[\w.\-]{1,20}$/.test(String(e.slug ?? ""))).map((episode, index) => ({ episode, index, sort: Number(episode.sort) }))
        .sort((a, b) => (Number.isFinite(a.sort) ? a.sort : 1e9) - (Number.isFinite(b.sort) ? b.sort : 1e9) || a.index - b.index);
    const taken = new Set();
    let other = 900;
    const episodes = [];
    for (const { episode } of ordered) {
        const slug = String(episode.slug);
        const key = /^\d{1,3}$/.test(slug) && Number(slug) < 900 ? Number(slug) : other < PER_SERIES ? other++ : -1;
        if (key < 0 || taken.has(key))
            continue;
        taken.add(key);
        const { tag, label } = labelFor(slug);
        const media = playableMp4(episode);
        const groups = episode.sources && typeof episode.sources === "object" ? Object.values(episode.sources).flat() : [];
        episodes.push({
            key, slug, label, url: episodeHandle(seriesId, key), title: title + " [" + tag + "]", media,
            mainlandOnly: !media && groups.some(s => s && s.type === "m3u8"),
            sourceUrl: SOURCE + "/zh-tw/watch/" + seriesId + "?ep=" + encodeURIComponent(slug),
        });
    }
    if (!episodes.length)
        throw new PlaybackError("原站暫時未有這套動畫的集數。", 422);
    const pageTitle = html.match(/<title>([^<]*)<\/title>/i)?.[1] || "";
    return { id: Number(seriesId), title, episodes, airing: pageTitle.includes("連載中") };
}
const seriesPages = new Map();
const seriesPending = new Map();
const SERIES_TTL = 5 * 60 * 1000;
export async function loadSeriesPage(seriesId, { refresh = false, signal } = {}) {
    const id = Number(seriesId);
    if (!Number.isInteger(id) || id < 1 || id > MAX_SERIES)
        throw new PlaybackError("動畫編號無效。", 400);
    const cached = seriesPages.get(id);
    if (!refresh && cached && cached.expires > Date.now())
        return cached.data;
    if (seriesPending.has(id))
        return seriesPending.get(id);
    const promise = (async () => {
        const page = await upstreamPatient(SOURCE + "/zh-tw/watch/" + id, { signal });
        if (page.status === 404) {
            void page.body?.cancel();
            throw new PlaybackError("原站找不到這套動畫，可能已下架。", 404);
        }
        checkStatus(page, "讀取動畫頁面");
        const data = parseSeriesPage(await boundedText(page, 4000000, signal), id);
        seriesPages.delete(id);
        while (seriesPages.size >= 32)
            seriesPages.delete(seriesPages.keys().next().value);
        seriesPages.set(id, { data, expires: Date.now() + SERIES_TTL });
        return data;
    })().finally(() => seriesPending.delete(id));
    seriesPending.set(id, promise);
    return promise;
}
// ---------- playback sessions ----------
const sessions = new Map();
const pending = new Map();
const MAX_SESSIONS = 32;
async function getSession(input, refresh = false) {
    const url = episodeUrl(input);
    const cached = sessions.get(url);
    if (!refresh && cached && cached.exp > Date.now()) return cached;
    if (pending.has(url)) return pending.get(url);
    if (pending.size >= 16) throw new PlaybackError("播放服務暫時繁忙，請稍後重試。", 429);
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PlaybackError("取得播放資料逾時，請重新載入。", 504)); }, 60000); });
    const promise = Promise.race([loadSession(url, controller.signal, refresh), deadline]).then(session => {
        sessions.delete(url);
        while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        sessions.set(url, session);
        return session;
    }).finally(() => { clearTimeout(timer); pending.delete(url); });
    pending.set(url, promise);
    return promise;
}
export async function resolveEpisode(input, refresh = false) {
    const session = await getSession(input, refresh);
    return { url: session.pageUrl, title: session.title, seriesId: session.seriesId, media: "/api/media?id=" + new URL(session.pageUrl).pathname.slice(1), previous: session.previous, next: session.next, sourceUrl: session.sourceUrl };
}
async function loadSession(url, signal, refresh) {
    const { series, key } = episodeParts(url);
    const data = await loadSeriesPage(series, { refresh, signal });
    const at = data.episodes.findIndex(e => e.key === key);
    if (at < 0)
        throw new PlaybackError("原站沒有這一集，可能已下架。請從集數列表重新選擇。", 404);
    const episode = data.episodes[at];
    if (!episode.media)
        throw new PlaybackError(episode.mainlandOnly ? "原站這一集只有中國大陸線路，海外暫時未能播放。可試其他集數，或稍後再試。" : "原站暫未提供這一集的影片，請稍後重新載入。", 422);
    const near = e => e ? { title: e.title, url: e.url } : null;
    return { url: episode.media, pageUrl: url, sourceUrl: episode.sourceUrl, exp: Date.now() + 30 * 60 * 1000, seriesId: String(series), title: episode.title, previous: near(data.episodes[at - 1]), next: near(data.episodes[at + 1]) };
}
// ---------- episode lists ----------
// janime lists a whole series on one page, so there is never a second page.
export async function listSeriesEpisodes(id, title, page = 1) {
    if (!/^\d{1,10}$/.test(String(id)) || !Number.isInteger(page) || page < 1 || page > 100) throw new PlaybackError('動畫編號或頁碼無效。', 400);
    if (page > 1) throw new PlaybackError('沒有更多集數。', 404);
    const data = await loadSeriesPage(Number(id));
    return { title: title || data.title, episodes: data.episodes.map(e => ({ url: e.url, title: e.title, label: e.label })), nextPage: null, airing: data.airing };
}
export async function listEpisodes(input, page = 1) {
    if (!Number.isInteger(page) || page < 1 || page > 100) throw new PlaybackError('集數列表頁碼無效。', 400);
    const { series } = episodeParts(input);
    return listSeriesEpisodes(series, null, page);
}
export async function streamMedia(request) {
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!/^\d{1,10}$/.test(id)) throw new PlaybackError("影片編號無效。", 400);
    const range = request.headers.get("Range");
    if (range && (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.length > 80))
        throw new PlaybackError("不支援此影片範圍請求。", 416);
    const ticket = await getSession("https://anime1.me/" + id);
    const headers = new Headers({ Referer: SOURCE + "/" });
    if (range)
        headers.set("Range", range);
    let response = await upstream(ticket.url, { method: request.method === "HEAD" ? "HEAD" : "GET", headers });
    for (let hops = 0; [301, 302, 303, 307, 308].includes(response.status) && hops < 2; hops++) {
        const next = new URL(response.headers.get("Location") || "", ticket.url);
        void response.body?.cancel();
        if (next.protocol !== "https:" || next.port || next.username || next.password)
            throw new PlaybackError("影片伺服器轉址無效。");
        response = await upstream(next.href, { method: request.method === "HEAD" ? "HEAD" : "GET", headers });
    }
    const output = new Headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": tvAppRequest(request) ? "cross-origin" : "same-origin" });
    if (response.status === 416) {
        const cr = response.headers.get("Content-Range");
        if (cr)
            output.set("Content-Range", cr);
        await response.body?.cancel();
        return new Response(null, { status: 416, headers: output });
    }
    checkStatus(response, "載入影片");
    if (!(response.headers.get("Content-Type") || "").toLowerCase().startsWith("video/mp4")) {
        await response.body?.cancel();
        throw new PlaybackError("影片伺服器未回傳 MP4 資料。");
    }
    for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"]) {
        const value = response.headers.get(name);
        if (value)
            output.set(name, value);
    }
    // Preserve the stream and byte-range response. Never buffer an episode in memory.
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: output });
}
export function errorResponse(error) {
    const known = error instanceof PlaybackError;
    // sourceDown tells the players that waiting, not reloading, is what brings the episode back.
    return Response.json({ error: known ? error.message : "播放服務暫時無法處理，請稍後重試。", ...(known && error.sourceDown ? { sourceDown: true } : {}) }, { status: known ? error.status : 500, headers: { "Cache-Control": "no-store" } });
}
