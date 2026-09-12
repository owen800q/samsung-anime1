import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOG_SEED} from '../src/catalog-data.js';
let version=0;
const fresh=()=>import('../src/catalog.js?comments='+ ++version);
const seeds=CATALOG_SEED.entries.slice(0,12);
const source=seeds.find(x=>x.bgmId);
const rows=()=>seeds.map(x=>[x.id,x.title,x.episodes,x.year,x.season]);

test('comments use the mapped subject, normalize optional fields, cache requests and paginate by upstream offsets',async t=>{
 const api=await fresh(),urls=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  urls.push(url);if(url==='https://anime1.me/animelist.json')return Response.json(rows());
  assert.equal(init.redirect,'manual');assert.ok(init.signal);assert.match(init.headers['User-Agent'],/SamsungAnime1/);
  assert.equal(url,'https://next.bgm.tv/p1/subjects/'+source.bgmId+'/comments?limit=20&offset='+ (urls.length===2?'0':'20'));
  return Response.json({total:21,data:[{id:123,comment:'<script>alert(1)</script>\n短評',rate:8,updatedAt:1700000000,user:{nickname:'作者'}},{id:124,comment:'無評分',rate:0,updatedAt:-1,user:null},{comment:'   '}]});
 });
 const first=await api.catalogueComments(String(source.id));
 assert.equal(first.comments.length,2);assert.equal(first.comments[0].text,'<script>alert(1)</script>\n短評');
 assert.equal(first.comments[0].rating,8);assert.equal(first.comments[1].rating,null);assert.equal(first.comments[1].updatedAt,null);
 assert.equal(first.comments[1].author,'Bangumi 用戶');assert.equal(first.nextPage,2);assert.equal(first.matched,true);
 assert.deepEqual(await api.catalogueComments(String(source.id)),first);assert.equal(urls.length,2);
 assert.equal((await api.catalogueComments(String(source.id),2)).nextPage,null);
});

test('invalid comment identifiers/pages never fetch; unknown IDs are 404',async t=>{
 const api=await fresh();let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json(rows());});
 for(const id of ['https://evil.test','../1','0x12',''])await assert.rejects(api.catalogueComments(id),e=>e.status===400);
 for(const page of [0,-1,1.5,501,NaN,Infinity])await assert.rejects(api.catalogueComments(String(source.id),page),e=>e.status===400);
 assert.equal(calls,0);
 await assert.rejects(api.catalogueComments('9999999999'),e=>e.status===404);
});

test('unmatched or renamed titles do not fetch another anime’s comments',async t=>{
 const api=await fresh(),data=rows();data.find(x=>x[0]===source.id)[1]='另一套動畫';
 t.mock.method(globalThis,'fetch',async url=>{assert.equal(url,'https://anime1.me/animelist.json');return Response.json(data);});
 assert.deepEqual(await api.catalogueComments(String(source.id)),{comments:[],total:0,page:1,nextPage:null,bangumiUrl:null,matched:false});
});

test('empty comments differ from upstream errors; failed requests can be retried',async t=>{
 const api=await fresh();let calls=0;
 t.mock.method(globalThis,'fetch',async url=>{
  if(url==='https://anime1.me/animelist.json')return Response.json(rows());
  calls++;
  if(calls===1)return new Response('denied',{status:403});
  return Response.json({data:[],total:0});
 });
 await assert.rejects(api.catalogueComments(String(source.id)),e=>e.status===502&&/Bangumi/.test(e.message));
 assert.equal((await api.catalogueComments(String(source.id))).total,0);assert.equal(calls,2);
});

test('malformed upstream payload is an error, not an empty comment list',async t=>{
 const api=await fresh();
 t.mock.method(globalThis,'fetch',async url=>Response.json(url==='https://anime1.me/animelist.json'?rows():{data:'invalid',total:10}));
 await assert.rejects(api.catalogueComments(String(source.id)),e=>e.status===502);
});

test('worker exposes comments as a same-origin GET endpoint',async t=>{
 const worker=(await import('../src/worker.js')).default;
 t.mock.method(globalThis,'fetch',async url=>Response.json(url==='https://anime1.me/animelist.json'?rows():{data:[],total:0}));
 const response=await worker.fetch(new Request('https://tv.test/api/comments?id='+source.id),{});
 assert.equal(response.status,200);assert.equal((await response.json()).matched,true);
 const denied=await worker.fetch(new Request('https://tv.test/api/comments?id='+source.id,{headers:{Origin:'https://other.test'}}),{});
 assert.equal(denied.status,403);
 assert.equal((await worker.fetch(new Request('https://tv.test/api/comments?id='+source.id,{method:'POST'}),{})).status,404);
});
