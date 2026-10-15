import { searchDanmaku, resolveDanmaku, getDanmaku, dandanConfigured, matchDandanplay, fallbackDanmaku } from './danmaku-server.js';
import { resolveEpisode, streamMedia, searchEpisodes, listEpisodes, errorResponse, PlaybackError, allowedCaller, tvAppRequest } from './adapter.js';
import { browseCatalogue, catalogueMetadata, catalogueSeries, catalogueCover, catalogueItem, catalogueComments } from './catalog.js';
import { historyRoute } from './sync-server.js';
import { pairingRoute } from './pairing-server.js';
import { remoteRoute } from './remote-server.js';

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

// The TV app's origin is opaque ("null"); answer it with CORS so the Tizen runtime accepts the responses.
const TV_CORS = { 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT', 'Access-Control-Max-Age': '600', 'Vary': 'Origin' };
function withTvCors(request, response) {
  if (response.status === 101 || response.webSocket) return response;
  const out = new Response(response.body, response);
  out.headers.set('Access-Control-Allow-Origin', request.headers.get('origin') || '*');
  for (const [key, value] of Object.entries(TV_CORS)) out.headers.set(key, value);
  return out;
}

// API routes (pairing, remote, history, catalogue, playback) run before static assets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!tvAppRequest(request)) return route(request, env, url);
    if (request.method === 'OPTIONS') return withTvCors(request, new Response(null, { status: 204 }));
    return withTvCors(request, await route(request, env, url));
  },
};

async function route(request, env, url) {
    try {
      if (!allowedCaller(request)) throw new PlaybackError('請從播放器網頁開啟影片。', 403);
      if (url.pathname.startsWith('/api/pairing/')) return await pairingRoute(request,env);
      if (url.pathname.startsWith('/api/remote/')) return await remoteRoute(request,env);
      if (url.pathname === '/api/history' || url.pathname === '/api/danmaku/settings') return await historyRoute(request,env);
      if (request.method === 'GET' && url.pathname === '/api/danmaku/providers') return Response.json({dandanplay:dandanConfigured(env)},{headers:{'Cache-Control':'no-store'}});
      if (request.method === 'GET' && url.pathname === '/api/danmaku/fallback') {
        const {item}=await catalogueItem(url.searchParams.get('id'),env);
        return Response.json(await fallbackDanmaku(item,url.searchParams.get('provider'),url.searchParams.get('episode'),env),{headers:{'Cache-Control':'no-store'}});
      }
      if (request.method === 'GET' && url.pathname === '/api/danmaku/match') return Response.json(await matchDandanplay(url.searchParams.get('bgmId'),url.searchParams.get('episode'),env),{headers:{'Cache-Control':'no-store'}});
      if (request.method === 'GET' && url.pathname === '/api/danmaku/search') return Response.json(await searchDanmaku(url.searchParams.get('q'),url.searchParams.get('provider')||'bahamut',env),{headers:{'Cache-Control':'no-store'}});
      if (request.method === 'GET' && url.pathname === '/api/danmaku/resolve') return Response.json(await resolveDanmaku(url.searchParams.get('url'),env),{headers:{'Cache-Control':'no-store'}});
      if (request.method === 'GET' && url.pathname === '/api/danmaku/comments') return Response.json(await getDanmaku(url.searchParams.get('provider'),url.searchParams.get('id'),Number(url.searchParams.get('segment')||1),env),{headers:{'Cache-Control':'no-store'}});
      if (url.pathname === '/api/health' && request.method === 'GET') return Response.json({ service: 'samsung-anime1', authentication: 'none', version: 'catalog-1' }, { headers: { 'Cache-Control': 'no-store' } });
      if (request.method === 'GET' && url.pathname === '/api/catalog') return Response.json(await browseCatalogue(url.searchParams),{headers:{'Cache-Control':'no-store'}});
      if (request.method === 'GET' && url.pathname === '/api/catalog-item') return Response.json(await catalogueItem(url.searchParams.get('id'),...url.searchParams.get('match')==='1'?[env,true]:[{},false]),{headers:{'Cache-Control':'no-store'}});
      if (request.method === 'GET' && url.pathname === '/api/comments') return Response.json(await catalogueComments(url.searchParams.get('id'),Number(url.searchParams.get('page')||1),env),{headers:{'Cache-Control':'no-store'}});
      if (request.method === 'GET' && url.pathname === '/api/metadata') return Response.json(await catalogueMetadata(url.searchParams.get('ids')),{headers:{'Cache-Control':'no-store'}});
      if (request.method === 'GET' && url.pathname === '/api/series') return Response.json(await catalogueSeries(url.searchParams.get('id'),Number(url.searchParams.get('page')||1)),{headers:{'Cache-Control':'no-store'}});
      if (request.method === 'GET' && url.pathname === '/api/cover') return await catalogueCover(url.searchParams.get('id'));
      if (url.pathname === '/api/resolve' && request.method === 'POST') {
        const body = await requestJson(request);
        return Response.json(await resolveEpisode(body?.url, body?.refresh === true), { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (url.pathname === '/api/search' && request.method === 'GET') return Response.json(await searchEpisodes(url.searchParams.get('q') || ''), { headers: { 'Cache-Control': 'no-store' } });
      if (url.pathname === '/api/episodes' && request.method === 'GET') return Response.json(await listEpisodes(url.searchParams.get('url'), Number(url.searchParams.get('page') || 1)), { headers: { 'Cache-Control': 'no-store' } });
      if (url.pathname === '/api/media' && ['GET', 'HEAD'].includes(request.method)) return await streamMedia(request);
      return Response.json({ error: '找不到此功能或不支援此請求方式。' }, { status: 404 });
    } catch (error) { return errorResponse(error); }
}

