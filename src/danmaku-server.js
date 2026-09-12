import { PlaybackError } from './adapter.js';

const DM_UA='SamsungAnime1/1.2 (https://github.com/owen800q/Samsung-anime1)';
const DM_LIMIT=20000;
const dmNumber=s=>/^[1-9]\d{0,14}$/.test(String(s||''));
const dmTitle=s=>String(s||'').replace(/<[^>]*>/g,'').slice(0,250);
// Only construct requests to these fixed endpoints, never fetch an input URL.
export function parseDanmakuSource(input){
  if(typeof input!=='string'||input.length>500)throw new PlaybackError('請輸入巴哈動畫瘋或 Bilibili 完整網址。',400);
  if(/^BV[0-9A-Za-z]{10}$/.test(input))input='https://www.bilibili.com/video/'+input;
  let u;try{u=new URL(input);}catch{throw new PlaybackError('來源網址無效。',400);}
  if(u.protocol!=='https:'||u.port||u.username||u.password)throw new PlaybackError('來源網址無效。',400);
  if(u.hostname==='ani.gamer.com.tw'&&u.pathname==='/animeVideo.php'&&dmNumber(u.searchParams.get('sn'))){
    const id=u.searchParams.get('sn');return {provider:'bahamut',id,url:'https://ani.gamer.com.tw/animeVideo.php?sn='+id};
  }
  if(['www.bilibili.com','m.bilibili.com','bilibili.com'].includes(u.hostname)){
    const bv=u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/);
    const pgc=u.pathname.match(/^\/bangumi\/play\/(ep|ss)([1-9]\d{0,14})\/?$/);
    if(bv){const p=u.searchParams.get('p')||'1';if(!/^[1-9]\d{0,2}$/.test(p))throw new PlaybackError('分 P 編號無效。',400);return {provider:'bilibili',kind:'bv',id:bv[1],page:Number(p),url:'https://www.bilibili.com/video/'+bv[1]+'?p='+p};}
    if(pgc)return {provider:'bilibili',kind:pgc[1],id:pgc[2],url:'https://www.bilibili.com/bangumi/play/'+pgc[1]+pgc[2]};
  }
  throw new PlaybackError('支援動畫瘋單集網址、Bilibili BV／ep／ss 網址；請使用完整網址。',400);
}

async function dmFetch(url,binary=false){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
  let reader;
  try{
    const r=await fetch(url,{headers:{'User-Agent':DM_UA,Accept:binary?'application/octet-stream':'application/json'},redirect:'manual',signal:controller.signal});
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
async function dmCached(key,load){
  const cache=globalThis.caches?.default;const request=new Request('https://samsung-anime1-cache.invalid/danmaku/v1/'+encodeURIComponent(key));
  const hit=await cache?.match(request);if(hit)return hit.json();
  const data=await load();await cache?.put(request,Response.json(data,{headers:{'Cache-Control':'public,max-age=600'}})).catch(()=>{});return data;
}
export async function searchDanmaku(q){
  if(typeof q!=='string'||!q.trim()||q.length>100)throw new PlaybackError('請輸入動畫名稱（最多 100 字）。',400);
  return dmCached('search:'+q,async()=>{
    const data=await dmFetch('https://api.gamer.com.tw/mobile_app/anime/v1/search.php?kw='+encodeURIComponent(q.trim()));
    if(!Array.isArray(data.anime))throw new PlaybackError('動畫瘋搜尋暫時無法使用。',502);
    return {results:data.anime.filter(x=>dmNumber(x.video_sn)).slice(0,30).map(x=>({title:dmTitle(x.title),url:'https://ani.gamer.com.tw/animeVideo.php?sn='+x.video_sn,provider:'bahamut'}))};
  });
}
export async function resolveDanmaku(input){
  const source=parseDanmakuSource(input);
  return dmCached('resolve:'+source.url,async()=>{
    if(source.provider==='bahamut'){
      const data=await dmFetch('https://api.gamer.com.tw/anime/v1/video.php?videoSn='+source.id);
      const anime=data.data?.anime;const video=data.data?.video;
      if(!anime||!video)throw new PlaybackError('動畫瘋找不到本集資料。',502);
      const groups=anime.episodes||{};
      const eps=(Array.isArray(groups)?groups:Object.values(groups).flat()).filter(x=>dmNumber(x.videoSn));
      const unique=new Map(eps.map(x=>[String(x.videoSn),x]));
      if(!unique.size)throw new PlaybackError('動畫瘋未提供集數列表。',502);
      return {title:dmTitle(anime.title),year:String(anime.seasonStart||'').slice(0,4),episodes:[...unique.values()].slice(0,1000).map(x=>({provider:'bahamut',id:String(x.videoSn),label:String(x.episode).slice(0,80),title:dmTitle(anime.title)+' ['+String(x.episode).slice(0,80)+']',url:'https://ani.gamer.com.tw/animeVideo.php?sn='+x.videoSn,selected:String(x.videoSn)===source.id}))};
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
export async function getDanmaku(provider,id,segment=1){
  if(!['bahamut','bilibili'].includes(provider)||!dmNumber(id)||!Number.isInteger(segment)||segment<1||segment>240)throw new PlaybackError('彈幕來源或分段編號無效。',400);
  return dmCached(provider+':'+id+':'+(provider==='bahamut'?1:segment),async()=>{
    let comments;
    if(provider==='bahamut'){
      const data=await dmFetch('https://api.gamer.com.tw/anime/v1/danmu.php?videoSn='+id);
      if(!Array.isArray(data.data?.danmu))throw new PlaybackError('動畫瘋彈幕格式無效。',502);
      comments=normalizeDanmaku(data.data.danmu.map(x=>({time:Number(x.time)/10,mode:({0:1,1:5,2:4})[x.position],color:x.color,text:x.text})));
    }else{
      const bytes=await dmFetch('https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid='+id+'&segment_index='+segment,true);
      try{comments=decodeBilibili(bytes);}catch{throw new PlaybackError('Bilibili 彈幕格式無效。',502);}
    }
    return {provider,id,segment:provider==='bahamut'?1:segment,comments};
  });
}

export function validDanmakuSetting(data){
  if(!data||!/^\d{1,10}$/.test(String(data.episodeId))||!Number.isInteger(data.revision)||data.revision<0||!Number.isFinite(data.offset)||Math.abs(data.offset)>300)return null;
  let source=null;
  if(data.source!==null){
    const x=data.source;
    if(!x||!['bahamut','bilibili'].includes(x.provider)||!dmNumber(x.id)||typeof x.title!=='string'||x.title.length>300)return null;
    let url;try{url=parseDanmakuSource(x.url);}catch{return null;}
    if(url.provider!==x.provider||x.provider==='bahamut'&&url.id!==String(x.id)||url.kind==='ss')return null;
    source={provider:x.provider,id:String(x.id),url:url.url,title:x.title};
  }
  return {episodeId:String(data.episodeId),source,offset:data.offset,revision:data.revision};
}
