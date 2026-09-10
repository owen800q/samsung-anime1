import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const origin = 'https://test.invalid';
const list = (url, page = 1) => worker.fetch(new Request(origin + '/api/episodes?url=' + encodeURIComponent(url) + '&page=' + page), {});
const entry = (id, number) => '<h2 class="entry-title"><a href="https://anime1.me/' + id + '">動畫 [' + number + ']</a></h2>';

test('episode selector sorts numerically, deduplicates and exposes older pages without calling playback API', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    if (url === 'https://anime1.me/123') return new Response('<a href="https://anime1.me/category/2026/test" rel="category tag">動畫 &amp; 系列</a>');
    if (url === 'https://anime1.me/category/2026/test') return new Response(entry(123,10) + entry(122,9) + entry(122,9) + '<a class="next page-numbers" href="https://anime1.me/category/2026/test/page/2/">下一頁</a>');
    if (url === 'https://anime1.me/category/2026/test/page/2') return new Response(entry(121,8));
    throw new Error('Unexpected URL ' + url);
  });
  const response = await list('https://anime1.me/123');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.title, '動畫 & 系列');
  assert.deepEqual(body.episodes.map(x => x.label), ['第 9 集','第 10 集']);
  assert.equal(body.nextPage, 2);
  const older = await (await list('https://anime1.me/123', 2)).json();
  assert.equal(older.episodes[0].url, 'https://anime1.me/121');
  assert.equal(older.nextPage, null);
  const before = calls.length;
  await list('https://anime1.me/123');
  assert.equal(calls.length, before);
  assert.equal(calls.some(x => x.includes('v.anime1.me')), false);
});

test('invalid URL and page are rejected without an upstream request', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  assert.equal((await list('https://evil.test/123')).status, 400);
  for (const page of [0, -1, 1.5, 101, 'bad']) assert.equal((await list('https://anime1.me/123', page)).status, 400);
});

test('a category redirect cannot escape the expected archive', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    if (url === 'https://anime1.me/456') return new Response('<a rel="category tag" href="https://anime1.me/category/2026/blocked">動畫</a>');
    return new Response(null, {status:302,headers:{Location:'https://evil.test/steal'}});
  });
  const response = await list('https://anime1.me/456');
  assert.equal(response.status, 502);
  assert.equal(calls.length, 2);
});

test('archive canonical trailing-slash redirect is supported', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === 'https://anime1.me/789') return new Response('<a rel="category tag" href="https://anime1.me/category/2026/slash">動畫</a>');
    if (url === 'https://anime1.me/category/2026/slash') return new Response(null,{status:301,headers:{Location:'/category/2026/slash/'}});
    assert.equal(url, 'https://anime1.me/category/2026/slash/');
    return new Response(entry(789,1));
  });
  assert.equal((await list('https://anime1.me/789')).status, 200);
});
