const historyHeaders={'Cache-Control':'no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff'};
const historyResponse=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:historyHeaders});
export function validProgress(data){
  if(!data||!/^\d{1,10}$/.test(String(data.episodeId))||data.seriesId!=null&&!/^\d{1,10}$/.test(String(data.seriesId))||!Number.isFinite(data.position)||data.position<0||data.position>86400||!Number.isFinite(data.duration)||data.duration<=0||data.duration>86400||data.position>data.duration+1||!Number.isInteger(data.revision)||data.revision<0||typeof data.title!=='string'||data.title.length>350||typeof data.seriesTitle!=='string'||data.seriesTitle.length>350)return null;
  return {episodeId:String(data.episodeId),seriesId:data.seriesId==null?null:String(data.seriesId),title:data.title,seriesTitle:data.seriesTitle,position:Math.min(data.position,data.duration),duration:data.duration,completed:data.completed===true,revision:data.revision};
}
// One durable object per unguessable sync profile; no public shared history.
export class WatchHistory {
  constructor(ctx){this.storage=ctx.storage;}
  async fetch(request){
    if(request.method==='GET'){
      const index=await this.storage.get('index')||[];
      const entries=[];
      for(let i=0;i<index.length;i+=128){const values=await this.storage.get(index.slice(i,i+128).map(x=>'ep:'+x.id));entries.push(...values.values());}
      return historyResponse({entries:entries.sort((a,b)=>b.updatedAt-a.updatedAt)});
    }
    if(request.method!=='PUT')return historyResponse({error:'Method not allowed'},405);
    let data;try{data=validProgress(await request.json());}catch{}
    if(!data)return historyResponse({error:'觀看進度資料無效。'},400);
    return this.storage.transaction(async tx=>{
      const key='ep:'+data.episodeId;const old=await tx.get(key);
      if((old?.revision||0)!==data.revision)return historyResponse({conflict:true,entry:old},409);
      const entry={...data,revision:data.revision+1,updatedAt:Date.now()};
      const index=(await tx.get('index')||[]).filter(x=>x.id!==entry.episodeId);
      index.unshift({id:entry.episodeId});
      for(const removed of index.splice(500))await tx.delete('ep:'+removed.id);
      await tx.put(key,entry);await tx.put('index',index);
      return historyResponse({entry});
    });
  }
}
export async function historyRoute(request,env){
  const token=request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{32})$/)?.[1];
  if(!token)return historyResponse({error:'請先設定裝置同步碼。'},401);
  if(!env.WATCH_HISTORY)return historyResponse({error:'雲端同步尚未啟用；進度仍會保存在此裝置。'},503);
  if(!['GET','PUT'].includes(request.method))return historyResponse({error:'Method not allowed'},405);
  let body;
  if(request.method==='PUT'){
    if(!request.headers.get('content-type')?.startsWith('application/json'))return historyResponse({error:'Invalid content type'},415);
    const reader=request.body?.getReader();if(!reader)return historyResponse({error:'Empty request'},400);
    const parts=[];let size=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>5000){await reader.cancel();return historyResponse({error:'Request too large'},413);}parts.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}body=bytes;
  }
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  const name=[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
  const stub=env.WATCH_HISTORY.get(env.WATCH_HISTORY.idFromName(name));
  return stub.fetch(new Request('https://history.internal/',{method:request.method,headers:{'Content-Type':'application/json'},body}));
}
