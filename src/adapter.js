// Public-page adapter and credential-preserving stream. No upstream scripts execute.
// Credentials stay in bounded, temporary server memory. No account or secret is needed.
export class PlaybackError extends Error {
    constructor(message, status = 502) { super(message); this.status = status; }
}
const decoder = new TextDecoder();
const UA = "Mozilla/5.0 Anime1TV/1.0";
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
    if (u.protocol !== "https:" || u.hostname !== "anime1.me" || u.port || u.username || u.password)
        throw new PlaybackError("只支援 https://anime1.me/ 開頭的單集頁面。", 400);
    if (u.pathname === "/" && /^\d{1,10}$/.test(u.searchParams.get("p") || ""))
        return "https://anime1.me/" + u.searchParams.get("p");
    if (!/^\/\d{1,10}\/?$/.test(u.pathname))
        throw new PlaybackError("請使用單集網址，而非首頁或分類頁面。", 400);
    return "https://anime1.me/" + u.pathname.split("/")[1];
}
export function mediaUrl(input) {
    let u;
    try {
        u = new URL(input, "https://anime1.me/");
    }
    catch {
        throw new PlaybackError("原站回傳的影片網址無效。");
    }
    if (u.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)?v\.anime1\.me$/.test(u.hostname) || u.port || u.username || u.password || !/^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\.mp4$/.test(u.pathname) || u.search || u.hash)
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
function checkStatus(r, stage) {
    if (!r.ok) {
        void r.body?.cancel();
        throw new PlaybackError(`${stage}失敗（原站 ${r.status}）。${r.status === 403 ? "原站拒絕此部署的連線，並非電視設定問題。" : "請稍後重試。"}`);
    }
}
function cookieLines(headers) {
    const h = headers;
    if (h.getSetCookie)
        return h.getSetCookie();
    if (h.getAll)
        return h.getAll("Set-Cookie");
    return (headers.get("Set-Cookie") || "").split(/,(?=\s*[^\s;,=]+=)/);
}
function playbackCookies(headers, source) {
    const u = new URL(source);
    const values = [];
    let ttl = 3600;
    for (const line of cookieLines(headers)) {
        const parts = line.split(";").map(x => x.trim());
        const pair = parts[0];
        if (!/^[eph]=[^;\r\n]+$/.test(pair))
            continue;
        const attributes = {};
        for (const part of parts.slice(1)) {
            const at = part.indexOf("=");
            attributes[(at < 0 ? part : part.slice(0, at)).toLowerCase()] = at < 0 ? "" : part.slice(at + 1);
        }
        const domain = attributes.domain?.replace(/^\./, "").toLowerCase();
        if (domain !== "v.anime1.me" || !(u.hostname === domain || u.hostname.endsWith("." + domain)) || attributes.path !== u.pathname)
            continue;
        if (attributes["max-age"] && Number.isFinite(Number(attributes["max-age"])))
            ttl = Math.min(ttl, Number(attributes["max-age"]));
        if (attributes.expires && Number.isFinite(Date.parse(attributes.expires)))
            ttl = Math.min(ttl, (Date.parse(attributes.expires) - Date.now()) / 1000);
        values.push(pair);
    }
    if (values.length !== 3 || new Set(values.map(x => x[0])).size !== 3 || ttl < 60)
        throw new PlaybackError("原站未提供有效播放憑證，請重新載入。");
    return { cookie: values.join("; "), exp: Date.now() + Math.floor(ttl - 30) * 1000 };
}
const sessions = new Map();
const pending = new Map();
const MAX_SESSIONS = 32;
async function getSession(input, refresh = false) {
    const url = episodeUrl(input);
    const cached = sessions.get(url);
    if (!refresh && cached && cached.exp > Date.now() && cached.cachedAt + 20 * 60 * 1000 > Date.now()) return cached;
    if (pending.has(url)) return pending.get(url);
    if (pending.size >= 16) throw new PlaybackError("播放服務暫時繁忙，請稍後重試。", 429);
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PlaybackError("取得播放資料逾時，請重新載入。", 504)); }, 60000); });
    const promise = Promise.race([loadSession(url, controller.signal), deadline]).then(session => {
        sessions.delete(url);
        while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        sessions.set(url, { ...session, cachedAt: Date.now() });
        return session;
    }).finally(() => { clearTimeout(timer); pending.delete(url); });
    pending.set(url, promise);
    return promise;
}
export async function resolveEpisode(input, refresh = false) {
    const session = await getSession(input, refresh);
    return { url: session.pageUrl, title: session.title, seriesId: session.seriesId, media: "/api/media?id=" + new URL(session.pageUrl).pathname.slice(1), previous: session.previous, next: session.next };
}
function seriesIdFromHTML(html) {
    for(const a of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
        if(plainText(a[2])!=='全集連結')continue;
        try{const u=new URL(plainText(a[1]),'https://anime1.me');const id=u.searchParams.get('cat');if(u.origin==='https://anime1.me'&&/^\d{1,10}$/.test(id||''))return id;}catch{}
    }
    return null;
}
function related(html, label) {
    for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const title = plainText(match[2]);
        if (title === label) {
            try {
                return { title, url: episodeUrl(new URL(plainText(match[1]), "https://anime1.me").href) };
            }
            catch { }
        }
    }
    return null;
}
async function loadSession(input, signal) {
    const url = episodeUrl(input);
    const page = await upstream(url, {signal});
    checkStatus(page, "讀取動畫頁面");
    const html = await boundedText(page, 2000000, signal);
    const match = html.match(/\bdata-apireq=["']([^"']+)["']/i);
    if (!match)
        throw new PlaybackError("此頁沒有可播放的單集，或原站要求額外驗證。請使用單集網址。", 422);
    let data;
    try {
        data = decodeURIComponent(match[1]);
        JSON.parse(data);
    }
    catch {
        throw new PlaybackError("原站播放資料無法解析。");
    }
    const api = await upstream("https://v.anime1.me/api", { method: "POST", signal, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://anime1.me", Referer: url }, body: new URLSearchParams({ d: data }).toString() });
    checkStatus(api, "取得播放資料");
    let payload;
    try {
        payload = JSON.parse(await boundedText(api, 32768, signal));
    }
    catch {
        throw new PlaybackError("原站播放服務回傳了無法讀取的資料。");
    }
    const source = payload.s?.find(x => x.type === "video/mp4" || x.src?.endsWith(".mp4"));
    if (!source)
        throw new PlaybackError("原站暫未提供影片，請稍後重新載入。");
    const target = mediaUrl(source.src);
    const credentials = playbackCookies(api.headers, target);
    // Validate MP4 on the actual media request; an extra range probe delays resolve.
    const titleMatch = html.match(/<h[1-3]\b[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    return { url: target, pageUrl: url, ...credentials, seriesId: seriesIdFromHTML(html), title: titleMatch ? plainText(titleMatch[1]) : "Anime1 動畫", previous: related(html, "上一集"), next: related(html, "下一集") };
}
export async function searchEpisodes(query) {
    if (!query.trim() || query.length > 80)
        throw new PlaybackError("請輸入 1 至 80 字的動畫名稱。", 400);
    const response = await upstream("https://anime1.me/?s=" + encodeURIComponent(query.trim()));
    checkStatus(response, "搜尋動畫");
    const html = await boundedText(response);
    const episodes = [];
    const seen = new Set();
    for (const match of html.matchAll(/<h2\b[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        try {
            const url = episodeUrl(plainText(match[1]));
            if (!seen.has(url)) {
                episodes.push({ url, title: plainText(match[2]) });
                seen.add(url);
            }
        }
        catch { }
    }
    return { episodes: episodes.slice(0, 30) };
}
// Episode discovery is independent of the playback session: a listing failure
// must never stop a video that is already playing.
const episodeLists = new Map();
function categoryLink(html) {
    for (const match of html.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/gi)) {
        const rel = match[1].match(/\brel=["']([^"']+)["']/i)?.[1] || '';
        const href = match[1].match(/\bhref=["']([^"']+)["']/i)?.[1];
        if (!rel.split(/\s+/).includes('category') || !href) continue;
        try {
            const url = new URL(plainText(href), 'https://anime1.me');
            if (url.origin === 'https://anime1.me' && !url.username && !url.password && !url.search && !url.hash && /^\/category\/[^/]+\/[^/]+\/?$/.test(url.pathname)) return { url: url.href.replace(/\/$/, ''), title: plainText(match[2]) };
        } catch {}
    }
    throw new PlaybackError('原站未提供這套動畫的集數列表。', 422);
}
export async function listEpisodes(input, page = 1) {
    const url = episodeUrl(input);
    if (!Number.isInteger(page) || page < 1 || page > 100) throw new PlaybackError('集數列表頁碼無效。', 400);
    const key = url + ':' + page;
    const cached = episodeLists.get(key);
    if (cached && cached.expires > Date.now()) return cached.data;
    const response = await upstream(url);
    checkStatus(response, '讀取動畫分類');
    const series = categoryLink(await boundedText(response));
    const target = series.url + (page > 1 ? '/page/' + page : '');
    let archive = await upstream(target);
    // WordPress can normalize escaping or a trailing slash. Follow only the
    // same category/page, never a different host or arbitrary redirect.
    for (let count = 0; [301,302,307,308].includes(archive.status) && count < 2; count++) {
        const location = archive.headers.get('location');
        await archive.body?.cancel();
        const next = new URL(location || '', target);
        if (!location || next.origin !== 'https://anime1.me' || next.username || next.password || next.search || next.hash || decodeURIComponent(next.pathname).replace(/\/$/, '') !== decodeURIComponent(new URL(target).pathname)) throw new PlaybackError('原站集數列表網址已變更。');
        archive = await upstream(next.href);
    }
    checkStatus(archive, '讀取集數列表');
    const html = await boundedText(archive);
    const data = parseEpisodeArchive(html, series, page);
    while (episodeLists.size >= 32) episodeLists.delete(episodeLists.keys().next().value);
    episodeLists.set(key, { data, expires: Date.now() + 5 * 60 * 1000 });
    return data;
}
function parseEpisodeArchive(html, series, page) {
    const target = series.url;
    const episodes = []; const seen = new Set();
    for (const match of html.matchAll(/<h2\b[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        try {
            const episode = episodeUrl(new URL(plainText(match[1]), 'https://anime1.me').href);
            if (seen.has(episode)) continue;
            const title = plainText(match[2]);
            const number = title.match(/[\[［]([^\]］]+)[\]］]\s*$/)?.[1];
            episodes.push({ url: episode, title, label: number ? (/^\d+(?:\.\d+)?$/.test(number) ? '第 ' + Number(number) + ' 集' : number) : title });
            seen.add(episode);
        } catch {}
    }
    if (!episodes.length) throw new PlaybackError('暫時讀不到集數列表，請稍後重試。', 422);
    episodes.sort((a,b) => a.title.localeCompare(b.title, 'zh-Hant', {numeric:true}));
    let nextPage = null;
    const base = decodeURIComponent(new URL(series.url).pathname);
    for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
        try {
            const link = new URL(plainText(match[1]), target);
            if (link.origin !== 'https://anime1.me') continue;
            const path = decodeURIComponent(link.pathname).replace(/\/$/, '');
            if (path === base + '/page/' + (page + 1) || path === base && link.searchParams.get('paged') === String(page + 1)) nextPage = page + 1;
        } catch {}
    }
    return { title: series.title, episodes, nextPage };
}
export async function listSeriesEpisodes(id, title, page = 1) {
    if (!/^\d{1,10}$/.test(String(id)) || !Number.isInteger(page) || page < 1 || page > 100) throw new PlaybackError('動畫編號或頁碼無效。', 400);
    const key = 'series:' + id + ':' + page;
    const cached = episodeLists.get(key);
    if (cached && cached.expires > Date.now()) return cached.data;
    let response = await upstream('https://anime1.me/?cat=' + id);
    let target = '';
    if ([301,302,307,308].includes(response.status)) {
        const next = new URL(response.headers.get('location') || '', 'https://anime1.me');
        await response.body?.cancel();
        if (next.origin !== 'https://anime1.me' || next.username || next.password || next.search || next.hash || !/^\/category\/[^/]+\/[^/]+\/?$/.test(next.pathname)) throw new PlaybackError('動畫分類網址無效。');
        target = next.href.replace(/\/$/, '');
        response = await upstream(target + (page > 1 ? '/page/' + page + '/' : ''));
    } else {
        checkStatus(response, '讀取動畫集數');
        const html = await boundedText(response);
        const series = categoryLink(html);
        target = series.url;
        if (page === 1) {
            const data = parseEpisodeArchive(html, {url:target,title}, page);
            while (episodeLists.size >= 32) episodeLists.delete(episodeLists.keys().next().value);
            episodeLists.set(key,{data,expires:Date.now()+5*60*1000});
            return data;
        }
        response = await upstream(target + '/page/' + page + '/');
    }
    for (let count = 0; [301,302,307,308].includes(response.status) && count < 2; count++) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        const next = new URL(location || '', target);
        const expected = new URL(target + (page > 1 ? '/page/' + page : '')).pathname;
        if (!location || next.origin !== 'https://anime1.me' || next.username || next.password || next.search || next.hash || decodeURIComponent(next.pathname).replace(/\/$/, '') !== decodeURIComponent(expected)) throw new PlaybackError('原站集數列表網址已變更。');
        response = await upstream(next.href);
    }
    checkStatus(response, '讀取動畫集數');
    const data = parseEpisodeArchive(await boundedText(response), {url:target,title}, page);
    while (episodeLists.size >= 32) episodeLists.delete(episodeLists.keys().next().value);
    episodeLists.set(key,{data,expires:Date.now()+5*60*1000});
    return data;
}
export async function streamMedia(request) {
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!/^\d{1,10}$/.test(id)) throw new PlaybackError("影片編號無效。", 400);
    const range = request.headers.get("Range");
    if (range && (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.length > 80))
        throw new PlaybackError("不支援此影片範圍請求。", 416);
    const ticket = await getSession("https://anime1.me/" + id);
    const headers = new Headers({ Cookie: ticket.cookie, Referer: ticket.pageUrl });
    if (range)
        headers.set("Range", range);
    const response = await upstream(ticket.url, { method: request.method === "HEAD" ? "HEAD" : "GET", headers });
    const output = new Headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" });
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
    return Response.json({ error: error instanceof PlaybackError ? error.message : "播放服務暫時無法處理，請稍後重試。" }, { status: error instanceof PlaybackError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
}
