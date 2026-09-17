import { chooseTitle, titleQueries, titleMatchCached, titleMatchLog } from './title-match.js';
import { CATALOG_SEED } from './catalog-data.js';
import { PlaybackError, plainText, listSeriesEpisodes } from './adapter.js';

const CATALOG_UA = 'SamsungAnime1/1.1 (https://github.com/owen800q/Samsung-anime1)';
const catalogMemory = new Map();
const catalogPending = new Map();
let catalogueSnapshot = null;
const seedById = new Map(CATALOG_SEED.entries.map(item => [item.id,item]));
const normalTitle = s => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
export const GENRES = ['奇幻','戀愛','搞笑','日常','科幻','冒險','戰鬥','懸疑','運動','音樂','治癒','機戰'];
const genreTags = ['奇幻','恋爱','搞笑','日常','科幻','冒险','战斗','悬疑','运动','音乐','治愈','机战'];

async function catalogueJSON(url, init = {}, ttl = 3600) {
  const key = url + (init.body || '');
  const known = catalogMemory.get(key);
  if (known && known.expires > Date.now()) return known.data;
  if (catalogPending.has(key)) return catalogPending.get(key);
  if (catalogPending.size >= 32) throw new PlaybackError('資料服務繁忙，請稍後重試。',429);
  const promise = (async () => {
    const cache = globalThis.caches?.default;
    const cacheKey = new Request('https://samsung-anime1-cache.invalid/json?key=' + encodeURIComponent(key));
    let data;
    const cached = await cache?.match(cacheKey).catch(()=>null);
    if (cached) data = await cached.json();
    else {
      const response = await fetch(url,{...init,redirect:'manual',headers:{'User-Agent':CATALOG_UA,...init.headers},signal:init.signal||AbortSignal.timeout(20000)});
      if(!response.ok) throw new PlaybackError('動畫資料服務暫時無法使用（'+response.status+'）。',502);
      const reader=response.body.getReader();const chunks=[];let length=0;
      try { for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>3000000){await reader.cancel();throw new Error('Catalogue response too large');}chunks.push(value);} } finally {reader.releaseLock();}
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      data=JSON.parse(new TextDecoder().decode(bytes));
      await cache?.put(cacheKey,Response.json(data,{headers:{'Cache-Control':'public, max-age='+ttl}})).catch(()=>{});
    }
    while(catalogMemory.size>=300)catalogMemory.delete(catalogMemory.keys().next().value);
    catalogMemory.set(key,{data,expires:Date.now()+ttl*1000});
    return data;
  })().finally(()=>catalogPending.delete(key));
  catalogPending.set(key,promise);return promise;
}
export async function catalogueIndex() {
  if(catalogueSnapshot && catalogueSnapshot.expires > Date.now())return catalogueSnapshot.value;
  try {
    const rows=await catalogueJSON('https://anime1.me/animelist.json',{},300);
    if(!Array.isArray(rows)||rows.length<10)throw new Error('Unexpected source catalogue');
    const items=rows.filter(r=>Array.isArray(r)&&Number.isInteger(r[0])&&r[0]>0&&typeof r[1]==='string').map(r=>{
      const seed=seedById.get(r[0]);const match=seed&&normalTitle(seed.title)===normalTitle(r[1])?seed:null;
      return {id:r[0],title:plainText(r[1]),episodes:plainText(String(r[2]||'')),year:String(r[3]||''),season:String(r[4]||''),bgmId:match?.bgmId||null,format:String(r[2]).includes('劇場版')?'movie':match?.format||(/^(OVA|SP)/.test(String(r[2]))?'ova':'unknown'),aliases:match?.aliases||[]};
    });
    const value={items,stale:false};catalogueSnapshot={value,expires:Date.now()+300000};return value;
  } catch {const value={items:CATALOG_SEED.entries,stale:true};catalogueSnapshot={value,expires:Date.now()+30000};return value;}
}
function publicItem(item) {const {aliases,...rest}=item;return rest;}
function metadata(subject, sourceId) {
  if(subject?.type!==2) return null;
  const image=subject.images?.common||subject.images?.medium||subject.images?.large;
  let safeImage=null;
  try {const u=new URL(image);if(u.protocol==='https:'&&u.hostname==='lain.bgm.tv'&&!u.port&&!u.username&&!u.password&&/^\/(?:r\/\d+\/)?pic\/cover\/[a-z]\/[a-zA-Z0-9_./-]+\.(?:jpg|png|webp)$/.test(u.pathname)&&!u.search&&!u.hash)safeImage=u.href;}catch{}
  return {id:sourceId,bgmId:subject.id,name:subject.name_cn||subject.name,summary:plainText(subject.summary||''),score:subject.rating?.total>0?subject.rating.score:null,ratingCount:subject.rating?.total||0,rank:Number.isInteger(subject.rating?.rank)&&subject.rating.rank>0?subject.rating.rank:null,tags:(subject.tags||[]).slice(0,8).map(t=>plainText(t.name)),cover:safeImage?'/api/cover?id='+sourceId:null,image:safeImage,bangumiUrl:'https://bgm.tv/subject/'+subject.id};
}
async function subjectMetadata(item) {
  item = await resolveCatalogueTitle(item);
  if(!item.bgmId)return null;
  return metadata(await catalogueJSON('https://api.bgm.tv/v0/subjects/'+item.bgmId,{},86400),item.id);
}
export async function browseCatalogue(params) {
  const {items,stale}=await catalogueIndex();
  const q=(params.get('q')||'').trim();const year=params.get('year')||'';const season=params.get('season')||'';const format=params.get('format')||'';const state=params.get('state')||'';const genre=params.get('genre')||'';const sort=params.get('sort')||'';
  const page=Number(params.get('page')||1);
  if(q.length>80||!Number.isInteger(page)||page<1||page>200||year&&!/^\d{4}$/.test(year)||season&&!['冬','春','夏','秋'].includes(season)||format&&!['tv','movie','ova','web','unknown'].includes(format)||state&&!['airing','complete'].includes(state)||genre&&!GENRES.includes(genre)||sort&&!['heat','rank'].includes(sort))throw new PlaybackError('目錄篩選條件無效。',400);
  const filtered=items.filter(x=>(!q||[x.title,...x.aliases].some(t=>normalTitle(t).includes(normalTitle(q))))&&(!year||x.year===year)&&(!season||x.season===season)&&(!format||x.format===format)&&(!state||(state==='airing'?x.episodes.includes('連載中'):!x.episodes.includes('連載中'))));
  const years=[...new Set(items.map(x=>x.year).filter(x=>/^\d{4}$/.test(x)))].sort().reverse();
  // Genre and ranking views walk Bangumi's search index (heat or rank order) and keep only titles Anime1 carries.
  if(genre||sort){
    const order=sort||'heat';
    const filter={type:[2],nsfw:false};
    if(genre)filter.tag=[genreTags[GENRES.indexOf(genre)]];
    if(order==='rank')filter.rank=['>0'];
    // Narrow Bangumi to the years the source catalogue covers so ranked pages are not filled with titles Anime1 lacks.
    const floor=years[years.length-1];
    if(year)filter.air_date=['>='+year+'-01-01','<'+(Number(year)+1)+'-01-01'];else if(floor)filter.air_date=['>='+floor+'-01-01'];
    const byBgm=new Map();for(const item of filtered){if(!byBgm.has(item.bgmId))byBgm.set(item.bgmId,[]);byBgm.get(item.bgmId).push(item);}
    // Bangumi serves at most 20 rows per search page and only a fraction of them have a source here,
    // so each catalogue page scans ahead (bounded) until it has a screenful; `page` stays a Bangumi page number.
    const size=20,matches=[];let next=page,more=true;
    for(let scanned=0;scanned<5&&more&&matches.length<12;scanned++,next++){
      const offset=(next-1)*size;
      const result=await catalogueJSON('https://api.bgm.tv/v0/search/subjects?limit='+size+'&offset='+offset,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyword:'',sort:order,filter})},3600);
      if(!Array.isArray(result.data))throw new PlaybackError(genre?'題材分類暫時無法讀取。':'排行榜暫時無法讀取。');
      matches.push(...result.data.flatMap(subject=>(byBgm.get(subject.id)||[]).map(item=>{const detail=metadata(subject,item.id);if(detail)delete detail.image;return {...publicItem(item),metadata:detail};})));
      more=result.data.length>0&&next<200&&(result.total==null||offset+result.data.length<result.total);
    }
    return {items:matches,years,genres:GENRES,total:null,nextPage:more?next:null,stale,genre:Boolean(genre),sort:order};
  }
  return {items:filtered.slice((page-1)*24,page*24).map(publicItem),years,genres:GENRES,total:filtered.length,nextPage:page*24<filtered.length?page+1:null,stale,genre:false,sort:null};
}
export async function catalogueMetadata(ids) {
  if(!/^\d+(?:,\d+){0,7}$/.test(ids||''))throw new PlaybackError('動畫資料編號無效。',400);
  const {items}=await catalogueIndex();const byId=new Map(items.map(x=>[x.id,x]));
  const requested=[...new Set(ids.split(',').map(Number))];const details={};let cursor=0;
  await Promise.all(Array.from({length:Math.min(3,requested.length)},async()=>{while(cursor<requested.length){const id=requested[cursor++];try{const item=byId.get(id);const data=item?await subjectMetadata(item):null;if(data)delete data.image;details[id]=data;}catch{details[id]=null;}}}));
  return {details};
}
export async function catalogueSeries(id, page) {
  if(!/^\d{1,10}$/.test(id||''))throw new PlaybackError('動畫編號無效。',400);
  const {items}=await catalogueIndex();const item=items.find(x=>x.id===Number(id));
  if(!item)throw new PlaybackError('Anime1 目錄沒有這套動畫。',404);
  return listSeriesEpisodes(item.id,item.title,page);
}
export async function catalogueItem(id, env = {}) {
  if(!/^\d{1,10}$/.test(id||''))throw new PlaybackError('動畫編號無效。',400);
  const {items}=await catalogueIndex();const item=items.find(x=>x.id===Number(id));
  if(!item)throw new PlaybackError('目錄找不到這套動畫。',404);
  const resolved=await resolveCatalogueTitle(item,env);
  return {item:{...publicItem(resolved),aliases:resolved.aliases||[]}};
}
// Bangumi's website API exposes public short comments (the v0 API does not).
// Keep this separate from metadata/episodes so an upstream outage cannot block playback.
export async function catalogueComments(id, page = 1, env = {}) {
  if(!Number.isInteger(page)||page<1||page>500)throw new PlaybackError('評論頁碼無效。',400);
  const {item}=await catalogueItem(id,env);
  if(!item.bgmId)return {comments:[],total:0,page,nextPage:null,bangumiUrl:null,matched:false};
  const limit=20,offset=(page-1)*limit;
  const bangumiUrl='https://bgm.tv/subject/'+item.bgmId+'/comments';
  let data;
  try {
    data=await catalogueJSON('https://next.bgm.tv/p1/subjects/'+item.bgmId+'/comments?limit='+limit+'&offset='+offset,{},300);
    if(!Array.isArray(data?.data)||!Number.isSafeInteger(data.total)||data.total<0)throw new Error('Invalid comments response');
  } catch {throw new PlaybackError('Bangumi 評論暫時無法讀取，請稍後重試。',502);}
  const comments=data.data.slice(0,limit).filter(c=>c&&typeof c.comment==='string'&&c.comment.trim()).map(c=>({
    id:Number.isSafeInteger(c.id)?c.id:null,
    author:typeof c.user?.nickname==='string'&&c.user.nickname.trim()?c.user.nickname.slice(0,100):'Bangumi 用戶',
    text:c.comment.slice(0,10000),
    rating:Number.isInteger(c.rate)&&c.rate>=1&&c.rate<=10?c.rate:null,
    updatedAt:Number.isSafeInteger(c.updatedAt)&&c.updatedAt>0&&c.updatedAt<=8640000000000?c.updatedAt:null,
  }));
  // Offset follows upstream pagination, including rows omitted for deleted users.
  return {comments,total:data.total,page,nextPage:offset+limit<data.total&&page<500?page+1:null,bangumiUrl,matched:true};
}
export async function catalogueCover(id) {
  if(!/^\d{1,10}$/.test(id||''))throw new PlaybackError('封面編號無效。',400);
  const cache=globalThis.caches?.default;const key=new Request('https://samsung-anime1-cache.invalid/cover/'+id);
  const cached=await cache?.match(key).catch(()=>null);if(cached)return cached;
  const {items}=await catalogueIndex();const item=items.find(x=>x.id===Number(id));const detail=item?await subjectMetadata(item):null;
  if(!detail?.image)return new Response(null,{status:404});
  const response=await fetch(detail.image,{headers:{'User-Agent':CATALOG_UA},redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(!response.ok||!/^image\/(?:jpeg|png|webp)(?:;|$)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();return new Response(null,{status:502});}
  const reader=response.body.getReader();const chunks=[];let length=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>4000000){await reader.cancel();return new Response(null,{status:502});}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const output=new Response(bytes,{headers:{'Content-Type':response.headers.get('content-type'),'Cache-Control':'public, max-age=86400','X-Content-Type-Options':'nosniff'}});
  await cache?.put(key,output.clone()).catch(()=>{});return output;
}


const resolvedCatalogueTitles = new Map();
async function resolveCatalogueTitle(item, env = {}) {
  if(item.bgmId)return item;
  const diagnostic={scope:'bangumi',seriesId:item.id};
  if(env.ASSETS&&!env.TITLE_MATCH_LLM_API_KEY)titleMatchLog('configuration',{...diagnostic,reason:'missing_secret'});
  const key=JSON.stringify([item.id,item.title,item.year]);
  const known=resolvedCatalogueTitles.get(key);
  if(known && known.expires>Date.now())return {...item,...known.value};
  const value=await titleMatchCached('bangumi:'+key,async()=>{
    const candidates=new Map();let failure;
    // A failing query (often the long full title) must not hide the shorter one that finds the show.
    for(const query of titleQueries(item.title)){
      let result;
      try{result=await catalogueJSON('https://api.bgm.tv/v0/search/subjects?limit=20',{method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json'},body:JSON.stringify({keyword:query,filter:{type:[2],nsfw:false}})},3600);}
      catch(error){failure=error;titleMatchLog('search',{...diagnostic,reason:'candidate_error'});continue;}
      for(const x of result.data||[])if(x.type===2&&Number.isSafeInteger(x.id))candidates.set(x.id,{id:x.id,title:x.name_cn||x.name,aliases:[x.name,x.name_cn].filter(Boolean),year:String(x.date||'').slice(0,4)});
      if([...candidates.values()].some(x=>x.year===String(item.year)&&[x.title,...x.aliases].some(n=>normalTitle(n)===normalTitle(item.title))))break;
    }
    if(!candidates.size&&failure)throw failure;
    const selected=await chooseTitle(item,[...candidates.values()],env,diagnostic);
    return selected?{bgmId:selected.id,aliases:[...new Set([...(item.aliases||[]),selected.title,...selected.aliases])]}:null;
  },Boolean(env.TITLE_MATCH_LLM_API_KEY),diagnostic);
  if(value){while(resolvedCatalogueTitles.size>=300)resolvedCatalogueTitles.delete(resolvedCatalogueTitles.keys().next().value);resolvedCatalogueTitles.set(key,{value,expires:Date.now()+3600000});}
  return value?{...item,...value}:item;
}
