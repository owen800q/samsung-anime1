// Parse public HTML as data. Never execute source scripts or embed third-party frames.
export class PlaybackError extends Error {
  constructor(message, status = 502, code = 'UPSTREAM_ERROR') { super(message); this.status = status; this.code = code; }
}
export const SOURCE_ORIGIN = 'https://gimytv.io';
export const EPISODE_ID = /^\d{1,10}(?:-[a-zA-Z0-9_-]{1,100})?$/;
const episodePath = /^\/eps\/(\d{1,10}(?:-[a-zA-Z0-9_-]{1,100})?)\.html$/;
const detailPath = /^\/(?:vod|voddetail|detail|video|series|movies|dramas)\/(\d{1,10})(?:\.html)?\/?$/;
const decoder = new TextDecoder();
export function episodeUrl(input) {
  if (typeof input !== 'string' || input.length > 300) throw new PlaybackError('請貼上 Gimy 單集網址。', 400, 'INVALID_URL');
  let u; try { u = new URL(input.trim()); } catch { throw new PlaybackError('網址格式不正確。', 400, 'INVALID_URL'); }
  if (u.origin !== SOURCE_ORIGIN || u.username || u.password || u.search || u.hash || !episodePath.test(u.pathname)) throw new PlaybackError('只支援 https://gimytv.io/eps/ 開頭的單集頁面。', 400, 'INVALID_URL');
  return u.href;
}
export const idFromUrl = input => new URL(episodeUrl(input)).pathname.match(episodePath)[1];
export function plainText(html) {
  const names = {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '};
  return String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,'').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(all,e)=>{
    if(e[0]!=='#')return names[e.toLowerCase()]??all;
    const n=e[1]?.toLowerCase()==='x'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);
    return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';
  }).replace(/\s+/g,' ').trim().slice(0,350);
}
export async function boundedText(response,max=2000000,signal) {
  const reader=response.body?.getReader();if(!reader)return '';
  const chunks=[];let size=0,expired=false;
  const cancel=()=>{expired=true;void reader.cancel().catch(()=>{});};
  const timer=setTimeout(cancel,20000);signal?.addEventListener('abort',cancel,{once:true});
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new PlaybackError('原站回應過大。',502,'RESPONSE_TOO_LARGE');}chunks.push(value);}}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reader.releaseLock();}
  if(expired)throw new PlaybackError('原站回應逾時。',504,'UPSTREAM_TIMEOUT');
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return decoder.decode(bytes);
}
export async function sourceHTML(url) {
  const u=new URL(url);
  if(u.origin!==SOURCE_ORIGIN||u.username||u.password)throw new PlaybackError('來源網址無效。',400,'INVALID_URL');
  let response;try{response=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Accept:'text/html','User-Agent':'Mozilla/5.0 GimyTV/1.0'}});}catch{throw new PlaybackError('原站連線逾時，請稍後重試。',504,'UPSTREAM_TIMEOUT');}
  const html=await boundedText(response);
  if([403,429,503].includes(response.status)||/Attention Required!|cf-chl-|challenge-platform|Sorry, you have been blocked/i.test(html))throw new PlaybackError('Gimy 拒絕了伺服器連線或要求驗證。請稍後重試；目前未能取得片源。',502,'SOURCE_BLOCKED');
  if(!response.ok)throw new PlaybackError('讀取 Gimy 失敗（HTTP '+response.status+'）。',502,'UPSTREAM_HTTP');
  return html;
}
function anchors(html){return [...html.matchAll(/<a\b([^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi)].map(m=>({href:plainText(m[2]),text:plainText(m[3]),title:plainText(m[1].match(/\btitle\s*=\s*["']([^"']+)["']/i)?.[1]||'')}));}
function titleOf(html){return plainText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'Gimy 影片').replace(/\s*[-–|_]\s*(?:Gimy|劇迷).*$/i,'');}
export function parseEpisodes(html,pageUrl){
  const parsed=new URL(pageUrl),current=parsed.pathname.match(episodePath)?.[1],seriesId=current?.split('-')[0]||parsed.pathname.match(detailPath)?.[1],rows=new Map();
  if(!seriesId)throw new PlaybackError('集數頁面網址無效。',400,'INVALID_URL');
  for(const link of anchors(html)){try{const url=episodeUrl(new URL(link.href,pageUrl).href),id=idFromUrl(url);if(id.split('-')[0]!==seriesId)continue;rows.set(url,{url,title:link.title||link.text||id,label:link.text||id});}catch{}}
  if(current&&!rows.has(pageUrl))rows.set(pageUrl,{url:pageUrl,title:titleOf(html)});
  return {title:titleOf(html),seriesId,episodes:[...rows.values()],nextPage:null};
}
// Extract only JSON objects; braces inside quoted strings are preserved. No eval/Function.
function jsonObject(text,start){
  let depth=0,string=false,escape=false;
  for(let i=start;i<text.length&&i<start+65536;i++){const ch=text[i];if(string){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')string=false;}else if(ch==='"')string=true;else if(ch==='{')depth++;else if(ch==='}'&&!--depth){try{return JSON.parse(text.slice(start,i+1));}catch{return null;}}}return null;
}
export function parsePlayer(html,pageUrl){
  const candidates=[];
  for(const match of html.matchAll(/\b(?:var\s+)?player_[a-zA-Z0-9_]+\s*=\s*(?=\{)/g)){const data=jsonObject(html,match.index+match[0].length);if(!data||typeof data.url!=='string')continue;
    let value=data.url;try{if(Number(data.encrypt)===1)value=decodeURIComponent(value);else if(Number(data.encrypt)===2){value=atob(value);try{value=decodeURIComponent(value);}catch{}}}catch{continue;}
    candidates.push(value);
  }
  for(const match of html.matchAll(/<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi))candidates.push(plainText(match[1]));
  for(const value of candidates){try{const url=new URL(value,pageUrl);if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&/\.(?:m3u8|mp4)$/i.test(url.pathname))return {url:url.href,type:/\.m3u8$/i.test(url.pathname)?'hls':'mp4'};}catch{}}
  throw new PlaybackError('此頁未有可直接讀取的 MP4／HLS 片源，或使用了尚未支援的播放器。',422,'UNSUPPORTED_PLAYER');
}
export function allowedMedia(input,env){
  let u;try{u=new URL(input);}catch{throw new PlaybackError('影片網址無效。',400,'INVALID_MEDIA');}
  const allowed=String(env.GIMY_MEDIA_HOSTS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!allowed.includes(u.hostname.toLowerCase())||/^(?:localhost|.*\.localhost|.*\.local)$/.test(u.hostname)||u.hostname.includes(':')||/^\d+(?:\.\d+){3}$/.test(u.hostname))throw new PlaybackError('此影片伺服器尚未加入允許清單，請完成 GIMY_MEDIA_HOSTS 設定。',503,'MEDIA_HOST_NOT_CONFIGURED');
  if(!env.GIMY_STREAM_SECRET||env.GIMY_STREAM_SECRET.length<32)throw new PlaybackError('播放服務尚未設定 GIMY_STREAM_SECRET。',503,'STREAM_NOT_CONFIGURED');
  return u;
}
const bytesTo64=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const from64=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),x=>x.charCodeAt(0));
async function key(env){return crypto.subtle.importKey('raw',new TextEncoder().encode(env.GIMY_STREAM_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function signedMedia(url,referer,env,expiry=Date.now()+2*60*60*1000){
  allowedMedia(url,env);episodeUrl(referer);
  const data=bytesTo64(new TextEncoder().encode(JSON.stringify({url,referer,expiry})));
  const signature=bytesTo64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(env),new TextEncoder().encode(data))));
  return '/api/media?token='+data+'.'+signature;
}
export async function verifyMedia(token,env){
  try{
    if(typeof token!=='string'||token.length>12000)throw 0;
    const parts=token.split('.');if(parts.length!==2||!parts.every(x=>/^[a-zA-Z0-9_-]+$/.test(x)))throw 0;
    const data=JSON.parse(decoder.decode(from64(parts[0])));allowedMedia(data.url,env);episodeUrl(data.referer);
    if(!Number.isFinite(data.expiry)||data.expiry<=Date.now()||data.expiry>Date.now()+2*60*60*1000+60000||!await crypto.subtle.verify('HMAC',await key(env),from64(parts[1]),new TextEncoder().encode(parts[0])))throw 0;
    return data;
  }catch(e){if(e instanceof PlaybackError&&e.status===503)throw e;throw new PlaybackError('影片連線已過期或無效，請重新載入。',401,'INVALID_MEDIA_TOKEN');}
}
export async function rewritePlaylist(text,base,referer,env,expiry){
  if(!text.trimStart().startsWith('#EXTM3U'))throw new PlaybackError('片源未回傳有效 HLS 播放清單。',502,'INVALID_PLAYLIST');
  const lines=[];
  for(const line of text.split(/\r?\n/)){
    if(!line.trim()||line.startsWith('#')&&!line.includes('URI="')){lines.push(line);continue;}
    if(line.startsWith('#')){let out='',at=0;for(const m of line.matchAll(/URI="([^"\r\n]+)"/g)){out+=line.slice(at,m.index)+'URI="'+await signedMedia(new URL(m[1],base).href,referer,env,expiry)+'"';at=m.index+m[0].length;}lines.push(out+line.slice(at));}
    else lines.push(await signedMedia(new URL(line.trim(),base).href,referer,env,expiry));
  }
  return lines.join('\n');
}
export async function streamMedia(request,env){
  const data=await verifyMedia(new URL(request.url).searchParams.get('token'),env);let target=allowedMedia(data.url,env).href,response;
  const headers={Referer:data.referer,Origin:SOURCE_ORIGIN,'User-Agent':'Mozilla/5.0 GimyTV/1.0'};
  const range=request.headers.get('range');if(range){if(!/^bytes=\d*-\d*$/.test(range))throw new PlaybackError('Range 無效。',416,'INVALID_RANGE');headers.Range=range;}
  try{for(let hop=0;hop<4;hop++){response=await fetch(target,{method:request.method,headers,redirect:'manual',signal:AbortSignal.timeout(20000)});if(![301,302,303,307,308].includes(response.status))break;const location=response.headers.get('location');void response.body?.cancel();if(!location||hop===3)throw new PlaybackError('片源重新導向失敗。');target=allowedMedia(new URL(location,target).href,env).href;}}
  catch(e){if(e instanceof PlaybackError)throw e;throw new PlaybackError('影片伺服器連線逾時。',504,'MEDIA_TIMEOUT');}
  if(!response.ok&&response.status!==416){void response.body?.cancel();throw new PlaybackError('影片伺服器回應 HTTP '+response.status+'。',502,'MEDIA_HTTP');}
  const type=response.headers.get('content-type')||'';
  const out=new Headers({'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'});
  if(/\.m3u8$/i.test(new URL(target).pathname)||/mpegurl/i.test(type)){
    out.set('Content-Type','application/vnd.apple.mpegurl');if(request.method==='HEAD')return new Response(null,{status:response.status,headers:out});
    return new Response(await rewritePlaylist(await boundedText(response,1000000),target,data.referer,env,data.expiry),{status:response.status,headers:out});
  }
  if(/text\/html|javascript|svg/i.test(type)){void response.body?.cancel();throw new PlaybackError('片源回傳了網頁，未能播放。',502,'INVALID_MEDIA_TYPE');}
  for(const name of ['content-type','content-length','content-range','accept-ranges','etag','last-modified'])if(response.headers.has(name))out.set(name,response.headers.get(name));
  return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers:out});
}
const pageCache=new Map();
async function episodePage(input,refresh=false){const url=episodeUrl(input),hit=pageCache.get(url);if(!refresh&&hit&&hit.expires>Date.now())return hit.html;const html=await sourceHTML(url);if(pageCache.size>=32)pageCache.delete(pageCache.keys().next().value);pageCache.set(url,{html,expires:Date.now()+60000});return html;}
export async function listEpisodes(input){
  let u;try{u=new URL(input);}catch{throw new PlaybackError('集數頁面網址無效。',400,'INVALID_URL');}
  if(u.origin!==SOURCE_ORIGIN||u.username||u.password||u.search||u.hash||!episodePath.test(u.pathname)&&!detailPath.test(u.pathname))throw new PlaybackError('集數頁面網址無效。',400,'INVALID_URL');
  return parseEpisodes(episodePath.test(u.pathname)?await episodePage(u.href):await sourceHTML(u.href),u.href);
}
export async function resolveEpisode(input,refresh,env){const url=episodeUrl(input),html=await episodePage(url,refresh),player=parsePlayer(html,url),list=parseEpisodes(html,url),at=list.episodes.findIndex(x=>x.url===url);return {url,title:titleOf(html),seriesId:list.seriesId,media:await signedMedia(player.url,url,env),type:player.type,previous:list.episodes[at-1]||null,next:list.episodes[at+1]||null};}
export function parseCatalogue(html,base=SOURCE_ORIGIN){const items=new Map();for(const a of anchors(html)){try{const url=new URL(a.href,base);if(url.origin!==SOURCE_ORIGIN||url.search||url.hash)continue;const ep=url.pathname.match(episodePath),detail=url.pathname.match(detailPath);if(!ep&&!detail)continue;const id=(ep?.[1]||detail[1]).split('-')[0],title=a.title||a.text;if(!title||title.length<2||items.has(id))continue;items.set(id,{id,title,url:url.href,episodeUrl:ep?url.href:null,bgmId:null,year:'',episodes:'開啟集數',format:'unknown'});}catch{}}return [...items.values()].slice(0,80);}
export async function browseCatalogue(params){const q=(params.get('q')||'').trim();if(q.length>80)throw new PlaybackError('搜尋最多 80 字。',400);const url=q?SOURCE_ORIGIN+'/search.html?wd='+encodeURIComponent(q):SOURCE_ORIGIN+'/';return {items:parseCatalogue(await sourceHTML(url)),nextPage:null,total:null,years:[],genres:[]};}
export const errorResponse=error=>Response.json({error:error instanceof PlaybackError?error.message:'服務暫時未能回應。',code:error instanceof PlaybackError?error.code:'INTERNAL_ERROR'},{status:error instanceof PlaybackError?error.status:500,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
