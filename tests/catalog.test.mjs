import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOG_SEED} from '../src/catalog-data.js';
let version=0;
const fresh=()=>import('../src/catalog.js?test='+ ++version);
const seeds=CATALOG_SEED.entries.slice(0,12);
const rows=()=>seeds.map(x=>[x.id,x.title,x.episodes,x.year,x.season,'']);

test('catalogue uses source entries, paginates and filters titles/year/state without needing Bangumi',async t=>{
  const api=await fresh();const requested=[];
  t.mock.method(globalThis,'fetch',async url=>{requested.push(url);assert.equal(url,'https://anime1.me/animelist.json');return Response.json(rows());});
  const all=await api.browseCatalogue(new URLSearchParams());
  assert.equal(all.items.length,12);assert.equal(all.total,12);assert.equal(all.stale,false);
  const search=await api.browseCatalogue(new URLSearchParams({q:seeds[0].title,year:seeds[0].year,state:'airing'}));
  assert.deepEqual(search.items.map(x=>x.id),[seeds[0].id]);
  assert.equal(requested.length,1);
});

test('changed source title does not inherit an old Bangumi mapping',async t=>{
  const api=await fresh();const data=rows();data[0][1]='完全不同的動畫 第二季';
  t.mock.method(globalThis,'fetch',async()=>Response.json(data));
  const result=await api.browseCatalogue(new URLSearchParams());
  assert.equal(result.items[0].bgmId,null);assert.equal(result.items[0].format,'unknown');
});

test('genre browsing intersects Bangumi IDs with source catalogue; unrelated titles are excluded',async t=>{
  const api=await fresh();const source=seeds.find(x=>x.bgmId);
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(url==='https://anime1.me/animelist.json')return Response.json(rows());
    assert.match(url,/api\.bgm\.tv\/v0\/search\/subjects/);
    assert.deepEqual(JSON.parse(init.body).filter.tag,['恋爱']);
    return Response.json({total:2,data:[{id:source.bgmId,type:2,name:'作品',tags:[{name:'恋爱'}]},{id:99999999,type:2,name:'沒有片源'}]});
  });
  const result=await api.browseCatalogue(new URLSearchParams({genre:'戀愛'}));
  assert.deepEqual(result.items.map(x=>x.id),[source.id]);assert.equal(result.nextPage,null);
});

test('metadata is optional and image proxy rejects an untrusted image host',async t=>{
  const api=await fresh();const source=seeds.find(x=>x.bgmId);const urls=[];
  t.mock.method(globalThis,'fetch',async url=>{
    urls.push(url);if(url==='https://anime1.me/animelist.json')return Response.json(rows());
    return Response.json({id:source.bgmId,type:2,summary:'簡介',images:{common:'https://evil.test/x.jpg'},rating:{total:10,score:7}});
  });
  const data=await api.catalogueMetadata(String(source.id));
  assert.equal(data.details[source.id].summary,'簡介');assert.equal(data.details[source.id].cover,null);
  assert.equal((await api.catalogueCover(String(source.id))).status,404);
  assert.equal(urls.some(x=>x.includes('evil.test')),false);
});

test('source outage provides an explicitly stale snapshot and metadata limits are enforced',async t=>{
  const api=await fresh();t.mock.method(globalThis,'fetch',async()=>{throw new Error('offline');});
  const result=await api.browseCatalogue(new URLSearchParams());
  assert.equal(result.stale,true);assert.equal(result.total,CATALOG_SEED.entries.length);
  await assert.rejects(api.catalogueMetadata('1,2,3,4,5,6,7,8,9'),e=>e.status===400);
  await assert.rejects(api.catalogueCover('https://evil.test'),e=>e.status===400);
});
