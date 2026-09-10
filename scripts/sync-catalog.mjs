// Refresh the attributed catalogue snapshot and conservative Bangumi mappings.
// Run explicitly with Node >= 24: node --use-env-proxy scripts/sync-catalog.mjs
import {writeFile,readFile} from 'node:fs/promises';
const ua='SamsungAnime1/1.1 (https://github.com/owen800q/Samsung-anime1)';
async function data(url, local) {
  if(process.env.CATALOG_FIXTURE_DIR) return JSON.parse(await readFile(process.env.CATALOG_FIXTURE_DIR+'/'+local,'utf8'));
  const r=await fetch(url,{headers:{'User-Agent':ua},signal:AbortSignal.timeout(60000)});
  if(!r.ok) throw new Error('Catalogue download failed: '+r.status);
  return r.json();
}
const [rows,bangumi]=await Promise.all([data('https://anime1.me/animelist.json','anime1-list.json'),data('https://raw.githubusercontent.com/bangumi-data/bangumi-data/master/dist/data.json','bgm-data.txt')]);
const normal=s=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const names=new Map();
for(const item of bangumi.items){
  const id=Number(item.sites.find(s=>s.site==='bangumi')?.id);if(!id)continue;
  const aliases=[item.title,...Object.values(item.titleTranslate||{}).flat()];
  for(const name of aliases){const key=normal(name);if(!names.has(key))names.set(key,new Map());names.get(key).set(id,{id,type:item.type,begin:item.begin,aliases});}
}
const entries=rows.filter(r=>Number.isInteger(r[0])&&r[0]>0).map(r=>{
  let matches=[...(names.get(normal(r[1]))?.values()||[])];
  if(matches.length>1)matches=matches.filter(x=>x.begin?.startsWith(String(r[3])));
  const match=matches.length===1?matches[0]:null;
  return {id:r[0],title:r[1],episodes:r[2],year:String(r[3]),season:r[4],bgmId:match?.id||null,format:String(r[2]).includes('劇場版')?'movie':match?.type||(/^(OVA|SP)/.test(String(r[2]))?'ova':'unknown'),aliases:match?.aliases||[]};
});
if(entries.length<100)throw new Error('Unexpected catalogue shape');
const snapshot={updatedAt:new Date().toISOString(),entries};
await writeFile(new URL('../src/catalog-data.js',import.meta.url),'// Sources: anime1.me/animelist.json; bangumi-data (CC BY 4.0). See README.\nexport const CATALOG_SEED = '+JSON.stringify(snapshot)+';\n');
console.log('Catalogue:',entries.length,'titles;',entries.filter(x=>x.bgmId).length,'unambiguous Bangumi mappings.');
