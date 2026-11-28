import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {listSeriesEpisodes} from '../src/adapter.js';
import {seriesPage} from './helpers/janime.mjs';

const origin = 'https://test.invalid';
const list = (url, page = 1) => worker.fetch(new Request(origin + '/api/episodes?url=' + encodeURIComponent(url) + '&page=' + page), {});

test('episode selector orders episodes, keeps the episode handle format and reads the series page once', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    assert.equal(String(url), 'https://janime.cc/zh-tw/watch/123');
    return new Response(seriesPage({id:123, title:'動畫 &amp; 系列', episodes:[{slug:10, mp4:{cht:'b'}}, {slug:9, mp4:{cht:'a'}}, {slug:9, mp4:{cht:'dup'}}, {slug:'SP', sort:99, m3u8:true}, {slug:'12.5', sort:12.5, mp4:{chs:'c'}}]}));
  });
  const response = await list('https://anime1.me/123010');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.title, '動畫 & 系列');
  assert.deepEqual(body.episodes.map(x => x.label), ['第 9 集','第 10 集','第 12.5 集','SP']);
  // Whole episode numbers keep their number; the others take 900 + their place.
  assert.deepEqual(body.episodes.map(x => x.url), ['https://anime1.me/123009','https://anime1.me/123010','https://anime1.me/123900','https://anime1.me/123901']);
  assert.deepEqual(body.episodes.map(x => x.title), ['動畫 & 系列 [09]','動畫 & 系列 [10]','動畫 & 系列 [12.5]','動畫 & 系列 [SP]']);
  assert.equal(body.nextPage, null);
  assert.equal((await list('https://anime1.me/123010', 2)).status, 404);
  const before = calls.length;
  await list('https://anime1.me/123001');
  assert.equal(calls.length, before, 'the series page is cached');
  assert.equal(calls.some(x => x.includes('stream.janime.cc')), false);
});

test('invalid URL and page are rejected without an upstream request', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  assert.equal((await list('https://evil.test/123')).status, 400);
  assert.equal((await list('https://anime1.me/123')).status, 400, 'a handle below 1000 names no series');
  for (const page of [0, -1, 1.5, 101, 'bad']) assert.equal((await list('https://anime1.me/124001', page)).status, 400);
});

test('a missing series and a source redirect are reported, never followed', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(String(url));
    assert.equal(init.redirect, 'manual');
    return String(url).endsWith('/456') ? new Response('not found', {status:404}) : new Response(null, {status:302,headers:{Location:'https://evil.test/steal'}});
  });
  const missing = await list('https://anime1.me/456001');
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /找不到這套動畫/);
  assert.equal((await list('https://anime1.me/457001')).status, 502);
  assert.deepEqual(calls, ['https://janime.cc/zh-tw/watch/456', 'https://janime.cc/zh-tw/watch/457']);
});

test('catalogue selection lists a series by its ID with the catalogue title', async t => {
  t.mock.method(globalThis,'fetch',async url=>{
    assert.equal(String(url),'https://janime.cc/zh-tw/watch/5555');
    return new Response(seriesPage({id:5555, title:'原站標題', episodes:[{slug:1, mp4:{cht:'a'}}], airing:false}));
  });
  const data=await listSeriesEpisodes(5555,'長篇動畫');
  assert.equal(data.title,'長篇動畫');assert.equal(data.episodes[0].url,'https://anime1.me/5555001');assert.equal(data.airing,false);
});
