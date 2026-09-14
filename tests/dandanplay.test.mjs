import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {dandanHeaders,decodeDandanplay,getDanmaku,searchDanmaku,resolveDanmaku,matchDandanplay,validDanmakuSetting} from '../src/danmaku-server.js';
import worker from '../src/worker.js';
const env={DANDANPLAY_APP_ID:'test-app',DANDANPLAY_APP_SECRET:'test-only-secret'};
const src={provider:'dandanplay',id:'1230001',url:'https://api.dandanplay.net/api/v2/bangumi/123?episodeId=1230001',title:'第一集'};
const data={success:true,bangumi:{animeId:123,animeTitle:'fixture',titles:[{title:'別名'}],bangumiUrl:'https://bgm.tv/subject/456',episodes:[{episodeId:1230001,episodeNumber:'1',episodeTitle:'第一集'},{episodeId:1230002,episodeNumber:'S1',episodeTitle:'特別篇'}]}};
test('Dandanplay signs the documented path and never exposes secrets in configuration',async()=>{
 const h=await dandanHeaders(env,'/api/v2/comment/1230001',1735660800);
 assert.equal(h['X-Signature'],createHash('sha256').update('test-app1735660800/api/v2/comment/1230001test-only-secret').digest('base64'));
 assert.equal(h['X-AppSecret'],undefined);
 const r=await worker.fetch(new Request('https://site.test/api/danmaku/providers'),env);
 assert.deepEqual(await r.json(),{dandanplay:true});
 await assert.rejects(getDanmaku('dandanplay','1230001',1,{}),e=>e.status===503);
});
test('Dandanplay normalizes seconds, modes and decimal RGB, rejects malformed data',()=>{
 assert.deepEqual(decodeDandanplay({comments:[{p:'1.25,1,16711680,123',m:'hello'},{p:'2,5,255,12',m:'top'},{p:'3,4,65280,4',m:'bottom'},{p:',1,0,x',m:'invalid'},{p:'-1,1,0,x',m:'invalid'},{p:'1,7,0,x',m:'invalid'},{p:'1.25,1,16711680,123',m:'hello'}]}).map(x=>[x.time,x.mode,x.color,x.text]),[[1.25,1,'#ff0000','hello'],[2,5,'#0000ff','top'],[3,4,'#00ff00','bottom']]);
 assert.throws(()=>decodeDandanplay({success:false}));
});
test('comment CDN redirect is bounded, requests related pools, and strips authentication',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push({url:String(url),init});return calls.length===1?new Response(null,{status:302,headers:{location:'https://comment.dandanplay.net/test.json'}}):Response.json({comments:[{p:'1,1,16777215,0',m:'real-format fixture'}]});});
 const r=await getDanmaku('dandanplay','1230001',1,env);
 assert.equal(r.comments.length,1);assert.equal(r.includesRelated,true);
 assert.equal(new URL(calls[0].url).searchParams.get('withRelated'),'true');
 assert.equal(calls[0].init.headers['X-AppId'],'test-app');
 assert.equal(calls[1].init.headers['X-AppId'],undefined);assert.equal(calls[1].init.headers['X-Signature'],undefined);
 assert.ok(calls.every(x=>x.init.redirect==='manual'));
});
test('untrusted CDN redirects and source errors fail without exposing credentials',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://dandanplay.net.evil.test/stolen'}});});
 await assert.rejects(getDanmaku('dandanplay','1230001',1,env),e=>e.status===502&&!e.message.includes(env.DANDANPLAY_APP_SECRET));assert.equal(calls,1);
});
test('search, resolve and Bangumi identity match retain special episode distinctions',async t=>{
 t.mock.method(globalThis,'fetch',async url=>String(url).includes('/search/')?Response.json({success:true,animes:[{animeId:123,animeTitle:'fixture',startDate:'2026-07-01'}]}):Response.json(data));
 const search=await searchDanmaku('fixture','dandanplay',env);assert.equal(search.results[0].year,'2026');
 const resolved=await resolveDanmaku(src.url,env);assert.equal(resolved.episodes[1].label,'S1');
 assert.equal((await matchDandanplay('456','1',env)).sources[0].id,'1230001');
 assert.equal((await matchDandanplay('999','1',env)).sources.length,0);
 assert.equal((await matchDandanplay('456','2',env)).sources.length,0);
});
test('multi-source settings migrate legacy offsets and validate each provider separately',()=>{
 const bahamut={provider:'bahamut',id:'10',url:'https://ani.gamer.com.tw/animeVideo.php?sn=10',title:'fixture'};
 const legacy=validDanmakuSetting({episodeId:'1',source:bahamut,offset:2,revision:0});assert.equal(legacy.sources[0].offset,2);
 const multi=validDanmakuSetting({...legacy,sources:[{...bahamut,offset:2},{...src,offset:-3}]});assert.equal(multi.sources.length,2);assert.equal(multi.sources[1].offset,-3);
 assert.equal(validDanmakuSetting({...legacy,sources:[src,src]}),null);
 assert.equal(validDanmakuSetting({...legacy,sources:[{...src,id:'1230002'}]}),null);
 assert.equal(validDanmakuSetting({...legacy,sources:[{...src,offset:301}]}),null);
 assert.equal(validDanmakuSetting({...legacy,sources:[{...src,url:'https://evil.test/'}]}),null);
 assert.deepEqual(validDanmakuSetting({...legacy,source:null,sources:[]}).sources,[]);
});
