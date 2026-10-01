import test from 'node:test';
import assert from 'node:assert/strict';
import {episodeUrl,idFromUrl,parsePlayer,parseEpisodes,parseCatalogue,resolveEpisode,signedMedia,verifyMedia,rewritePlaylist,streamMedia} from '../src/adapter.js';
import worker from '../src/worker.js';
import {WatchHistory} from '../src/sync-server.js';
import {remoteCommand} from '../src/remote-server.js';
import {validDanmakuSetting} from '../src/danmaku-server.js';
import {MemoryStorage} from './helpers/pairing-storage.mjs';
const url='https://gimytv.io/eps/202653122-zheng-pian.html';
const env={GIMY_MEDIA_HOSTS:'media.example.com,keys.example.com',GIMY_STREAM_SECRET:'test-only-secret-01234567890123456789'};
const html='<h1>測試電影</h1><script>var player_aaaa={"url":"https://media.example.com/v/master.m3u8","encrypt":0};window.open("https://ads.invalid")</script><a href="/eps/202653122-zheng-pian.html">正片</a><a href="/eps/202653122-2.html">第二集</a><a href="/eps/99999-1.html">另一套</a>';
test('Gimy URL validation preserves episode slugs and rejects foreign URLs and ambiguous inputs',()=>{
  assert.equal(episodeUrl(url),url);assert.equal(idFromUrl(url),'202653122-zheng-pian');
  for(const input of ['https://gimytv.io.evil.test/eps/1-2.html','http://gimytv.io/eps/1-2.html','https://user@gimytv.io/eps/1.html',url+'?url=x',url+'#x','https://gimytv.io/','https://gimytv.io/eps/../1.html'])assert.throws(()=>episodeUrl(input));
});
test('only source JSON/video data is parsed; foreign script calls and frames are never executed',()=>{
  assert.equal(parsePlayer(html,url).url,'https://media.example.com/v/master.m3u8');
  const source='https://media.example.com/v/a.mp4?q=a%20b';
  for(const [encrypt,value] of [[1,encodeURIComponent(source)],[2,btoa(encodeURIComponent(source))]])assert.equal(parsePlayer('<script>var player_a='+JSON.stringify({url:value,encrypt})+'</script>',url).url,source);
  assert.equal(parsePlayer('<video><source src="https://media.example.com/a.mp4"></video>',url).type,'mp4');
  for(const body of ['<iframe src="https://ads.invalid"></iframe>','<script>player_a={url:alert(1)}</script>','<script>player_a={"url":"javascript:alert(1)"}</script>'])assert.throws(()=>parsePlayer(body,url),e=>e.code==='UNSUPPORTED_PLAYER');
});
test('episode discovery excludes other series and supports independent alternate slugs',()=>{
  const result=parseEpisodes(html,url);assert.equal(result.seriesId,'202653122');assert.equal(result.episodes.length,2);assert.equal(result.episodes[1].url,'https://gimytv.io/eps/202653122-2.html');
  assert.equal(parseEpisodes(html,'https://gimytv.io/detail/202653122.html').episodes.length,2);
});
test('catalogue results are source-scoped and deduplicated by series',()=>{
  const results=parseCatalogue('<a title="測試電影" href="/detail/202653122.html"><img src="ad.png"></a><a href="/eps/202653122-1.html">正片</a><a href="https://evil.test/detail/1.html">廣告</a>');assert.equal(results.length,1);assert.equal(results[0].title,'測試電影');
});
test('signed media survives separate requests, rejects tampering, expiry and unconfigured/private hosts',async()=>{
  const link=await signedMedia('https://media.example.com/a.mp4',url,env);const token=new URL(link,'https://app.test').searchParams.get('token');assert.equal((await verifyMedia(token,{...env})).url,'https://media.example.com/a.mp4');
  await assert.rejects(verifyMedia(token.slice(0,-4)+'xxxx',env),e=>e.status===401);
  await assert.rejects(verifyMedia(new URL(await signedMedia('https://media.example.com/a.mp4',url,env,Date.now()-10),'https://app.test').searchParams.get('token'),env),e=>e.status===401);
  for(const source of ['https://127.0.0.1/a.mp4','https://localhost/a.mp4','https://evil.test/a.mp4','http://media.example.com/a.mp4','https://media.example.com:8443/a.mp4'])await assert.rejects(signedMedia(source,url,env));
  await assert.rejects(signedMedia('https://media.example.com/a.mp4',url,{...env,GIMY_STREAM_SECRET:''}),e=>e.status===503);
});
test('HLS rewrites relative variants, segments, maps and key URLs through signed proxy links',async()=>{
  const expiry=Date.now()+60000;
  const result=await rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/key"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg-1.ts\n../variant.m3u8?token=x','https://media.example.com/v/master.m3u8',url,env,expiry);
  const links=[...result.matchAll(/(?:URI="|^)(\/api\/media\?token=[^"\n]+)/gm)].map(m=>m[1]);assert.equal(links.length,4);
  const values=await Promise.all(links.map(x=>verifyMedia(new URL(x,'https://app.test').searchParams.get('token'),env)));
  assert.deepEqual(values.map(x=>x.url),['https://keys.example.com/key','https://media.example.com/v/init.mp4','https://media.example.com/v/seg-1.ts','https://media.example.com/variant.m3u8?token=x']);assert.ok(values.every(x=>x.expiry===expiry));
  await assert.rejects(rewritePlaylist('#EXTM3U\nhttps://evil.test/segment.ts','https://media.example.com/a.m3u8',url,env,expiry));
});
test('Gimy slug identities survive durable history, remote commands and danmaku settings',async()=>{
  const storage=new MemoryStorage(),db=new WatchHistory({storage});
  const entry={episodeId:'202653122-zheng-pian',seriesId:'202653122',title:'電影',seriesTitle:'電影',position:60,duration:1000,revision:0};
  assert.equal((await db.fetch(new Request('https://history.internal/',{method:'PUT',body:JSON.stringify(entry)}))).status,200);
  assert.equal((await (new WatchHistory({storage})).fetch(new Request('https://history.internal/'))).status,200);
  assert.equal(remoteCommand({type:'play',...entry}).episodeId,entry.episodeId);
  assert.ok(validDanmakuSetting({episodeId:entry.episodeId,source:null,offset:0,revision:0}));
});
test('real resolve route parses upstream JSON into a signed HLS source without loading ads',async()=>{
  const original=globalThis.fetch;const calls=[];globalThis.fetch=async input=>{calls.push(String(input));return new Response(html,{headers:{'Content-Type':'text/html'}});};
  try{const r=await worker.fetch(new Request('https://app.test/api/resolve',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://app.test'},body:JSON.stringify({url,refresh:true})}),env);assert.equal(r.status,200);const data=await r.json();assert.equal(data.type,'hls');assert.ok(data.media.startsWith('/api/media?token='));assert.deepEqual(calls,[url]);}finally{globalThis.fetch=original;}
});
test('range requests preserve seeking headers and never expose upstream cookies',async()=>{
  const original=globalThis.fetch;let captured;globalThis.fetch=async (target,init)=>{captured={target,init};return new Response('abc',{status:206,headers:{'Content-Type':'video/mp4','Content-Range':'bytes 10-12/100','Set-Cookie':'private=secret'}});};
  try{const path=await signedMedia('https://media.example.com/a.mp4',url,env);const response=await streamMedia(new Request('https://app.test'+path,{headers:{Range:'bytes=10-12'}}),env);assert.equal(response.status,206);assert.equal(captured.init.headers.Range,'bytes=10-12');assert.equal(response.headers.get('content-range'),'bytes 10-12/100');assert.equal(response.headers.get('set-cookie'),null);}finally{globalThis.fetch=original;}
});
test('media redirects cannot escape the host allowlist',async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}});};
  try{const path=await signedMedia('https://media.example.com/a.mp4',url,env);await assert.rejects(streamMedia(new Request('https://app.test'+path),env));assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
test('source blocking is explicit, and cross-site resolve does not contact the source',async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('<title>Attention Required!</title>Sorry, you have been blocked',{status:403});};
  try{const request=origin=>new Request('https://app.test/api/resolve',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({url,refresh:true})});let r=await worker.fetch(request('https://other.test'),env);assert.equal(r.status,403);assert.equal(calls,0);r=await worker.fetch(request('https://app.test'),env);assert.equal(r.status,502);assert.equal((await r.json()).code,'SOURCE_BLOCKED');}finally{globalThis.fetch=original;}
});
