import { chooseTitle, titleQueries, titleMatchCached, titleMatchLog, titleSimilarity, monthOf, matchTitleKey, itemYears, pickEpisodes, matcherConfigured } from './title-match.js';
import { PlaybackError } from './adapter.js';

const DM_UA='GimyTV/1.2 (https://github.com/owen800q/Samsung-anime1)';
const DM_LIMIT=20000;
const dmNumber=s=>/^[1-9]\d{0,14}$/.test(String(s||''));
const dmTitle=s=>String(s||'').replace(/<[^>]*>/g,'').slice(0,250);
// Only construct requests to these fixed endpoints, never fetch an input URL.
export function parseDanmakuSource(input){
  if(typeof input!=='string'||input.length>500)throw new PlaybackError('請輸入支援的彈幕來源完整網址。',400);
  if(/^BV[0-9A-Za-z]{10}$/.test(input))input='https://www.bilibili.com/video/'+input;
  let u;try{u=new URL(input);}catch{throw new PlaybackError('來源網址無效。',400);}
  if(u.protocol!=='https:'||u.port||u.username||u.password)throw new PlaybackError('來源網址無效。',400);
  if(u.hostname==='ani.gamer.com.tw'&&u.pathname==='/animeVideo.php'&&dmNumber(u.searchParams.get('sn'))){
    const id=u.searchParams.get('sn');return {provider:'bahamut',id,url:'https://ani.gamer.com.tw/animeVideo.php?sn='+id};
  }
  if(u.hostname==='api.dandanplay.net'){const match=u.pathname.match(/^\/api\/v2\/bangumi\/([1-9]\d{0,14})$/);if(match){const id=u.searchParams.get('episodeId');if(id&&!dmNumber(id))throw new PlaybackError('彈幕庫編號無效。',400);return {provider:'dandanplay',animeId:match[1],id:id||null,url:'https://api.dandanplay.net/api/v2/bangumi/'+match[1]+(id?'?episodeId='+id:'')};}}
  if(['www.bilibili.com','m.bilibili.com','bilibili.com'].includes(u.hostname)){
    const bv=u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/);
    const pgc=u.pathname.match(/^\/bangumi\/play\/(ep|ss)([1-9]\d{0,14})\/?$/);
    if(bv){const p=u.searchParams.get('p')||'1';if(!/^[1-9]\d{0,2}$/.test(p))throw new PlaybackError('分 P 編號無效。',400);return {provider:'bilibili',kind:'bv',id:bv[1],page:Number(p),url:'https://www.bilibili.com/video/'+bv[1]+'?p='+p};}
    if(pgc)return {provider:'bilibili',kind:pgc[1],id:pgc[2],url:'https://www.bilibili.com/bangumi/play/'+pgc[1]+pgc[2]};
  }
  throw new PlaybackError('支援動畫瘋單集網址、Bilibili BV／ep／ss 網址及彈彈play 番劇 API 網址。',400);
}

async function dmFetch(url,binary=false,headers={},allowDandanRedirect=false){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
  let reader;
  try{
    let r=await fetch(url,{headers:{'User-Agent':DM_UA,Accept:binary?'application/octet-stream':'application/json',...headers},redirect:'manual',signal:controller.signal});
    // The official comment API redirects to its CDN. Never forward app authentication.
    for(let hop=0;allowDandanRedirect&&[301,302,303,307,308].includes(r.status);hop++){
      const location=r.headers.get('location');void r.body?.cancel();
      let target;try{target=new URL(location,url);}catch{}
      if(hop>=2||!location||!target||target.protocol!=='https:'||target.port||target.username||target.password||!(target.hostname==='dandanplay.net'||target.hostname.endsWith('.dandanplay.net')))throw new PlaybackError('彈彈play 加速服務網址無效。',502);
      url=target.href;r=await fetch(url,{headers:{'User-Agent':DM_UA,Accept:'application/json'},redirect:'manual',signal:controller.signal});
    }
    if(!r.ok){void r.body?.cancel();throw new PlaybackError('彈幕來源暫時無法讀取（HTTP '+r.status+'），請稍後重試。',502);}
    const type=r.headers.get('content-type')||'';
    if(type.includes('text/html')){void r.body?.cancel();throw new PlaybackError('彈幕來源要求驗證，請稍後重試或換來源。',502);}
    reader=r.body?.getReader();const chunks=[];let size=0;
    if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4000000){void reader.cancel();throw new PlaybackError('彈幕資料過大。',502);}chunks.push(value);}
    const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
    return binary?bytes:JSON.parse(new TextDecoder().decode(bytes));
  }catch(e){if(e instanceof PlaybackError)throw e;throw new PlaybackError(controller.signal.aborted?'彈幕來源連線逾時，影片仍可播放。':'彈幕來源回傳格式有變，請稍後重試。',502);}
  finally{clearTimeout(timer);reader?.releaseLock();}
}
async function dmCached(key,load,ttl=600){
  const cache=globalThis.caches?.default;const request=new Request('https://samsung-gimy-cache.invalid/danmaku/v1/'+encodeURIComponent(key));
  const hit=await cache?.match(request);if(hit)return hit.json();
  const data=await load();await cache?.put(request,Response.json(data,{headers:{'Cache-Control':'public,max-age='+ttl}})).catch(()=>{});return data;
}
export async function searchDanmaku(q,provider='bahamut',env={}){
  if(typeof q!=='string'||!q.trim()||q.length>100)throw new PlaybackError('請輸入動畫名稱（最多 100 字）。',400);
  if(provider==='dandanplay')return searchDandanplay(q,env);
  if(provider!=='bahamut')throw new PlaybackError('搜尋來源無效。',400);
  return dmCached('search:'+q,async()=>{
    const data=await dmFetch('https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw='+encodeURIComponent(q.trim()));
    if(!Array.isArray(data.anime))throw new PlaybackError('動畫瘋搜尋暫時無法使用。',502);
    // Search rows carry "年份：2026/04 共 18 集", so candidates rarely need a detail request for dating.
    return {results:data.anime.filter(x=>dmNumber(x.video_sn)).slice(0,30).map(x=>{const date=monthOf(String(x.info||'').match(/(\d{4}\/\d{1,2})/)?.[1]);return {title:dmTitle(x.title),url:'https://ani.gamer.com.tw/animeVideo.php?sn='+x.video_sn,provider:'bahamut',...(date?{year:date.slice(0,4),date}:{})};})};
  });
}
export async function resolveDanmaku(input,env={}){
  const source=parseDanmakuSource(input);
  if(source.provider==='dandanplay')return resolveDandanplay(source,env);
  return dmCached('resolve:'+source.url,async()=>{
    if(source.provider==='bahamut'){
      const data=await dmFetch('https://api.gamer.com.tw/anime/v1/video.php?videoSn='+source.id);
      const anime=data.data?.anime;const video=data.data?.video;
      if(!anime||!video)throw new PlaybackError('動畫瘋找不到本集資料。',502);
      const groups=anime.episodes||{};
      // Group "0" is the main release; other groups (e.g. a Chinese dub) repeat the same episode numbers.
      const eps=(Array.isArray(groups)?groups:Object.entries(groups).flatMap(([group,list])=>Array.isArray(list)?list.map(x=>({...x,group})):[])).filter(x=>dmNumber(x.videoSn));
      const unique=new Map(eps.map(x=>[String(x.videoSn),x]));
      if(!unique.size)throw new PlaybackError('動畫瘋未提供集數列表。',502);
      // The series title includes the requested episode ("… 第四季 [1]"); keep only the series name.
      anime.title=String(anime.title||'').replace(/\s*\[\d+(?:\.\d+)?\]\s*$/,'');
      return {title:dmTitle(anime.title),year:String(anime.seasonStart||'').slice(0,4),date:monthOf(anime.seasonStart),episodes:[...unique.values()].slice(0,1000).map(x=>({provider:'bahamut',id:String(x.videoSn),label:String(x.episode).slice(0,80),title:dmTitle(anime.title)+' ['+String(x.episode).slice(0,80)+']',url:'https://ani.gamer.com.tw/animeVideo.php?sn='+x.videoSn,selected:String(x.videoSn)===source.id,...(x.group!==undefined?{group:String(x.group)}:{})}))};
    }
    const endpoint=source.kind==='bv'?'https://api.bilibili.com/x/web-interface/view?bvid='+source.id:'https://api.bilibili.com/pgc/view/web/season?'+(source.kind==='ss'?'season_id=':'ep_id=')+source.id;
    const data=await dmFetch(endpoint);
    if(data.code!==0)throw new PlaybackError('Bilibili 未能提供資料（'+String(data.code).slice(0,12)+'），請稍後重試或換來源。',502);
    const item=source.kind==='bv'?data.data:data.result;
    const eps=source.kind==='bv'?item?.pages:item?.episodes;
    if(!Array.isArray(eps))throw new PlaybackError('Bilibili 未提供集數列表。',502);
    return {title:dmTitle(item.title),episodes:eps.filter(x=>dmNumber(x.cid)).slice(0,1000).map(x=>({provider:'bilibili',id:String(x.cid),label:String(source.kind==='bv'?x.page:x.title).slice(0,80),title:dmTitle(source.kind==='bv'?x.part:[x.title,x.long_title].filter(Boolean).join(' ')),url:source.kind==='bv'?'https://www.bilibili.com/video/'+source.id+'?p='+x.page:'https://www.bilibili.com/bangumi/play/ep'+x.id,selected:source.kind==='bv'?Number(x.page)===source.page:source.kind==='ep'&&String(x.id)===source.id}))};
  });
}

export function normalizeDanmaku(rows){
  const out=[];const seen=new Set();
  for(const x of rows){
    if(!Number.isFinite(x.time)||x.time<0||x.time>86400||![1,4,5].includes(x.mode)||typeof x.text!=='string')continue;
    const text=x.text.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,160);if(!text)continue;
    const key=x.time.toFixed(2)+':'+x.mode+':'+text;if(seen.has(key))continue;seen.add(key);
    out.push({time:x.time,mode:x.mode,color:/^#[\da-f]{6}$/i.test(x.color)?x.color:'#ffffff',text});
    if(out.length>=DM_LIMIT)break;
  }
  return out.sort((a,b)=>a.time-b.time);
}
// Minimal protobuf wire reader for Bilibili DmSegMobileReply / DanmakuElem.
// Unknown fields are skipped; malformed lengths/varints fail closed.
export function decodeBilibili(bytes){
  let pos=0;
  function uint(end){let n=0,m=1;for(let i=0;i<10;i++){if(pos>=end)throw new Error('Truncated varint');const b=bytes[pos++];n+=(b&127)*m;if(!(b&128))return n;m*=128;}throw new Error('Invalid varint');}
  function fields(end,fn){while(pos<end){const tag=uint(end),field=Math.floor(tag/8),wire=tag%8;if(!field)throw new Error('Invalid field');if(wire===0)fn(field,uint(end));else if(wire===2){const len=uint(end),start=pos;if(!Number.isSafeInteger(len)||len>end-pos)throw new Error('Invalid length');pos+=len;fn(field,bytes.subarray(start,pos));}else if(wire===1||wire===5){pos+=wire===1?8:4;if(pos>end)throw new Error('Truncated field');}else throw new Error('Invalid wire');}}
  const rows=[];fields(bytes.length,(field,value)=>{if(field!==1||!(value instanceof Uint8Array))return;if(rows.length>=DM_LIMIT)return;const savedBytes=bytes,savedPos=pos;bytes=value;pos=0;const row={};fields(bytes.length,(f,v)=>{if(f===2&&typeof v==='number')row.time=v/1000;if(f===3&&typeof v==='number')row.mode=v;if(f===5&&typeof v==='number'&&v>=0&&v<=0xffffff)row.color='#'+v.toString(16).padStart(6,'0');if(f===7&&v instanceof Uint8Array)row.text=new TextDecoder().decode(v);});rows.push(row);bytes=savedBytes;pos=savedPos;});return normalizeDanmaku(rows);
}
export async function getDanmaku(provider,id,segment=1,env={}){
  if(provider==='dandanplay'){if(!dmNumber(id)||segment!==1)throw new PlaybackError('彈幕庫編號無效。',400);return dandanComments(id,env);}
  if(!['bahamut','bilibili'].includes(provider)||!dmNumber(id)||!Number.isInteger(segment)||segment<1||segment>240)throw new PlaybackError('彈幕來源或分段編號無效。',400);
  return dmCached(provider+':'+id+':'+(provider==='bahamut'?1:segment),async()=>{
    let comments;
    if(provider==='bahamut'){
      const data=await dmFetch('https://api.gamer.com.tw/anime/v1/danmu.php?geo=TW%2CHK&videoSn='+id);
      if(!Array.isArray(data.data?.danmu))throw new PlaybackError(bahamutFailure(data),502);
      comments=normalizeDanmaku(data.data.danmu.map(x=>({time:Number(x.time)/10,mode:({0:1,1:5,2:4})[x.position],color:x.color,text:x.text})));
    }else{
      const bytes=await dmFetch('https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid='+id+'&segment_index='+segment,true);
      try{comments=decodeBilibili(bytes);}catch{throw new PlaybackError('Bilibili 彈幕格式無效。',502);}
    }
    return {provider,id,segment:provider==='bahamut'?1:segment,comments};
  });
}

// Public upstream errors must not be mistaken for an empty comment list.
// Include bounded schema metadata (not response bodies) for actionable diagnostics.
export function bahamutFailure(data){
  const shape=value=>value===null?'null':Array.isArray(value)?'array':typeof value==='object'?Object.keys(value).filter(k=>/^[a-zA-Z][a-zA-Z0-9_]{0,24}$/.test(k)).slice(0,12).join(','):typeof value;
  const error=data?.error;
  const message=typeof error==='string'?error:error?.message||data?.message;
  const reason=typeof message==='string'?dmTitle(message).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,160):'';
  return '動畫瘋未提供彈幕'+(reason?'：'+reason:'。')+'（回應 '+shape(data)+' / data '+shape(data?.data)+'）';
}

export function validDanmakuSetting(data){
  if(!data||!/^\d{1,10}(?:-[a-zA-Z0-9_-]{1,100})?$/.test(String(data.episodeId))||!Number.isInteger(data.revision)||data.revision<0||!Number.isFinite(data.offset)||Math.abs(data.offset)>300)return null;
  const list=data.sources===undefined?(data.source===null?[]:[data.source]):data.sources;
  if(!Array.isArray(list)||list.length>3)return null;
  const sources=[],providers=new Set();
  for(const x of list){
    if(!x||!['bahamut','bilibili','dandanplay'].includes(x.provider)||providers.has(x.provider)||!dmNumber(x.id)||typeof x.title!=='string'||x.title.length>300)return null;
    let url;try{url=parseDanmakuSource(x.url);}catch{return null;}
    if(url.provider!==x.provider||['bahamut','dandanplay'].includes(x.provider)&&url.id!==String(x.id)||url.kind==='ss')return null;
    const offset=x.offset===undefined?data.offset:x.offset;
    if(!Number.isFinite(offset)||Math.abs(offset)>300)return null;
    providers.add(x.provider);sources.push({provider:x.provider,id:String(x.id),url:url.url,title:x.title,offset});
  }
  // Keep the first source for older clients; new clients use the complete list.
  return {episodeId:String(data.episodeId),source:sources[0]||null,sources,offset:data.offset,revision:data.revision};
}

export function dandanConfigured(env){return Boolean(env.DANDANPLAY_APP_ID&&env.DANDANPLAY_APP_SECRET);}
export async function dandanHeaders(env,path,timestamp=Math.floor(Date.now()/1000)){
  if(!dandanConfigured(env))throw new PlaybackError('彈彈play 尚未完成後端配置。',503);
  const stamp=String(timestamp);
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.DANDANPLAY_APP_ID+stamp+path+env.DANDANPLAY_APP_SECRET));
  return {'X-AppId':env.DANDANPLAY_APP_ID,'X-Timestamp':stamp,'X-Signature':btoa(String.fromCharCode(...new Uint8Array(hash)))};
}
async function dandanRequest(path,query,env,comments=false){
  const headers=await dandanHeaders(env,path);
  const data=await dmFetch('https://api.dandanplay.net'+path+query,false,headers,comments);
  if(data?.success===false)throw new PlaybackError('彈彈play 未能提供資料，請稍後重試。',502);
  return data;
}
async function searchDandanplay(q,env){
  if(!dandanConfigured(env))throw new PlaybackError('彈彈play 尚未完成後端配置。',503);
  return dmCached('dandan-search:'+env.DANDANPLAY_APP_ID+':'+q,async()=>{
    const data=await dandanRequest('/api/v2/search/anime','?keyword='+encodeURIComponent(q.trim()),env);
    if(!Array.isArray(data.animes))throw new PlaybackError('彈彈play 搜尋格式無效。',502);
    return {results:data.animes.filter(x=>dmNumber(x.animeId)).slice(0,30).map(x=>({provider:'dandanplay',title:dmTitle(x.animeTitle),year:String(x.startDate||'').slice(0,4),date:monthOf(x.startDate),url:'https://api.dandanplay.net/api/v2/bangumi/'+x.animeId}))};
  },7200);
}
function dandanDetails(data){
  const b=data.bangumi;
  if(!b||!dmNumber(b.animeId)||!Array.isArray(b.episodes))throw new PlaybackError('彈彈play 未提供集數資料。',502);
  return {title:dmTitle(b.animeTitle),aliases:(b.titles||[]).map(x=>dmTitle(x.title)),bangumiUrl:b.bangumiUrl,
    episodes:b.episodes.filter(x=>dmNumber(x.episodeId)).slice(0,1000).map(x=>({provider:'dandanplay',id:String(x.episodeId),label:String(x.episodeNumber||''),title:dmTitle(b.animeTitle)+' · '+dmTitle(x.episodeTitle),url:'https://api.dandanplay.net/api/v2/bangumi/'+b.animeId+'?episodeId='+x.episodeId}))};
}
async function resolveDandanplay(source,env){
  if(!dandanConfigured(env))throw new PlaybackError('彈彈play 尚未完成後端配置。',503);
  return dmCached('dandan-resolve:'+env.DANDANPLAY_APP_ID+':'+source.animeId,async()=>dandanDetails(await dandanRequest('/api/v2/bangumi/'+source.animeId,'',env)),7200);
}
export async function matchDandanplay(bgmId,episodeNumber,env){
  if(!dmNumber(bgmId)||!/^\d+(?:\.\d+)?$/.test(episodeNumber||''))throw new PlaybackError('配對資料無效。',400);
  if(!dandanConfigured(env))throw new PlaybackError('彈彈play 尚未完成後端配置。',503);
  const d=await dmCached('dandan-bgm:'+env.DANDANPLAY_APP_ID+':'+bgmId,async()=>dandanDetails(await dandanRequest('/api/v2/bangumi/bgmtv/'+bgmId,'',env)),7200);
  // An explicit cross-database identity avoids guessing translations or seasons.
  let u;try{u=new URL(d.bangumiUrl);}catch{}
  if(!u||!['bgm.tv','bangumi.tv','chii.in'].includes(u.hostname)||u.pathname!=='/subject/'+bgmId)return {sources:[]};
  const eps=pickEpisodes(d.episodes,episodeNumber);
  return {sources:eps.length===1?eps:[]};
}
export function decodeDandanplay(data){
  if(!Array.isArray(data?.comments))throw new PlaybackError('彈彈play 彈幕格式無效。',502);
  return normalizeDanmaku(data.comments.map(x=>{const p=String(x.p||'').split(',');const color=Number(p[2]);return {time:p[0]?.trim()?Number(p[0]):NaN,mode:Number(p[1]),color:Number.isInteger(color)&&color>=0&&color<=0xffffff?'#'+color.toString(16).padStart(6,'0'):'#ffffff',text:x.m};}));
}
async function dandanComments(id,env){
  if(!dandanConfigured(env))throw new PlaybackError('彈彈play 尚未完成後端配置。',503);
  return dmCached('dandan-comments:'+env.DANDANPLAY_APP_ID+':'+id,async()=>({provider:'dandanplay',id,segment:1,includesRelated:true,comments:decodeDandanplay(await dandanRequest('/api/v2/comment/'+id,'?withRelated=true&chConvert=0',env,true))}),3600);
}


// Cache series identity, never episode-number guesses. Manual settings remain authoritative.
export async function fallbackDanmaku(item,provider,episode,env={}){
  if(!['bahamut','dandanplay'].includes(provider)||!/^\d+(?:\.\d+)?$/.test(episode||''))throw new PlaybackError('配對資料無效。',400);
  const diagnostic={scope:'danmaku',seriesId:item.id,provider};
  if(!matcherConfigured(env)){titleMatchLog('configuration',{...diagnostic,reason:'missing_secret'});return {sources:[]};}
  const identity=await titleMatchCached('danmaku:'+JSON.stringify([provider,item.id,item.title,item.year]),async()=>{
    const found=new Map(),keys=[item.title,...(item.aliases||[])].map(matchTitleKey);let failure;
    // A failing query (often the long full title) must not hide the shorter one that finds the show.
    for(const query of titleQueries(item.title)){
      try{const data=await searchDanmaku(query,provider,env);for(const x of data.results)found.set(x.url,x);}
      catch(error){failure=error;titleMatchLog('search',{...diagnostic,reason:'candidate_error'});}
      // Broader variants only widen recall; stop once a same-year exact title is already present.
      if([...found.values()].some(x=>itemYears(item).includes(x.year)&&keys.includes(matchTitleKey(x.title))))break;
    }
    if(!found.size&&failure)throw failure;
    // Rank by title similarity first: a short query (e.g. the series root) returns many unrelated hits.
    const names=[item.title,...(item.aliases||[])];
    const ranked=[...found.values()].map(x=>[x,Math.max(...names.map(n=>titleSimilarity(n,x.title)))]).sort((a,b)=>b[1]-a[1]).map(x=>x[0]);
    const candidates=ranked.filter(x=>x.year).slice(0,20);
    // Undated rows need a detail request. Resolve only a bounded shortlist for year validation.
    const shortlist=ranked.filter(x=>!x.year).slice(0,6);let cursor=0;
    await Promise.all(Array.from({length:Math.min(3,shortlist.length)},async()=>{while(cursor<shortlist.length){const x=shortlist[cursor++];
      try{const d=await resolveDanmaku(x.url,env);candidates.push({...x,year:d.year,date:d.date,aliases:d.aliases||[]});}catch{titleMatchLog('search',{...diagnostic,reason:'candidate_error'});}
    }}));
    const selected=await chooseTitle(item,candidates,env,diagnostic);
    return selected?{url:selected.url}:null;
  },true,diagnostic);
  if(!identity)return {sources:[]};
  const detail=await resolveDanmaku(identity.url,env);
  const episodes=pickEpisodes(detail.episodes,episode);
  titleMatchLog('episode',{...diagnostic,episodeMatches:episodes.length,result:episodes.length===1?'matched':'unmatched',reason:episodes.length===1?'selected':episodes.length?'episode_ambiguous':'episode_missing'});
  return {sources:episodes.length===1?episodes:[]};
}

