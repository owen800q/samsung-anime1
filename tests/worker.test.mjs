import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { episodeUrl, mediaUrl } from '../src/adapter.js';
import { seriesPage } from './helpers/janime.mjs';

const origin = 'https://samsung-anime1.pages.dev';
const env = { ASSETS: { fetch: async () => new Response('player assets') } };
const call = (path, options) => worker.fetch(new Request(origin + path, options), env);
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

test('anonymous health and static routes require no account or cookies', async () => {
  const response = await call('/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authentication, 'none');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await (await call('/')).text(), 'player assets');
});

test('accept only canonical episode and media URLs', () => {
  assert.equal(episodeUrl('https://anime1.me/?p=30070'), 'https://anime1.me/30070');
  assert.equal(episodeUrl('https://anime1.me/30070/'), 'https://anime1.me/30070');
  // A janime episode page maps to the handle every client already uses: series × 1000 + episode.
  assert.equal(episodeUrl('https://janime.cc/zh-tw/watch/505550?ep=3'), 'https://anime1.me/505550003');
  assert.equal(episodeUrl('https://janime.cc/watch/505550/?ep=12'), 'https://anime1.me/505550012');
  for (const url of ['http://anime1.me/1', 'https://evil.test/1', 'https://anime1.me@evil.test/1', 'https://anime1.me/category/test', 'https://anime1.me:444/1', 'https://janime.cc/zh-tw/watch/505550', 'https://janime.cc/zh-tw/watch/505550?ep=SP', 'https://janime.cc.evil.test/watch/1?ep=1']) assert.throws(() => episodeUrl(url));
  assert.equal(mediaUrl('https://stream.janime.cc/stream/v/Xlv0w7kUDzq6-AUGENo_DQ'), 'https://stream.janime.cc/stream/v/Xlv0w7kUDzq6-AUGENo_DQ');
  for (const url of ['https://evil.test/a/b.mp4','https://stream.janime.cc.evil.test/stream/v/a','https://stream.janime.cc/stream/v/a?x=1','http://stream.janime.cc/stream/v/a','https://janime.cc/stream/v/a','https://stream.janime.cc:8443/stream/v/a','https://stream.janime.cc/stream/v/a%20b']) assert.throws(() => mediaUrl(url));
});

test('reject invalid requests before making upstream calls', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  assert.equal((await call('/api/resolve', post({url:'https://evil.test/1'}))).status, 400);
  assert.equal((await call('/api/resolve', post({url:'x'.repeat(2100)}))).status, 413);
  assert.equal((await call('/api/media?id=30070', {headers:{Range:'bytes=0-1,3-4'}})).status, 416);
  assert.equal((await call('/api/media?id=1&url=https://evil.test', {headers:{Origin:'https://evil.test'}})).status, 403);
  assert.equal((await call('/api/media?id=oops')).status, 400);
});

// Series 30 on janime: episode 70 is handle 30070. The stream host needs no cookie or session.
function mockUpstream(t, id, { denied = false } = {}) {
  const requests = [];
  const series = Math.floor(Number(id) / 1000), episode = Number(id) % 1000;
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input); const headers = new Headers(init.headers);
    requests.push({url, headers, method:init.method || 'GET'});
    assert.equal(init.redirect, 'manual');
    if (url === 'https://janime.cc/zh-tw/watch/' + series) return new Response(seriesPage({id:series, title:'動畫 & 第十集', episodes:[{slug:episode - 1, mp4:{cht:'prev'}}, {slug:episode, mp4:{chs:'simplified', cht:'tc' + episode}}]}));
    assert.equal(url, 'https://stream.janime.cc/stream/v/tc' + episode);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('referer'), 'https://janime.cc/');
    if (denied) return new Response('Forbidden', {status:403});
    if (headers.get('range') === 'bytes=99999-') return new Response(null,{status:416,headers:{'Content-Range':'bytes */10000'}});
    const range = headers.get('range');
    return new Response(init.method === 'HEAD' ? null : new Uint8Array([0,0,0,24]), {status:range ? 206 : 200,headers:{'Content-Type':'video/mp4','Content-Length':'4','Accept-Ranges':'bytes',...(range ? {'Content-Range':range === 'bytes=500-503' ? 'bytes 500-503/10000' : 'bytes 0-3/10000'} : {})}});
  });
  return requests;
}

test('playback resolves a janime episode and streams anonymous same-origin media with range/HEAD support', async t => {
  const requests = mockUpstream(t, '30070');
  const prepared = await call('/api/resolve', post({url:'https://anime1.me/30070'}));
  assert.equal(prepared.status, 200);
  const payload = await prepared.json();
  assert.equal(payload.media, '/api/media?id=30070');
  assert.equal(payload.title, '動畫 & 第十集 [70]');
  assert.equal(payload.sourceUrl, 'https://janime.cc/zh-tw/watch/30?ep=70');
  assert.equal(payload.previous.url, 'https://anime1.me/30069');
  assert.equal(payload.next, null);
  assert.equal(JSON.stringify(payload).includes('stream.janime.cc'), false, 'the stream address stays on the server');
  assert.equal(prepared.headers.get('set-cookie'), null);
  const media = await call(payload.media, {headers:{Range:'bytes=500-503'}});
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('content-type'), 'video/mp4');
  assert.equal(media.headers.get('content-range'), 'bytes 500-503/10000');
  assert.equal((await media.arrayBuffer()).byteLength, 4);
  assert.equal(media.headers.get('set-cookie'), null);
  const head = await call(payload.media, {method:'HEAD'});
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const outside = await call(payload.media, {headers:{Range:'bytes=99999-'}});
  assert.equal(outside.status, 416); assert.equal(outside.headers.get('content-range'), 'bytes */10000');
  assert.equal(requests.filter(r => r.url === 'https://janime.cc/zh-tw/watch/30').length, 1);
});

test('a cold media request resolves its own source session', async t => {
  mockUpstream(t, '31071');
  const response = await call('/api/media?id=31071', {headers:{Range:'bytes=0-3'}});
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 4);
});

test('upstream denial is surfaced without retrying to bypass it', async t => {
  const requests = mockUpstream(t, '32072', {denied:true});
  const prepared = await call('/api/resolve', post({url:'https://anime1.me/32072'}));
  assert.equal(prepared.status,200);
  assert.equal(requests.filter(r => r.url.includes('/stream/v/')).length,0,'resolve must not wait for a redundant media probe');
  const response = await call((await prepared.json()).media);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /403/);
  assert.equal(requests.filter(r => r.url.includes('/stream/v/')).length, 1);
});

// janime sits behind Cloudflare, which answers 52x while the site's own server is unreachable.
function mockOutage(t, id, failures, status = 521) {
  const calls = {page:0};
  const series = Math.floor(Number(id) / 1000);
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input);
    if (url === 'https://janime.cc/zh-tw/watch/' + series) {
      if (++calls.page <= failures) return new Response('error code: ' + status, {status});
      return new Response(seriesPage({id:series, title:'動畫', episodes:[{slug:Number(id) % 1000, mp4:{cht:'x'}}]}));
    }
    throw new Error('Unexpected URL ' + url);
  });
  return calls;
}

test('a momentary source outage is retried and never reaches the viewer', async t => {
  const calls = mockOutage(t, '35080', 2);
  const response = await call('/api/resolve', post({url:'https://anime1.me/35080'}));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).media, '/api/media?id=35080');
  assert.deepEqual(calls, {page:3});
});

test('a lasting source outage is reported as the source being down, after a bounded retry', async t => {
  const calls = mockOutage(t, '36081', Infinity);
  const response = await call('/api/resolve', post({url:'https://anime1.me/36081'}));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.sourceDown, true);
  assert.match(body.error, /讀取動畫頁面失敗.*原站 521.*並非電視或網絡的問題/);
  assert.deepEqual(calls, {page:3});
});

test('a refusal is not mistaken for an outage', async t => {
  const calls = mockOutage(t, '37082', Infinity, 403);
  const response = await call('/api/resolve', post({url:'https://anime1.me/37082'}));
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.sourceDown, undefined);
  assert.match(body.error, /403/);
  assert.equal(calls.page, 1);
});

test('an episode with only the mainland route says so instead of failing vaguely', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'https://janime.cc/zh-tw/watch/40');
    return new Response(seriesPage({id:40, title:'大陸限定', episodes:[{slug:1, m3u8:true}, {slug:2, mp4:{chs:'ok'}}]}));
  });
  const blocked = await call('/api/resolve', post({url:'https://anime1.me/40001'}));
  assert.equal(blocked.status, 422);
  assert.match((await blocked.json()).error, /只有中國大陸線路/);
  assert.equal((await call('/api/resolve', post({url:'https://anime1.me/40002'}))).status, 200);
  assert.equal((await call('/api/resolve', post({url:'https://anime1.me/40009'}))).status, 404);
});

test('a page that does not carry the requested series, or has no player data, is rejected', async t => {
  t.mock.method(globalThis, 'fetch', async url => new Response(String(url).endsWith('/41') ? seriesPage({id:999, title:'別的動畫', episodes:[{slug:1, mp4:{cht:'x'}}]}) : '<html><title>改版</title></html>'));
  assert.equal((await call('/api/resolve', post({url:'https://anime1.me/41001'}))).status, 502);
  const changed = await call('/api/resolve', post({url:'https://anime1.me/42001'}));
  assert.equal(changed.status, 502);
  assert.match((await changed.json()).error, /無法解析/);
});

test('the packaged Samsung TV app (file:// origin, TV user agent) may call the API with CORS', async t => {
  const tv = {'User-Agent':'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 TV Safari/537.36', Origin:'null', 'Sec-Fetch-Site':'cross-site'};
  const health = await call('/api/health', {headers:tv});
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), 'null');
  const preflight = await call('/api/history', {method:'OPTIONS', headers:{...tv, 'Access-Control-Request-Headers':'authorization'}});
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  // The same opaque origin from a desktop browser, or a TV page on another website, stays blocked.
  assert.equal((await call('/api/health', {headers:{Origin:'null'}})).status, 403);
  assert.equal((await call('/api/health', {headers:{...tv, Origin:'https://evil.test'}})).status, 403);
  assert.equal((await call('/api/health')).headers.get('access-control-allow-origin'), null);
  // Real TVs send cross-site fetches with no Origin (and their own user agent).
  const bare = await call('/api/health', {headers:{'Sec-Fetch-Site':'cross-site', 'Sec-Fetch-Mode':'cors'}});
  assert.equal(bare.status, 200);
  assert.equal(bare.headers.get('access-control-allow-origin'), '*');
  // Cross-site navigations and embeds from other websites stay blocked.
  for (const mode of ['navigate', 'no-cors']) assert.equal((await call('/api/health', {headers:{'Sec-Fetch-Site':'cross-site', 'Sec-Fetch-Mode':mode}})).status, 403);
  mockUpstream(t, '33070');
  const payload = await (await call('/api/resolve', {...post({url:'https://anime1.me/33070'}), headers:{...tv, 'Content-Type':'application/json'}})).json();
  const media = await call(payload.media, {headers:{'User-Agent':tv['User-Agent'], Range:'bytes=500-503'}});
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal((await call(payload.media, {headers:{Range:'bytes=500-503'}})).headers.get('cross-origin-resource-policy'), 'same-origin');
});
