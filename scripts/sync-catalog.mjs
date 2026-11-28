// Refresh the saved catalogue the Worker falls back to when janime's live index is unreachable.
// Run explicitly with Node >= 24: node --use-env-proxy scripts/sync-catalog.mjs
// Rows are stored as janime publishes them and mapped at runtime (src/catalog.js), so the
// airing state follows today's date rather than the day of the snapshot.
import {writeFile,readFile} from 'node:fs/promises';
import {CATALOGUE_URL,catalogueEntry} from '../src/catalog.js';
const ua='SamsungAnime1/1.1 (https://github.com/owen800q/Samsung-anime1)';
async function data(url, local) {
  if(process.env.CATALOG_FIXTURE_DIR) return JSON.parse(await readFile(process.env.CATALOG_FIXTURE_DIR+'/'+local,'utf8'));
  const r=await fetch(url,{headers:{'User-Agent':ua},signal:AbortSignal.timeout(60000)});
  if(!r.ok) throw new Error('Catalogue download failed: '+r.status);
  return r.json();
}
const source=await data(CATALOGUE_URL,'janime-index.json');
if(!Array.isArray(source))throw new Error('Unexpected catalogue shape');
const rows=source.filter(row=>catalogueEntry(row)).map(row=>row.slice(0,7));
if(rows.length<100)throw new Error('Unexpected catalogue shape');
const snapshot={updatedAt:new Date().toISOString(),rows};
await writeFile(new URL('../src/catalog-data.js',import.meta.url),'// Source: janime.cc/search-index.zh-tw.min.json (series IDs are Bangumi subject IDs). See README.\n// Row: [id, Traditional title, Simplified title, year, first air date, format, season].\nexport const CATALOG_SEED = '+JSON.stringify(snapshot)+';\n');
console.log('Catalogue:',rows.length,'titles.');
