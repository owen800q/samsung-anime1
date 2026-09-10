// Public-page adapter and credential-preserving stream. No upstream scripts execute.
// Credentials stay in bounded, temporary server memory. No account or secret is needed.
class PlaybackError extends Error {
    constructor(message, status = 502) { super(message); this.status = status; }
}
const decoder = new TextDecoder();
const UA = "Mozilla/5.0 Anime1TV/1.0";
function episodeUrl(input) {
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
function mediaUrl(input) {
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
function plainText(html) {
    const names = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    return html.replace(/<[^>]*>/g, "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
        if (entity[0] !== "#")
            return names[entity.toLowerCase()] ?? all;
        const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }).replace(/\s+/g, " ").trim().slice(0, 350);
}
async function upstream(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);
    try {
        return await fetch(url, { ...init, redirect: "manual", signal: controller.signal, headers: { "User-Agent": UA, ...Object.fromEntries(new Headers(init.headers)) } });
    }
    catch {
        throw new PlaybackError("原站連線逾時或暫時無法連接，請稍後重試。", 504);
    }
    finally {
        clearTimeout(timer);
    }
}
async function boundedText(r, max = 2000000) {
    if (!r.body)
        return "";
    const reader = r.body.getReader();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, 35000);
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            length += value.length;
            if (length > max) {
                await reader.cancel();
                throw new PlaybackError("原站回應過大，無法處理。");
            }
            chunks.push(value);
        }
    }
    finally {
        clearTimeout(timer);
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
    const promise = loadSession(url).then(session => {
        sessions.delete(url);
        while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        sessions.set(url, { ...session, cachedAt: Date.now() });
        return session;
    }).finally(() => pending.delete(url));
    pending.set(url, promise);
    return promise;
}
async function resolveEpisode(input, refresh = false) {
    const session = await getSession(input, refresh);
    return { url: session.pageUrl, title: session.title, media: "/api/media?id=" + new URL(session.pageUrl).pathname.slice(1), previous: session.previous, next: session.next };
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
async function loadSession(input) {
    const url = episodeUrl(input);
    const page = await upstream(url);
    checkStatus(page, "讀取動畫頁面");
    const html = await boundedText(page);
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
    const api = await upstream("https://v.anime1.me/api", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://anime1.me", Referer: url }, body: new URLSearchParams({ d: data }).toString() });
    checkStatus(api, "取得播放資料");
    let payload;
    try {
        payload = JSON.parse(await boundedText(api, 32768));
    }
    catch {
        throw new PlaybackError("原站播放服務回傳了無法讀取的資料。");
    }
    const source = payload.s?.find(x => x.type === "video/mp4" || x.src?.endsWith(".mp4"));
    if (!source)
        throw new PlaybackError("原站暫未提供影片，請稍後重新載入。");
    const target = mediaUrl(source.src);
    const credentials = playbackCookies(api.headers, target);
    const probe = await upstream(target, { headers: { Cookie: credentials.cookie, Range: "bytes=0-1023", Referer: url } });
    checkStatus(probe, "確認影片連線");
    const contentType = probe.headers.get("Content-Type") || "";
    await probe.body?.cancel();
    if (!contentType.toLowerCase().startsWith("video/mp4"))
        throw new PlaybackError("原站未回傳影片內容，暫時無法播放。");
    const titleMatch = html.match(/<h[1-3]\b[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    return { url: target, pageUrl: url, ...credentials, title: titleMatch ? plainText(titleMatch[1]) : "Anime1 動畫", previous: related(html, "上一集"), next: related(html, "下一集") };
}
async function searchEpisodes(query) {
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
async function streamMedia(request) {
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
function errorResponse(error) {
    return Response.json({ error: error instanceof PlaybackError ? error.message : "播放服務暫時無法處理，請稍後重試。" }, { status: error instanceof PlaybackError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
}


async function requestJson(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new PlaybackError('請使用播放器載入影片。', 415);
  if (Number(request.headers.get('content-length')) > 2048) throw new PlaybackError('請求內容過長。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new PlaybackError('請提供影片網址。', 400);
  let size = 0; let text = ''; const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel(); throw new PlaybackError('請求內容過長。', 413); }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text + decoder.decode()); } catch { throw new PlaybackError('影片資料無效。', 400); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      const origin = request.headers.get('origin');
      if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new PlaybackError('請從播放器網頁開啟影片。', 403);
      if (url.pathname === '/api/health' && request.method === 'GET') return Response.json({ service: 'samsung-anime1', authentication: 'none', version: 'pages-1' }, { headers: { 'Cache-Control': 'no-store' } });
      if (url.pathname === '/api/resolve' && request.method === 'POST') {
        const body = await requestJson(request);
        return Response.json(await resolveEpisode(body?.url, body?.refresh === true), { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (url.pathname === '/api/search' && request.method === 'GET') return Response.json(await searchEpisodes(url.searchParams.get('q') || ''), { headers: { 'Cache-Control': 'no-store' } });
      if (url.pathname === '/api/media' && ['GET', 'HEAD'].includes(request.method)) return await streamMedia(request);
      return Response.json({ error: '找不到此功能或不支援此請求方式。' }, { status: 404 });
    } catch (error) { return errorResponse(error); }
  },
};
