// Live check of automatic title matching against the real upstreams (Bangumi, 動畫瘋, LLM gateway).
// Usage: TITLE_MATCH_LLM_API_KEY=... node scripts/check-title-match.mjs [--since=2025] [--limit=40] [id ...]
// Without a key the LLM step is skipped and each title reports whether it matched deterministically.
import { CATALOG_SEED } from '../src/catalog-data.js';
import { catalogueItem } from '../src/catalog.js';
import { fallbackDanmaku, resolveDanmaku } from '../src/danmaku-server.js';
import { titleMatchCached } from '../src/title-match.js';

const args=process.argv.slice(2);
const opt=(name,fallback)=>args.find(x=>x.startsWith('--'+name+'='))?.split('=')[1]??fallback;
const ids=args.filter(x=>/^\d+$/.test(x)).map(Number);
const key=process.env.TITLE_MATCH_LLM_API_KEY;
const env=key?{TITLE_MATCH_LLM_API_KEY:key}:{TITLE_MATCH_LLM_API_KEY:'offline'};
const realFetch=globalThis.fetch;
if(!key)globalThis.fetch=(url,init)=>String(url).includes('/v1/chat/completions')?Promise.resolve(new Response('{}',{status:401})):realFetch(url,init);

const items=CATALOG_SEED.entries.filter(x=>ids.length?ids.includes(x.id):!x.bgmId&&x.year>=opt('since','2025')).slice(0,Number(opt('limit',40)));
let logs=[];console.info=entry=>logs.push(entry);
const how=scope=>{
  const own=logs.filter(x=>x.scope===scope);
  const pick=own.findLast(x=>x.stage==='selection'||x.stage==='llm_result'||x.stage==='llm_error');
  return pick?.stage==='selection'?pick.reason:pick?.stage==='llm_result'?'llm_'+pick.reason:pick?.stage==='llm_error'?(key?'llm_'+pick.reason:'needs_llm'):own.at(-1)?.reason||'-';
};
const totals={};
console.log('LLM gateway: '+(key?'live':'offline (LLM step skipped)'));
for(const entry of items){
  logs=[];
  let bgm='-',dm='-';
  try{const {item}=await catalogueItem(String(entry.id),env);bgm=item.bgmId?'bgm '+item.bgmId+' '+(item.aliases.find(x=>/\p{Script=Han}/u.test(x))||item.aliases[0]||''):'no bgm';
    try{
      const r=await fallbackDanmaku(item,'bahamut','1',env);
      // Show the chosen series (memory cache only) so each selection can be checked by eye.
      const identity=await titleMatchCached('danmaku:'+JSON.stringify(['bahamut',item.id,item.title,item.year]),async()=>null,false);
      const d=identity&&await resolveDanmaku(identity.url,env).catch(()=>null);
      dm=(r.sources[0]?'sn '+r.sources[0].id:'no ep1')+(d?' '+d.title+' ('+d.date+', eps '+d.episodes.slice(0,3).map(x=>x.label).join(',')+'…)':'');
    }catch(e){dm='error '+e.message.slice(0,40);}
  }catch(e){bgm='error '+e.message.slice(0,40);}
  const b=how('bangumi'),d=how('danmaku');
  for(const k of ['bangumi:'+b,'bahamut:'+d])totals[k]=(totals[k]||0)+1;
  console.log([entry.id,entry.year+entry.season,entry.title.padEnd(28),'| Bangumi',b,bgm,'| 動畫瘋',d,dm].join(' '));
}
console.log('\n'+Object.entries(totals).sort().map(([k,v])=>k+' '+v).join('\n'));
