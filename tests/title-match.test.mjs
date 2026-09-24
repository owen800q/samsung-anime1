import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTitle, titleQueries, titleMatchCached, LLM_TIMEOUT_MS, monthOf, pickEpisodes } from '../src/title-match.js';
import { fallbackDanmaku } from '../src/danmaku-server.js';
const item={id:1921,title:'無職轉生III～到了異世界就拿出真本事～ (第三季)',year:'2026',season:'夏'};
const candidates=[{id:1,title:'無職轉生 第二季',year:'2023'},{id:2,title:'無職轉生 ～到了異世界就拿出真本事～第三季',year:'2026'}];
const env={TITLE_MATCH_LLM_API_KEY:'test-token'};
test('short query removes Roman season suffix while preserving full identity',()=>{
  assert.deepEqual(titleQueries(item.title),[item.title,'無職轉生','無職轉生III～到了異世界就拿出真本事～']);
});
test('a short "Re:" style prefix is never used as the series query',()=>{
  assert.deepEqual(titleQueries('Re:從零開始的異世界生活 第四季'),['Re:從零開始的異世界生活 第四季','Re:從零開始的異世界生活','從零開始的異世界生活']);
  // 動畫瘋 search is a substring match: "SPY×FAMILY 間諜家家酒 Season 3" is only found by a script-split query.
  assert.deepEqual(titleQueries('SPY×FAMILY間諜家家酒 第三季'),['SPY×FAMILY間諜家家酒 第三季','SPY×FAMILY間諜家家酒','間諜家家酒','SPY×FAMILY']);
  assert.ok(titleQueries('WIND BREAKER—防風少年— 第二季').includes('防風少年'));
  assert.deepEqual(titleQueries('葬送的芙莉蓮 第2期'),['葬送的芙莉蓮 第2期','葬送的芙莉蓮']);
  assert.deepEqual(titleQueries('86'),['86']);
});
test('multi-cour catalogue years accept candidates from any listed year',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw new Error('unexpected fetch');});
  const fire={id:1631,title:'炎炎消防隊 參之章(第三季)',year:'2025/2026',season:'春/冬',aliases:[]};
  assert.equal((await chooseTitle(fire,[{id:9,title:'炎炎消防隊 參之章(第三季)',year:'2025',date:'2025-04-05'}],env)).id,9);
});
test('split-cour season: exact names are resolved by airing season, LLM gets start months and source season',async t=>{
  const rezero={id:1878,title:'Re:從零開始的異世界生活 第四季',year:'2026',season:'春',aliases:[]};
  t.mock.method(globalThis,'fetch',()=>{throw new Error('unexpected fetch');});
  const cours=[{id:2,title:'Re：從零開始的異世界生活 第四季',year:'2026',date:'2026-08-12'},{id:1,title:'Re：從零開始的異世界生活 第四季',year:'2026',date:'2026-04-08'}];
  assert.equal((await chooseTitle(rezero,cours,env)).id,1);
  const bangumi=[
    {id:425998,title:'Re：从零开始的异世界生活 第三季 袭击篇',year:'2024',date:'2024-10-02'},
    {id:9303,title:'Re: 甜心战士',year:'2026',date:'2026-01-01'},
    {id:633836,title:'Re：从零开始的异世界生活 第四季 夺还篇',year:'2026',date:'2026-08-12'},
    {id:547888,title:'Re：从零开始的异世界生活 第四季 丧失篇',year:'2026',date:'2026-04-08'},
  ];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const body=JSON.parse(init.body),input=JSON.parse(body.messages[1].content);
    assert.equal(input.source.season,'春');
    assert.match(body.messages[0].content,/cours or parts/);
    assert.deepEqual(input.candidates.map(x=>x.start),['2026-08','2026-04','2026-01'],'same-year candidates ranked by similarity, with start months');
    return Response.json({choices:[{message:{content:'{"index":1,"confidence":0.92}'}}]});
  });
  assert.equal((await chooseTitle(rezero,bangumi,env)).id,547888);
});
test('exact identity has no LLM request; disabled fallback never calls LLM',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw new Error('unexpected fetch');});
  assert.equal(await chooseTitle({...item,title:candidates[1].title},candidates,env),candidates[1]);
  assert.equal(await chooseTitle(item,candidates,{}),null);
});
test('buffered gateway response selects a real same-year candidate, API key stays on fixed backend',async t=>{
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    assert.equal(url,'https://llm-web-api-ttfg.onrender.com/v1/chat/completions');assert.equal(init.redirect,'manual');
    assert.equal(init.headers.Authorization,'Bearer test-token');
    const body=JSON.parse(init.body);assert.equal(body.stream,false);assert.equal(body.endpoint,undefined);assert.equal(body.webSearch,undefined);assert.equal(init.headers.Cookie,undefined);
    const input=JSON.parse(body.messages[1].content);assert.equal(input.candidates.length,1);assert.equal(input.candidates[0].year,'2026');
    return Response.json({id:'chatcmpl-1',object:'chat.completion',model:'gemini-fast',choices:[{index:0,message:{role:'assistant',content:'{"index":0,"confidence":0.99}'},finish_reason:'stop'}]});
  });
  assert.equal(await chooseTitle(item,candidates,env),candidates[1]);
});
test('LLM timeout budget covers a measured gemini-fast turn',()=>{assert.ok(LLM_TIMEOUT_MS>=20000);});
test('fenced or prose-wrapped JSON is accepted; gateway error text and error objects are upstream failures',async t=>{
  for(const content of ['```json\n{"index":0,"confidence":0.99}\n```','Sure, here is the match: {"index":0,"confidence":0.99} (same season)']){
    t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{message:{content}}]}));
    assert.equal(await chooseTitle(item,candidates,env),candidates[1]);
  }
  t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{message:{content:'\n\n[gateway error: Gemini cookies expired]'}}]}));
  await assert.rejects(chooseTitle(item,candidates,env),error=>error.matchReason==='upstream_error');
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{message:'x',type:'upstream_error'}},{status:502}));
  await assert.rejects(chooseTitle(item,candidates,env),error=>error.matchReason==='http_error'&&error.status===502);
});
test('a failing full-title search does not hide the shorter query that finds the show',async t=>{
  let llm=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(url==='https://llm-web-api-ttfg.onrender.com/v1/chat/completions'){llm++;return Response.json({choices:[{message:{content:'{"index":0,"confidence":0.99}'}}]});}
    if(url.includes('search.php')){if(decodeURIComponent(url).includes('第三季'))return new Response('<html>',{status:500});return Response.json({anime:[{video_sn:100,title:candidates[1].title}]});}
    if(url.includes('video.php'))return Response.json({data:{anime:{title:candidates[1].title,seasonStart:'2026-07-01',episodes:{all:[{videoSn:100,episode:'1'}]}},video:{}}});
    throw new Error('unexpected '+url);
  });
  assert.equal((await fallbackDanmaku({...item,id:1922},'bahamut','1',env)).sources[0].id,'100');
  assert.equal(llm,1);
  t.mock.method(globalThis,'fetch',async()=>new Response('<html>',{status:500}));
  assert.deepEqual(await fallbackDanmaku({...item,id:1923},'bahamut','1',env),{sources:[]});
});
test('gateway redirects fail closed without forwarding credentials or accepting a match',async t=>{
  let requests=0;
  t.mock.method(globalThis,'fetch',async (url,init)=>{
    requests++;
    assert.equal(url,'https://llm-web-api-ttfg.onrender.com/v1/chat/completions');
    assert.equal(init.redirect,'manual');
    return new Response('{"index":0,"confidence":1}',{status:302,headers:{Location:'https://example.com/redirect'}});
  });
  await assert.rejects(chooseTitle(item,candidates,env),error=>error.matchReason==='http_error'&&error.status===302);
  assert.equal(requests,1);
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
    assert.doesNotMatch(content,/llm-web-api-ttfg|TITLE_MATCH_LLM_API_KEY|TITLE_MATCH_LLM_COOKIE|llmchat_auth|jevai|JEV_API_KEY/);
  }
  const excluded=await readFile(new URL('.assetsignore',root),'utf8');
  assert.ok(excluded.split(/\r?\n/).includes('_worker.js'));
});

test('diagnostics distinguish missing credentials and cached misses without exposing data',async t=>{
  const logs=[];t.mock.method(console,'info',entry=>logs.push(entry));
  assert.deepEqual(await fallbackDanmaku(item,'dandanplay','01',{}),{sources:[]});
  assert.ok(logs.some(x=>x.reason==='missing_secret'&&x.seriesId===1921));
  let calls=0;const load=async()=>{calls++;return null;};
  const context={scope:'danmaku',seriesId:1921,provider:'dandanplay'};
  await titleMatchCached('diagnostic-miss',load,true,context);
  await titleMatchCached('diagnostic-miss',load,true,context);
  assert.equal(calls,1);
  assert.ok(logs.some(x=>x.stage==='cache'&&x.cache==='memory'&&x.result==='unmatched'&&x.reason==='no_match'&&x.retryAfterSeconds>0));
  assert.doesNotMatch(JSON.stringify(logs),/無職|diagnostic-miss|test-token/);
});
test('diagnostics report upstream HTTP status and timeout without raw errors or key',async t=>{
  const logs=[];t.mock.method(console,'info',entry=>logs.push(entry));
  t.mock.method(globalThis,'fetch',async()=>new Response('test-token private body',{status:401}));
  await titleMatchCached('diagnostic-http',()=>chooseTitle(item,candidates,env));
  assert.ok(logs.some(x=>x.stage==='llm_error'&&x.reason==='http_error'&&x.status===401));
  t.mock.method(globalThis,'fetch',async()=>{throw new DOMException('test-token private error','TimeoutError');});
  await titleMatchCached('diagnostic-timeout',()=>chooseTitle(item,candidates,env));
  assert.ok(logs.some(x=>x.stage==='llm_error'&&x.reason==='timeout'));
  assert.doesNotMatch(JSON.stringify(logs),/test-token|private|Authorization|Bearer|https:/);
});
test('invalid JSON and wrong-year candidates have distinct sanitized diagnostics',async t=>{
  const logs=[];t.mock.method(console,'info',entry=>logs.push(entry));
  t.mock.method(globalThis,'fetch',async()=>new Response('test-token invalid json'));
  await titleMatchCached('diagnostic-json',()=>chooseTitle(item,candidates,env));
  assert.ok(logs.some(x=>x.stage==='llm_error'&&x.reason==='invalid_response'));
  await chooseTitle(item,[{title:'another title',year:'2023'}],env);
  assert.ok(logs.some(x=>x.reason==='year_mismatch'&&x.validCandidates===0&&x.candidates===1));
  assert.doesNotMatch(JSON.stringify(logs),/test-token|invalid json|another title/);
});

test('dated Bahamut search rows are ranked and need no detail request before the LLM',async t=>{
  let details=0;const rezero={id:1878,title:'Re:從零開始的異世界生活 第四季',year:'2026',season:'春',aliases:[]};
  const rows=[
    {video_sn:44050,title:'陰陽迴天 Re:Birth Verse',info:'年份：2025/07 共 12 集'},
    {video_sn:48502,title:'Re：從零開始的異世界生活 第四季',info:'年份：2026/04 共 18 集'},
    {video_sn:40260,title:'Re：從零開始的異世界生活 第三季',info:'年份：2024/10 共 16 集'},
  ];
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.includes('chat/completions'))throw new Error('exact match must not call the LLM');
    if(url.includes('search.php'))return Response.json({anime:rows});
    if(url.includes('video.php')){details++;return Response.json({data:{anime:{title:'Re：從零開始的異世界生活 第四季 [1]',seasonStart:'2026/04/08',episodes:{0:[{videoSn:48502,episode:1},{videoSn:48503,episode:2}]}},video:{}}});}
    throw new Error('unexpected '+url);
  });
  assert.equal((await fallbackDanmaku(rezero,'bahamut','01',env)).sources[0].id,'48502');
  assert.equal(details,1,'only the selected series is resolved for its episode list');
  assert.equal(monthOf('2026/4/08'),'2026-04');assert.equal(monthOf('2026-04-08T00:00:00'),'2026-04');assert.equal(monthOf(''),'');
});

test('episodes numbered across seasons map by position only when unambiguous',()=>{
  const eps=labels=>labels.map(label=>({label,id:label}));
  assert.equal(pickEpisodes(eps(['38','39','40']),'01')[0].id,'38');
  assert.equal(pickEpisodes(eps(['38','39','40']),'3')[0].id,'40');
  assert.deepEqual(pickEpisodes(eps(['38','39','40']),'4'),[]);
  assert.equal(pickEpisodes(eps(['1','2','3']),'2')[0].id,'2');
  assert.deepEqual(pickEpisodes(eps(['38','40','41']),'1'),[],'a gap makes positions unreliable');
  assert.deepEqual(pickEpisodes(eps(['38','38','39']),'1'),[],'duplicates make positions unreliable');
  assert.equal(pickEpisodes(eps(['38','38.5','39','特別篇']),'2')[0].id,'39','specials do not shift positions');
  assert.deepEqual(pickEpisodes(eps(['1','2']),'1.5'),[]);
  const dubbed=[...eps(['38','39']).map(x=>({...x,group:'0'})),...eps(['38','39']).map(x=>({...x,id:'dub'+x.id,group:'3'}))];
  assert.equal(pickEpisodes(dubbed,'1')[0].id,'38','a dubbed group repeating numbers does not make episodes ambiguous');
  assert.equal(pickEpisodes(dubbed,'39')[0].id,'39');
});
test('a fast Gemini failure falls back to the next model; auth errors and timeouts do not',async t=>{
  const models=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{const {model}=JSON.parse(init.body);models.push(model);
    return model==='gemini-fast'?Response.json({error:{message:'upstream HTTPError',type:'upstream_error'}},{status:502}):Response.json({choices:[{message:{content:'{"index":0,"confidence":0.95}'}}]});});
  assert.equal(await chooseTitle(item,candidates,env),candidates[1]);
  assert.deepEqual(models,['gemini-fast','qwen']);
  models.length=0;t.mock.method(globalThis,'fetch',async(url,init)=>{models.push(JSON.parse(init.body).model);return new Response('no',{status:401});});
  await assert.rejects(chooseTitle(item,candidates,env),error=>error.status===401);assert.deepEqual(models,['gemini-fast']);
  models.length=0;t.mock.method(globalThis,'fetch',async(url,init)=>{models.push(JSON.parse(init.body).model);throw new DOMException('slow','TimeoutError');});
  await assert.rejects(chooseTitle(item,candidates,env),error=>error.name==='TimeoutError');assert.deepEqual(models,['gemini-fast']);
});
test('Jev decides confidently, gets season facts precomputed, and falls back to the gateway when unsure or failing',async t=>{
  const rezero={id:1878,title:'Re:從零開始的異世界生活 第四季',year:'2026',season:'春',aliases:[]};
  const cours=[{id:633836,title:'Re：从零开始的异世界生活 第四季 夺还篇',year:'2026',date:'2026-08-12'},{id:547888,title:'Re：从零开始的异世界生活 第四季 丧失篇',year:'2026',date:'2026-04-08'}];
  const both={JEV_API_KEY:'jev-test',TITLE_MATCH_LLM_API_KEY:'test-token'};
  let jevAnswer,calls=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    if(url==='https://www.jevai.org/api/v1/decisions'){calls.push('jev');
      assert.equal(init.headers.Authorization,'Bearer jev-test');assert.equal(init.redirect,'manual');
      const body=JSON.parse(init.body),criteria=body.questions.match.criteria;
      assert.equal(body.questions.match.type,'choice');assert.ok('none' in criteria);
      const byTitle=Object.fromEntries(Object.entries(criteria).filter(([k])=>k!=='none').map(([k,v])=>[v.title,[k,v.airs_in_source_season]]));
      assert.equal(byTitle[cours[1].title][1],true);assert.equal(byTitle[cours[0].title][1],false,'season comparison is done in code');
      if(jevAnswer instanceof Response)return jevAnswer;
      const choice=jevAnswer.choice==='spring'?byTitle[cours[1].title][0]:jevAnswer.choice;
      return Response.json({code:0,message:'ok',data:{answers:{match:{type:'choice',choice,confidence:jevAnswer.confidence,probabilities:{[choice]:jevAnswer.p}}}}});}
    calls.push('gateway');return Response.json({choices:[{message:{content:'{"index":0,"confidence":0.95}'}}]});
  });
  jevAnswer={choice:'spring',confidence:0.9,p:0.95};
  assert.equal((await chooseTitle(rezero,cours,both)).id,547888);assert.deepEqual(calls,['jev']);
  calls=[];jevAnswer={choice:'none',confidence:0.9,p:0.95};
  assert.equal(await chooseTitle(rezero,cours,both),null);assert.deepEqual(calls,['jev'],'a confident none is final');
  calls=[];jevAnswer={choice:'spring',confidence:0.3,p:0.5};
  assert.ok(await chooseTitle(rezero,cours,both));assert.deepEqual(calls,['jev','gateway'],'low confidence asks the gateway');
  calls=[];jevAnswer=new Response('no',{status:401});
  assert.ok(await chooseTitle(rezero,cours,both));assert.deepEqual(calls,['jev','gateway'],'a Jev failure asks the gateway');
  calls=[];jevAnswer={choice:'spring',confidence:0.3,p:0.5};
  assert.equal(await chooseTitle(rezero,cours,{JEV_API_KEY:'jev-test'}),null);assert.deepEqual(calls,['jev'],'Jev alone never guesses');
});
test('Jev 429 is retried with backoff before falling back',async t=>{
  let jev=0;
  t.mock.method(globalThis,'fetch',async url=>{jev++;return jev===1?Response.json({code:-1,message:'Too many requests.'},{status:429}):Response.json({code:0,data:{answers:{match:{type:'choice',choice:'c0',confidence:0.95,probabilities:{c0:0.97}}}}});});
  const started=Date.now();
  assert.equal(await chooseTitle(item,candidates,{JEV_API_KEY:'jev-test'}),candidates[1]);
  assert.equal(jev,2);assert.ok(Date.now()-started>=1400,'waits before retrying');
});
