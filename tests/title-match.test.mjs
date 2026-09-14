import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTitle, titleQueries, titleMatchCached } from '../src/title-match.js';
import { fallbackDanmaku } from '../src/danmaku-server.js';
const item={id:1921,title:'無職轉生III～到了異世界就拿出真本事～ (第三季)',year:'2026',season:'夏'};
const candidates=[{id:1,title:'無職轉生 第二季',year:'2023'},{id:2,title:'無職轉生 ～到了異世界就拿出真本事～第三季',year:'2026'}];
const env={TITLE_MATCH_LLM_API_KEY:'test-token'};
test('short query removes Roman season suffix while preserving full identity',()=>{
  assert.deepEqual(titleQueries(item.title),[item.title,'無職轉生']);
});
test('exact identity has no LLM request; disabled fallback never calls LLM',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw new Error('unexpected fetch');});
  assert.equal(await chooseTitle({...item,title:candidates[1].title},candidates,env),candidates[1]);
  assert.equal(await chooseTitle(item,candidates,{}),null);
});
test('SSE response selects a real same-year candidate, API key stays on fixed backend',async t=>{
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    assert.equal(url,'https://llm-web-api-ttfg.onrender.com/v1/chat/completions');assert.equal(init.redirect,'error');
    assert.equal(init.headers.Authorization,'Bearer test-token');
    const body=JSON.parse(init.body);assert.equal(body.stream,true);assert.equal(body.endpoint,undefined);assert.equal(body.webSearch,undefined);assert.equal(init.headers.Cookie,undefined);
    const input=JSON.parse(body.messages[1].content);assert.equal(input.candidates.length,1);assert.equal(input.candidates[0].year,'2026');
    return new Response('data: '+JSON.stringify({choices:[{delta:{content:'{"index":0,'}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{content:'"confidence":0.99}'}}]})+'\n\ndata: [DONE]\n\n');
  });
  assert.equal(await chooseTitle(item,candidates,env),candidates[1]);
});
test('invented candidate IDs, low confidence and unknown dates are rejected',async t=>{
  for(const result of [{index:9,confidence:1},{index:0,confidence:0.8},{index:'0',confidence:1}]){
    t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{message:{content:JSON.stringify(result)}}]}));
    assert.equal(await chooseTitle(item,candidates,env),null);
  }
  assert.equal(await chooseTitle(item,[{title:'some title',year:''}],env),null);
});
test('concurrent requests deduplicate, success and errors cache, cache-only reads do not poison later resolution',async()=>{
  let calls=0;const loader=async()=>{calls++;await new Promise(r=>setTimeout(r,5));return {id:2};};
  const key='test-success';
  assert.equal(await titleMatchCached(key,loader,false),null);
  const results=await Promise.all([titleMatchCached(key,loader),titleMatchCached(key,loader)]);
  assert.equal(calls,1);assert.deepEqual(results,[{id:2},{id:2}]);
  await titleMatchCached(key,loader);assert.equal(calls,1);
  let failures=0;const broken=()=>{failures++;throw new Error('offline');};
  assert.equal(await titleMatchCached('test-failure',broken),null);
  assert.equal(await titleMatchCached('test-failure',broken),null);assert.equal(failures,1);
});
test('anime 1921 fallback reuses identity across episodes and rejects ambiguous episode numbers',async t=>{
  let llm=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(url==='https://llm-web-api-ttfg.onrender.com/v1/chat/completions'){llm++;return Response.json({content:'{"index":0,"confidence":0.99}'});}
    if(url.includes('search.php'))return Response.json({anime:[{video_sn:100,title:candidates[1].title}]});
    if(url.includes('video.php'))return Response.json({data:{anime:{title:candidates[1].title,seasonStart:'2026-07-01',episodes:{all:[{videoSn:100,episode:'1'},{videoSn:101,episode:'2'},{videoSn:102,episode:'3'},{videoSn:103,episode:'3'}]}},video:{}}});
    throw new Error('unexpected '+url);
  });
  assert.equal((await fallbackDanmaku(item,'bahamut','1',env)).sources[0].id,'100');
  assert.equal((await fallbackDanmaku(item,'bahamut','2',env)).sources[0].id,'101');
  assert.deepEqual((await fallbackDanmaku(item,'bahamut','3',env)).sources,[]);
  assert.equal(llm,1);
});
test('malformed responses and authentication failure are safely negative cached',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('Unauthorized',{status:401}));
  assert.equal(await titleMatchCached('auth-failed',()=>chooseTitle(item,candidates,env)),null);
});

test('published client assets never contain gateway configuration; server bundle is excluded',async()=>{
  const {readFile,readdir}=await import('node:fs/promises');
  const root=new URL('../dist/',import.meta.url);
  for(const name of await readdir(root)){
    if(!/\.(js|html|css|json)$/.test(name)||name==='_worker.js')continue;
    const content=await readFile(new URL(name,root),'utf8');
    assert.doesNotMatch(content,/llm-web-api-ttfg|TITLE_MATCH_LLM_API_KEY|TITLE_MATCH_LLM_COOKIE|llmchat_auth/);
  }
  const excluded=await readFile(new URL('.assetsignore',root),'utf8');
  assert.ok(excluded.split(/\r?\n/).includes('_worker.js'));
});
