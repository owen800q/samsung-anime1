import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchHistory, historyRoute } from '../src/sync-server.js';
class Storage {
  data=new Map();
  async get(key){return structuredClone(Array.isArray(key)?new Map(key.filter(k=>this.data.has(k)).map(k=>[k,this.data.get(k)])):this.data.get(key));}
  async put(k,v){this.data.set(k,structuredClone(v));}
  async delete(k){this.data.delete(k);}
  async transaction(fn){return fn(this);}
}
const progress={episodeId:'29599',seriesId:'1959',title:'動畫 [03]',seriesTitle:'動畫',position:234.5,duration:1400,completed:false,revision:0};
const put=data=>new Request('https://history.test',{method:'PUT',body:JSON.stringify(data)});
test('history survives object recreation; episodes retain independent positions and reject stale device writes',async()=>{
 const storage=new Storage();let db=new WatchHistory({storage});
 const first=await (await db.fetch(put(progress))).json();assert.equal(first.entry.revision,1);
 await db.fetch(put({...progress,episodeId:'29605',position:500}));
 db=new WatchHistory({storage});
 const rows=(await (await db.fetch(new Request('https://history.test'))).json()).entries;
 assert.equal(rows.length,2);assert.equal(rows.find(x=>x.episodeId==='29599').position,234.5);
 const stale=await db.fetch(put({...progress,position:0}));assert.equal(stale.status,409);assert.equal((await stale.json()).entry.position,234.5);
 assert.equal((await db.fetch(put({...progress,revision:1,position:1000}))).status,200);
 assert.equal((await db.fetch(put({...progress,episodeId:'9',position:5000}))).status,400);
});
test('profile bearer is required and separate profiles cannot read one another',async()=>{
 const stores=new Map();const env={WATCH_HISTORY:{idFromName:n=>n,get:n=>{if(!stores.has(n))stores.set(n,new Storage());return new WatchHistory({storage:stores.get(n)});}}};
 const req=(token,body)=>new Request('https://site.test/api/history',{method:body?'PUT':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 assert.equal((await historyRoute(req(''),env)).status,401);
 assert.equal((await historyRoute(req('a'.repeat(32)),{})).status,503);
 assert.equal((await historyRoute(req('a'.repeat(32),progress),env)).status,200);
 assert.equal((await (await historyRoute(req('a'.repeat(32)),env)).json()).entries.length,1);
 assert.equal((await (await historyRoute(req('b'.repeat(32)),env)).json()).entries.length,0);
});

