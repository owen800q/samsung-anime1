import {createRequire} from 'node:module';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {historyRoute} from '../src/sync-server.js';
import {WatchHistory} from '../src/sync-server.js';
const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright/package.json':import.meta.url);const {chromium}=require('playwright');
const sql=new DatabaseSync(':memory:');sql.exec('CREATE TABLE records(profile TEXT,k TEXT,v TEXT, PRIMARY KEY(profile,k))');
class Storage{
 constructor(profile){this.profile=profile;}
 async get(k){if(Array.isArray(k)){assert.ok(k.length<=128);const pairs=await Promise.all(k.map(async x=>[x,await this.get(x)]));return new Map(pairs.filter(x=>x[1]!==undefined));}const r=sql.prepare('SELECT v FROM records WHERE profile=? AND k=?').get(this.profile,k);return r?JSON.parse(r.v):undefined;}
 async put(k,v){sql.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(this.profile,k,JSON.stringify(v));}
 async delete(k){sql.prepare('DELETE FROM records WHERE profile=? AND k=?').run(this.profile,k);}
 async transaction(fn){return fn(this);}
}
const env={WATCH_HISTORY:{idFromName:x=>x,get:x=>new WatchHistory({storage:new Storage(x)})}};
const item={id:'1959',title:'動畫測試',episodes:'1-10',year:2026,season:'夏',format:'tv',bgmId:null};
const eps=['29599','29605'].map((id,i)=>({url:'https://anime1.me/'+id,title:'動畫測試 [0'+(i+3)+']',label:'第 '+(i+3)+' 集'}));
const server=http.createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://localhost');let data;
 if(u.pathname==='/api/history'){
  const chunks=[];for await(const c of req)chunks.push(c);const result=await historyRoute(new Request(u,{method:req.method,headers:req.headers,body:req.method==='PUT'?Buffer.concat(chunks):undefined}),env);res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());return;
 }
 if(u.pathname==='/api/catalog')data={items:[item],years:['2026'],genres:[],nextPage:null,total:1};
 else if(u.pathname==='/api/catalog-item')data={item};
 else if(['/api/series','/api/episodes'].includes(u.pathname))data={title:item.title,episodes:eps,nextPage:null};
 else if(u.pathname==='/api/search')data={episodes:eps};
 else if(u.pathname==='/api/resolve'){let body='';for await(const c of req)body+=c;const id=JSON.parse(body).url.split('/').pop();data={url:'https://anime1.me/'+id,title:eps.find(e=>e.url.endsWith(id)).title,seriesId:'1959',media:'/api/media?id='+id,previous:null,next:null};}
 else if(u.pathname==='/api/metadata')data={details:{}};
 else if(u.pathname==='/api/media'){res.writeHead(204);res.end();return;}
 if(data){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;}
 const path=u.pathname==='/'?'index.html':u.pathname.slice(1);const bytes=await readFile(new URL('../dist/'+path,import.meta.url));res.writeHead(200,{'Content-Type':path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html','Cache-Control':'no-store'});res.end(bytes);
 }catch(e){console.error(e);res.writeHead(500);res.end(String(e));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
const errors=[];
async function device(){const ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.addInitScript(()=>{
 Object.defineProperty(HTMLMediaElement.prototype,'duration',{get(){return this._duration||NaN;}});
 HTMLMediaElement.prototype.load=function(){if(this.hasAttribute('src')){this._duration=1400;setTimeout(()=>this.dispatchEvent(new Event('loadedmetadata')),0);}else this._duration=NaN;};
 HTMLMediaElement.prototype.pause=function(){this.dispatchEvent(new Event('pause'));};
 HTMLMediaElement.prototype.play=async function(){this.dispatchEvent(new Event('playing'));};
 });const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));return p;}
try{
 const a=await device();await a.goto(base);await a.locator('.anime-card').waitFor();
 await a.locator('#catalog-q').fill('動畫');await a.locator('#catalog-form').evaluate(f=>f.requestSubmit());await a.waitForURL(/q=/);await a.reload();assert.equal(await a.locator('#catalog-q').inputValue(),'動畫');
 await a.locator('.anime-card').click();await a.waitForURL(/view=anime/);await a.reload();await a.locator('#detail-title').filter({hasText:'動畫測試'}).waitFor();assert.equal(await a.locator('#home-detail').isVisible(),true);
 await a.locator('.episode-button').first().click();await a.waitForFunction(()=>!document.getElementById('play').disabled);await a.locator('#play').click();
 await a.evaluate(()=>{const v=document.getElementById('video');v.currentTime=234;v.dispatchEvent(new Event('seeked'));v.pause();});
 await a.waitForFunction(()=>window.TVState.get('29599')?.dirty===false);
 const token=await a.evaluate(()=>JSON.parse(localStorage.getItem('anime1-profile')));
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM records WHERE k='ep:29599'").get().n,1);
 const b=await device();await b.goto(base);await b.locator('#sync-toggle').click();await b.locator('#sync-input').fill(token);await b.locator('#sync-form').evaluate(f=>f.requestSubmit());await b.waitForFunction(()=>window.TVState.get('29599')?.position===234);
 await b.locator('#sync-toggle').click();await b.locator('[data-preset=history]').click();await b.locator('.history-row').waitFor();assert.match(await b.locator('.history-row').textContent(),/3:54/);
 await b.locator('.history-row button').click();await b.waitForFunction(()=>document.getElementById('video').currentTime===234);await b.reload();await b.waitForFunction(()=>document.getElementById('video').currentTime===234);
 await b.locator('.episode-button').nth(1).click();await b.waitForFunction(()=>!document.getElementById('play').disabled);await b.locator('#play').click();await b.evaluate(()=>{const v=document.getElementById('video');v.currentTime=600;v.dispatchEvent(new Event('seeked'));v.pause();});await b.waitForFunction(()=>window.TVState.get('29605')?.dirty===false);
 await a.evaluate(()=>window.TVState.refresh());assert.equal(await a.evaluate(()=>window.TVState.get('29605').position),600);assert.equal(await a.evaluate(()=>window.TVState.get('29599').position),234);
 await a.goto(base+'/#view=anime&id=1959');await a.waitForFunction(()=>document.getElementById('detail-history').textContent.includes('10:00'));assert.match(await a.locator('#detail-history').textContent(),/04/);
 await a.locator('#home-back').click();await a.locator('#tab-search').click();await a.locator('#search-query').fill('測試');await a.locator('#search-form').evaluate(f=>f.requestSubmit());await a.locator('.result').first().waitFor();await a.reload();await a.locator('.result').first().waitFor();assert.equal(await a.locator('#search-query').inputValue(),'測試');
 assert.deepEqual(errors,[]);console.log('PASS: refresh catalogue/detail/player/search; two isolated devices paired; SQLite history; independent episodes; resume and detail reminder');
}finally{await browser.close();server.close();sql.close();}
