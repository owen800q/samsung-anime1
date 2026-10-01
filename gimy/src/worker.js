import {PlaybackError,resolveEpisode,listEpisodes,browseCatalogue,streamMedia,errorResponse} from './adapter.js';
import {historyRoute,WatchHistory} from './sync-server.js';
import {pairingRoute} from './pairing-server.js';
import {remoteRoute} from './remote-server.js';
import {searchDanmaku,resolveDanmaku,getDanmaku,dandanConfigured} from './danmaku-server.js';
export {WatchHistory};
async function body(request){
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new PlaybackError('請使用 JSON 請求。',415);
  const reader=request.body?.getReader();if(!reader)throw new PlaybackError('請提供影片網址。',400);
  let size=0,text='';const decoder=new TextDecoder();
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();throw new PlaybackError('請求內容過長。',413);}text+=decoder.decode(value,{stream:true});}}
  finally{reader.releaseLock();}
  try{return JSON.parse(text+decoder.decode());}catch{throw new PlaybackError('資料格式無效。',400);}
}
const json=data=>Response.json(data,{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export default {async fetch(request,env){
  const url=new URL(request.url);if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
  try{
    const origin=request.headers.get('origin');if(origin&&origin!==url.origin||request.headers.get('sec-fetch-site')==='cross-site')throw new PlaybackError('請從播放器網頁開啟。',403);
    if(url.pathname.startsWith('/api/pairing/'))return await pairingRoute(request,env);
    if(url.pathname.startsWith('/api/remote/'))return await remoteRoute(request,env);
    if(['/api/history','/api/danmaku/settings'].includes(url.pathname))return await historyRoute(request,env);
    if(request.method==='POST'&&url.pathname==='/api/resolve'){const data=await body(request);return json(await resolveEpisode(data?.url,data?.refresh===true,env));}
    if(['GET','HEAD'].includes(request.method)&&url.pathname==='/api/media')return await streamMedia(request,env);
    if(request.method==='GET'){
      if(url.pathname==='/api/health')return json({service:'gimy-tv',version:'0.1.0',history:!!env.WATCH_HISTORY,streamConfigured:!!env.GIMY_STREAM_SECRET&&!!env.GIMY_MEDIA_HOSTS});
      if(url.pathname==='/api/catalog')return json(await browseCatalogue(url.searchParams));
      if(url.pathname==='/api/episodes')return json(await listEpisodes(url.searchParams.get('url')));
      if(url.pathname==='/api/danmaku/providers')return json({dandanplay:dandanConfigured(env)});
      if(url.pathname==='/api/danmaku/search')return json(await searchDanmaku(url.searchParams.get('q'),url.searchParams.get('provider')||'bahamut',env));
      if(url.pathname==='/api/danmaku/resolve')return json(await resolveDanmaku(url.searchParams.get('url'),env));
      if(url.pathname==='/api/danmaku/comments')return json(await getDanmaku(url.searchParams.get('provider'),url.searchParams.get('id'),Number(url.searchParams.get('segment')||1),env));
    }
    return Response.json({error:'找不到此功能。'},{status:404});
  }catch(error){return errorResponse(error);}
}};
