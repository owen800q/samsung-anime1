import test from 'node:test';
import assert from 'node:assert/strict';
import {CATALOG_SEED} from '../src/catalog-data.js';
import {indexRow} from './helpers/janime.mjs';
let version=0;
const fresh=()=>import('../src/catalog.js?test='+ ++version);
const INDEX='https://janime.cc/search-index.zh-tw.min.json';
const daysAgo=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);
// janime index rows; series IDs are Bangumi subject IDs.
const seeds=Array.from({length:12},(_,i)=>({id:500000+i,bgmId:500000+i,title:'作品 '+i,year:String(2014+i),date:i===0?daysAgo(20):(2014+i)+'-04-0'+(1+i%8)}));
const rows=()=>seeds.map(x=>indexRow(x.id,x.title,{year:Number(x.year),date:x.date,season:'spring'}));

test('catalogue uses source entries, paginates and filters titles/year/state without needing Bangumi',async t=>{
  const api=await fresh();const requested=[];
  t.mock.method(globalThis,'fetch',async url=>{requested.push(url);assert.equal(url,INDEX);return Response.json(rows());});
  const all=await api.browseCatalogue(new URLSearchParams());
  assert.equal(all.items.length,12);assert.equal(all.total,12);assert.equal(all.stale,false);
  const search=await api.browseCatalogue(new URLSearchParams({q:seeds[0].title,year:seeds[0].year,state:'airing'}));
  assert.deepEqual(search.items.map(x=>x.id),[seeds[0].id]);
  assert.equal(requested.length,1);
});

test('index rows map to catalogue items: own Bangumi ID, format, season, airing state, no adult titles',async t=>{
  const api=await fresh();
  const data=[
    indexRow(601,'連載作品',{date:daysAgo(30),simplified:'连载作品'}),
    indexRow(602,'舊作品',{year:2019,date:'2019-07-05',season:'summer'}),
    indexRow(603,'劇場作品',{format:'movie',season:'winter'}),
    indexRow(604,'特別篇',{format:'ova'}),
    indexRow(605,'成人作品',{genres:['裏番']}),
    indexRow(606,'網絡作品',{format:'web',date:daysAgo(5)}),
    indexRow(601,'重複',{}),[0,'無效'],'garbage',...Array.from({length:8},(_,i)=>indexRow(700+i,'填充 '+i)),
  ];
  t.mock.method(globalThis,'fetch',async()=>Response.json(data));
  const {items}=await api.catalogueIndex();
  const byId=Object.fromEntries(items.map(x=>[x.id,x]));
  assert.equal(byId[605],undefined);assert.equal(items.filter(x=>x.id===601).length,1);
  assert.deepEqual(byId[601],{id:601,title:'連載作品',episodes:'連載中',year:'2026',season:'秋',bgmId:601,format:'tv',aliases:['連載作品','连载作品']});
  assert.equal(byId[602].episodes,'已完結');assert.equal(byId[602].season,'夏');
  assert.equal(byId[603].episodes,'劇場版');assert.equal(byId[603].format,'movie');assert.equal(byId[603].season,'冬');
  assert.equal(byId[604].episodes,'OVA');assert.equal(byId[606].episodes,'連載中');assert.equal(byId[606].format,'web');
  const simplified=await api.browseCatalogue(new URLSearchParams({q:'连载'}));
  assert.deepEqual(simplified.items.map(x=>x.id),[601]);
});

test('genre browsing intersects Bangumi IDs with source catalogue; unrelated titles are excluded',async t=>{
  const api=await fresh();const source=seeds.find(x=>x.bgmId);
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(url===INDEX)return Response.json(rows());
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
    urls.push(url);if(url===INDEX)return Response.json(rows());
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
  assert.equal(result.stale,true);assert.ok(CATALOG_SEED.rows.length>1000);assert.equal(result.total,CATALOG_SEED.rows.length);
  await assert.rejects(api.catalogueMetadata('1,2,3,4,5,6,7,8,9'),e=>e.status===400);
  await assert.rejects(api.catalogueCover('https://evil.test'),e=>e.status===400);
});

test('ranking browses Bangumi by rank within the catalogue years, scans ahead for Anime1 titles and reports rank',async t=>{
  const api=await fresh();const source=seeds.find(x=>x.bgmId);const bodies=[],offsets=[];
  const filler=()=>Array.from({length:20},(_,i)=>({id:90000000+i,type:2,name:'沒有片源 '+i,rating:{rank:1+i,total:5,score:9}}));
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(url===INDEX)return Response.json(rows());
    assert.match(url,/^https:\/\/api\.bgm\.tv\/v0\/search\/subjects\?limit=20&offset=\d+$/);
    const offset=Number(new URL(url).searchParams.get('offset'));offsets.push(offset);bodies.push(JSON.parse(init.body));
    const data=offset>=100?[]:filler();if(offset===40)data.push({id:source.bgmId,type:2,name:'作品',rating:{rank:7,total:100,score:8.4}});
    return Response.json({total:1000,data});
  });
  const result=await api.browseCatalogue(new URLSearchParams({sort:'rank'}));
  assert.deepEqual(result.items.map(x=>x.id),[source.id]);
  assert.equal(result.items[0].metadata.rank,7);assert.equal(result.items[0].metadata.score,8.4);
  assert.equal(result.sort,'rank');assert.equal(result.genre,false);assert.equal(result.total,null);
  assert.deepEqual(offsets,[0,20,40,60,80]);assert.equal(result.nextPage,6);
  const oldest=[...new Set(seeds.map(x=>x.year))].sort()[0];
  const expected={keyword:'',sort:'rank',filter:{type:[2],nsfw:false,rank:['>0'],air_date:['>='+oldest+'-01-01']}};
  bodies.forEach(body=>assert.deepEqual(body,expected));
  const tail=await api.browseCatalogue(new URLSearchParams({sort:'rank',page:'6'}));
  assert.deepEqual(tail.items,[]);assert.equal(tail.nextPage,null);
  const yearly=await api.browseCatalogue(new URLSearchParams({sort:'rank',year:source.year}));
  assert.deepEqual(yearly.items.map(x=>x.id),[source.id]);
  assert.deepEqual(bodies.at(-1).filter.air_date,['>='+source.year+'-01-01','<'+(Number(source.year)+1)+'-01-01']);
  await assert.rejects(api.browseCatalogue(new URLSearchParams({sort:'score'})),e=>e.status===400);
});

test('ranking stops scanning once a page has enough matches and paginates in Bangumi pages',async t=>{
  const api=await fresh();const many=Array.from({length:30},(_,i)=>({id:800000+i,bgmId:800000+i,title:'排行 '+i}));const offsets=[];
  t.mock.method(globalThis,'fetch',async url=>{
    if(url===INDEX)return Response.json(many.map(x=>indexRow(x.id,x.title)));
    const offset=Number(new URL(url).searchParams.get('offset'));offsets.push(offset);
    return Response.json({total:30,data:many.slice(offset,offset+20).map((x,i)=>({id:x.bgmId,type:2,name:x.title,rating:{rank:offset+i+1,total:50,score:8}}))});
  });
  const first=await api.browseCatalogue(new URLSearchParams({sort:'rank'}));
  assert.deepEqual(first.items.map(x=>x.id),many.slice(0,20).map(x=>x.id));assert.deepEqual(first.items.map(x=>x.metadata.rank),Array.from({length:20},(_,i)=>i+1));
  assert.deepEqual(offsets,[0]);assert.equal(first.nextPage,2);
  const second=await api.browseCatalogue(new URLSearchParams({sort:'rank',page:'2'}));
  assert.deepEqual(second.items.map(x=>x.id),many.slice(20).map(x=>x.id));assert.equal(second.nextPage,null);assert.deepEqual(offsets,[0,20]);
});
