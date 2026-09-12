import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDanmakuSource,searchDanmaku,resolveDanmaku,getDanmaku,decodeBilibili,normalizeDanmaku,bahamutFailure} from '../src/danmaku-server.js';
import worker from '../src/worker.js';
import {WatchHistory,historyRoute} from '../src/sync-server.js';

const json=x=>Response.json(x);
test('Bahamut errors preserve bounded public reasons without dumping response bodies',()=>{
 assert.match(bahamutFailure({error:{message:'系統維修中'},data:null}),/系統維修中/);
 assert.match(bahamutFailure({data:[]}),/data array/);
 assert.doesNotMatch(bahamutFailure({data:{unexpected:'DO_NOT_DUMP'}}),/DO_NOT_DUMP/);
 assert.ok(bahamutFailure({error:'x'.repeat(1000)}).length<300);
});
function wire(n){const a=[];do{let b=n%128;n=Math.floor(n/128);a.push(b+(n?128:0));}while(n);return a;}
const uint=(f,n)=>[...wire(f*8),...wire(n)];
const str=(f,s)=>{const b=new TextEncoder().encode(s);return [...wire(f*8+2),...wire(b.length),...b];};
const elem=(time,mode,text)=>{const b=[...uint(1,999999999999),...uint(2,time),...uint(3,mode),...uint(5,0xffcc00),...str(7,text),...str(13,'unknown')];return [10,...wire(b.length),...b];};

test('source parsing accepts supported complete URLs but never arbitrary hosts or redirect links',()=>{
 assert.equal(parseDanmakuSource('https://ani.gamer.com.tw/animeVideo.php?sn=37701&foo=bar').id,'37701');
 assert.equal(parseDanmakuSource('https://www.bilibili.com/video/BV1xx411c7mD?p=2').page,2);
 assert.equal(parseDanmakuSource('https://www.bilibili.com/bangumi/play/ep123').kind,'ep');
 assert.equal(parseDanmakuSource('https://www.bilibili.com/bangumi/play/ss123').kind,'ss');
 for(const url of ['https://b23.tv/test','https://ani.gamer.com.tw.evil/animeVideo.php?sn=1','https://user:pass@ani.gamer.com.tw/animeVideo.php?sn=1','http://127.0.0.1/','https://ani.gamer.com.tw:8443/animeVideo.php?sn=1','https://www.bilibili.com/video/BV1xx411c7mD?p=-1'])assert.throws(()=>parseDanmakuSource(url));
});
test('protobuf decoder handles milliseconds, unknown fields, literal text and supported modes',()=>{
 const rows=decodeBilibili(new Uint8Array([...elem(361250,1,'<img onerror=x>'),...elem(1000,5,'頂部'),...elem(1000,7,'script'),...elem(361250,1,'<img onerror=x>')]));
 assert.deepEqual(rows.map(x=>[x.time,x.mode,x.text]),[[1,5,'頂部'],[361.25,1,'<img onerror=x>']]);
 assert.equal(rows[0].color,'#ffcc00');
 for(const bytes of [[10,50,1],[10,2,18,5],[8,128],[0],[15]])assert.throws(()=>decodeBilibili(new Uint8Array(bytes)));
 assert.equal(normalizeDanmaku([{time:-1,mode:1,text:'bad'},{time:1,mode:1,text:'okay',color:'url(javascript:x)'}])[0].color,'#ffffff');
});
test('Bahamut search and episode groups normalize IDs without treating failure as empty',async t=>{
 const urls=[];t.mock.method(globalThis,'fetch',async(url,init)=>{urls.push(String(url));assert.equal(init.redirect,'manual');assert.equal(init.headers.Cookie,undefined);
  if(String(url).includes('search.php'))return json({anime:[{video_sn:10,title:'測試動畫'},{video_sn:'bad'}]});
  return json({data:{video:{videoSn:10},anime:{title:'測試動畫',seasonStart:'2026-07-01',episodes:{0:[{videoSn:10,episode:'1'}],1:[{videoSn:11,episode:'SP'},{videoSn:10,episode:'1'}]}}}});
 });
 assert.equal((await searchDanmaku('測試動畫')).results[0].provider,'bahamut');
 const result=await resolveDanmaku('https://ani.gamer.com.tw/animeVideo.php?sn=10');assert.equal(result.year,'2026');assert.equal(result.episodes.length,2);assert.equal(result.episodes[1].label,'SP');assert.ok(urls.every(x=>new URL(x).hostname==='api.gamer.com.tw'));
});
test('Bilibili BV split pages and season episodes retain individual CIDs',async t=>{
 t.mock.method(globalThis,'fetch',async url=>String(url).includes('/view?')?json({code:0,data:{title:'test',pages:[{cid:100,page:1,part:'一'},{cid:200,page:2,part:'二'}]}}):json({code:0,result:{title:'season',episodes:[{id:1,cid:101,title:'1',long_title:'一'},{id:2,cid:102,title:'2',long_title:'二'}]}}));
 const bv=await resolveDanmaku('https://www.bilibili.com/video/BV1xx411c7mD?p=2');assert.equal(bv.episodes.find(x=>x.selected).id,'200');
 const ep=await resolveDanmaku('https://www.bilibili.com/bangumi/play/ep2');assert.equal(ep.episodes.find(x=>x.selected).id,'102');
});
test('comment requests normalize Bahamut deciseconds and fetch just one Bilibili segment',async t=>{
 const urls=[];t.mock.method(globalThis,'fetch',async url=>{urls.push(String(url));return String(url).includes('gamer.com')?json({data:{danmu:[{time:15,position:0,color:'#ffffff',text:'scroll'},{time:20,position:1,text:'top'},{time:30,position:2,text:'bottom'}]}}):new Response(new Uint8Array(elem(361000,1,'later')));});
 assert.deepEqual((await getDanmaku('bahamut','10')).comments.map(x=>[x.time,x.mode]),[[1.5,1],[2,5],[3,4]]);
 assert.equal((await getDanmaku('bilibili','100',2)).comments[0].time,361);assert.equal(urls.length,2);assert.match(urls[1],/segment_index=2$/);
 await assert.rejects(getDanmaku('bilibili','https://evil/',1));await assert.rejects(getDanmaku('bilibili','100',241));assert.equal(urls.length,2);
});
test('upstream denial/redirect/HTML/malformed data is an error and not cached',async t=>{
 const responses=[new Response('',{status:403}),new Response('',{status:302,headers:{Location:'https://evil/'}}),new Response('<html>captcha</html>',{headers:{'content-type':'text/html'}}),json({error:'denied'}),json({data:{danmu:[]}})];let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return responses.shift();});
 for(let i=0;i<4;i++)await assert.rejects(getDanmaku('bahamut','12'),e=>e.status===502);
 assert.deepEqual((await getDanmaku('bahamut','12')).comments,[]);assert.equal(calls,5);
});
class Storage{data=new Map();async get(k){return structuredClone(Array.isArray(k)?new Map(k.filter(x=>this.data.has(x)).map(x=>[x,this.data.get(x)])):this.data.get(k));}async put(k,v){this.data.set(k,structuredClone(v));}async delete(k){this.data.delete(k);}async transaction(fn){return fn(this);}}
test('per-episode mappings persist across devices, isolate profiles, and reject stale edits',async()=>{
 const stores=new Map();const env={WATCH_HISTORY:{idFromName:x=>x,get:x=>{if(!stores.has(x))stores.set(x,new Storage());return new WatchHistory({storage:stores.get(x)});}}};
 const source={provider:'bahamut',id:'10',url:'https://ani.gamer.com.tw/animeVideo.php?sn=10',title:'一'};
 const call=(id,token='a'.repeat(32),data)=>historyRoute(new Request('https://site.test/api/danmaku/settings?episode='+id,{method:data?'PUT':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined}),env);
 const first=await call('1',undefined,{episodeId:'1',source,offset:1.5,revision:0});assert.equal(first.status,200);
 assert.equal((await (await call('1')).json()).entry.offset,1.5);
 assert.equal((await (await call('2')).json()).entry.source,null);assert.equal((await (await call('1','b'.repeat(32))).json()).entry.source,null);
 assert.equal((await call('1',undefined,{episodeId:'1',source,offset:-2,revision:0})).status,409);
 assert.equal((await call('1',undefined,{episodeId:'1',source:{...source,url:'https://evil/'},offset:0,revision:1})).status,400);
 assert.equal((await call('1',undefined,{episodeId:'1',source:null,offset:0,revision:1})).status,200);
 assert.equal((await (await call('1')).json()).entry.revision,2,'clear creates a tombstone, preventing auto-rematching');
 const history=await historyRoute(new Request('https://site.test/api/history',{headers:{Authorization:'Bearer '+'a'.repeat(32)}}),env);assert.deepEqual((await history.json()).entries,[]);
});
test('worker keeps new endpoints same-origin and requires profile token for settings',async()=>{
 assert.equal((await worker.fetch(new Request('https://site.test/api/danmaku/search?q=x',{headers:{Origin:'https://other.test'}}),{})).status,403);
 assert.equal((await worker.fetch(new Request('https://site.test/api/danmaku/settings?episode=1'),{})).status,401);
});
