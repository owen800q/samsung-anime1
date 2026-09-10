import { resolveEpisode, streamMedia, searchEpisodes, errorResponse, PlaybackError } from './adapter.js';

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
