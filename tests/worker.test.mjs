import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { episodeUrl, mediaUrl } from '../src/adapter.js';

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
  for (const url of ['http://anime1.me/1', 'https://evil.test/1', 'https://anime1.me@evil.test/1', 'https://anime1.me/category/test', 'https://anime1.me:444/1']) assert.throws(() => episodeUrl(url));
  assert.equal(mediaUrl('//miru.v.anime1.me/1959/10b.mp4'), 'https://miru.v.anime1.me/1959/10b.mp4');
  for (const url of ['https://evil.test/a/b.mp4','https://miru.v.anime1.me.evil.test/a/b.mp4','https://miru.v.anime1.me/a/b.mp4?x=1']) assert.throws(() => mediaUrl(url));
});

test('reject invalid requests before making upstream calls', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  assert.equal((await call('/api/resolve', post({url:'https://evil.test/1'}))).status, 400);
  assert.equal((await call('/api/resolve', post({url:'x'.repeat(2100)}))).status, 413);
  assert.equal((await call('/api/media?id=30070', {headers:{Range:'bytes=0-1,3-4'}})).status, 416);
  assert.equal((await call('/api/media?id=1&url=https://evil.test', {headers:{Origin:'https://evil.test'}})).status, 403);
  assert.equal((await call('/api/media?id=oops')).status, 400);
});

function mockUpstream(t, id, { denied = false } = {}) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input); const headers = new Headers(init.headers);
    requests.push({url, headers, method:init.method || 'GET'});
    assert.equal(init.redirect, 'manual');
    if (url === 'https://anime1.me/' + id) return new Response('<h2 class="entry-title">動畫 &amp; 第十集</h2><video data-apireq="%7B%22id%22%3A1%7D"></video><a href="https://anime1.me/30069">上一集</a>');
    if (url === 'https://v.anime1.me/api') {
      assert.equal(init.method, 'POST');
      assert.equal(new URLSearchParams(init.body).get('d'), '{"id":1}');
      const responseHeaders = new Headers({'Content-Type':'application/json'});
      for(const key of ['e','p','h']) responseHeaders.append('Set-Cookie', key + '=test-' + key + '; Domain=.v.anime1.me; Path=/1959/10b.mp4; Max-Age=3600; Secure; HttpOnly');
      return new Response(JSON.stringify({s:[{type:'video/mp4',src:'//miru.v.anime1.me/1959/10b.mp4'}]}), {headers:responseHeaders});
    }
    assert.equal(url, 'https://miru.v.anime1.me/1959/10b.mp4');
    assert.equal(headers.get('cookie'), 'e=test-e; p=test-p; h=test-h');
    assert.equal(headers.get('referer'), 'https://anime1.me/' + id);
    if (denied) return new Response('Forbidden', {status:403});
    if (headers.get('range') === 'bytes=99999-') return new Response(null,{status:416,headers:{'Content-Range':'bytes */10000'}});
    const range = headers.get('range');
    return new Response(init.method === 'HEAD' ? null : new Uint8Array([0,0,0,24]), {status:range ? 206 : 200,headers:{'Content-Type':'video/mp4','Content-Length':'4','Accept-Ranges':'bytes',...(range ? {'Content-Range':range === 'bytes=500-503' ? 'bytes 500-503/10000' : 'bytes 0-3/10000'} : {})}});
  });
  return requests;
}

test('server holds cookies; browser receives anonymous same-origin media with range/HEAD support', async t => {
  const requests = mockUpstream(t, '30070');
  const prepared = await call('/api/resolve', post({url:'https://anime1.me/30070'}));
  assert.equal(prepared.status, 200);
  const payload = await prepared.json();
  assert.equal(payload.media, '/api/media?id=30070');
  assert.equal(payload.title, '動畫 & 第十集');
  assert.equal(payload.previous.url, 'https://anime1.me/30069');
  assert.equal(payload.next, null);
  assert.equal(JSON.stringify(payload).includes('test-e'), false);
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
  assert.equal(requests.filter(r => r.url === 'https://v.anime1.me/api').length, 1);
});

test('a cold media request resolves its own source session', async t => {
  mockUpstream(t, '30071');
  const response = await call('/api/media?id=30071', {headers:{Range:'bytes=0-3'}});
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 4);
});

test('upstream denial is surfaced without retrying to bypass it', async t => {
  const requests = mockUpstream(t, '30072', {denied:true});
  const prepared = await call('/api/resolve', post({url:'https://anime1.me/30072'}));
  assert.equal(prepared.status,200);
  assert.equal(requests.filter(r => r.url.includes('/1959/')).length,0,'resolve must not wait for a redundant media probe');
  const response = await call((await prepared.json()).media);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /403/);
  assert.equal(requests.filter(r => r.url.includes('/1959/')).length, 1);
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
  mockUpstream(t, '30070');
  const payload = await (await call('/api/resolve', {...post({url:'https://anime1.me/30070'}), headers:{...tv, 'Content-Type':'application/json'}})).json();
  const media = await call(payload.media, {headers:{'User-Agent':tv['User-Agent'], Range:'bytes=500-503'}});
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal((await call(payload.media, {headers:{Range:'bytes=500-503'}})).headers.get('cross-origin-resource-policy'), 'same-origin');
});
