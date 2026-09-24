// Fixture-backed Chromium check of phone-to-TV remote control against the built Worker.
// The fixture server has no WebSocket upgrade, so this also exercises the polling fallback.
// Not a physical-TV, live-media or deployed-Cloudflare test.
import {createRequire} from 'node:module';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import worker,{WatchHistory} from '../dist/_worker.js';
import {MemoryStorage} from '../tests/helpers/pairing-storage.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const artifacts=process.env.PAIRING_ARTIFACT_DIR||'/tmp/anime1-remote-check';
await mkdir(artifacts,{recursive:true});
const objects=new Map();
const env={WATCH_HISTORY:{idFromName:x=>x,get:x=>{if(!objects.has(x))objects.set(x,new WatchHistory({storage:new MemoryStorage()},env));return objects.get(x);}}};
const item={id:'1959',title:'動畫測試',episodes:'1-10',year:2026,season:'夏',format:'tv',bgmId:null};
const eps=['29599','29605'].map((id,i)=>({url:'https://anime1.me/'+id,title:'動畫測試 [0'+(i+3)+']',label:'第 '+(i+3)+' 集'}));
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://'+req.headers.host);let data;
    if(url.pathname.startsWith('/api/remote/')||url.pathname.startsWith('/api/pairing/')||['/api/history','/api/danmaku/settings'].includes(url.pathname)){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const result=await worker.fetch(new Request(url,{method:req.method,headers:req.headers,body:['POST','PUT'].includes(req.method)?Buffer.concat(chunks):undefined}),env);
      res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());return;
    }
    if(url.pathname==='/api/catalog')data={items:[item],years:['2026'],genres:[],nextPage:null,total:1};
    else if(url.pathname==='/api/catalog-item')data={item};
    else if(['/api/series','/api/episodes'].includes(url.pathname))data={title:item.title,episodes:eps,nextPage:null};
    else if(url.pathname==='/api/metadata')data={details:{}};
    else if(url.pathname==='/api/resolve'){let body='';for await(const chunk of req)body+=chunk;const id=JSON.parse(body).url.split('/').pop();const at=eps.findIndex(x=>x.url.endsWith(id));data={url:'https://anime1.me/'+id,title:eps[at].title,seriesId:'1959',media:'/api/media?id='+id,previous:eps[at-1]||null,next:eps[at+1]||null};}
    else if(url.pathname==='/api/media'){res.writeHead(204);res.end();return;}
    else if(url.pathname.startsWith('/api/danmaku/'))data={dandanplay:false,results:[],episodes:[],sources:[]};
    if(data){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;}
    const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(filename.includes('..')){res.writeHead(400);res.end();return;}
    const content=await readFile(new URL('../dist/'+filename,import.meta.url));
    const type=filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.svg')?'image/svg+xml':'text/html';
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(content);
  }catch(e){console.error(e);res.writeHead(500);res.end('Fixture error');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
const errors=[];
async function device(width,height,options={}){
  const context=await browser.newContext({viewport:{width,height},...options});
  await context.addInitScript(()=>{
    Object.defineProperty(HTMLMediaElement.prototype,'duration',{get(){return this._duration||NaN;}});
    Object.defineProperty(HTMLMediaElement.prototype,'paused',{get(){return this._paused!==false;}});
    HTMLMediaElement.prototype.load=function(){this._paused=true;if(this.hasAttribute('src')){this._duration=1400;setTimeout(()=>this.dispatchEvent(new Event('loadedmetadata')),0);}else this._duration=NaN;};
    HTMLMediaElement.prototype.pause=function(){if(this._paused===false){this._paused=true;this.dispatchEvent(new Event('pause'));}};
    HTMLMediaElement.prototype.play=async function(){this._paused=false;this.dispatchEvent(new Event('playing'));};
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('.anime-card').waitFor();return{context,page};
}
const tvVideo=page=>page.evaluate(()=>{const v=document.getElementById('video');return {paused:v.paused,time:v.currentTime,episode:TVState.route().get('episode')};});
try{
  const tv=await device(1280,720),phone=await device(390,844,{isMobile:true,hasTouch:true});
  await tv.page.evaluate(()=>localStorage.setItem('anime1-device-name','客廳電視'));await tv.page.reload();await tv.page.locator('.anime-card').waitFor();
  const profile=await tv.page.evaluate(()=>TVState.profile());
  assert.equal(await phone.page.locator('#remote-toggle').isVisible(),false);
  await phone.page.evaluate(p=>TVState.changeProfile(p),profile);
  await phone.page.evaluate(()=>{TVState.save({episodeId:'29599',seriesId:'1959',title:'動畫測試 [03]',seriesTitle:'動畫測試',position:300,duration:1400,completed:false});return TVState.flush();});
  await phone.page.locator('#remote-toggle').waitFor();
  assert.equal(await tv.page.locator('#remote-toggle').isVisible(),false);
  await phone.page.locator('#remote-toggle').click();
  const screenButton=phone.page.locator('.remote-device',{hasText:'客廳電視'});await screenButton.click();
  assert.equal(await screenButton.getAttribute('aria-pressed'),'true');
  await phone.page.screenshot({path:path.join(artifacts,'remote-panel-390.png')});
  await phone.page.locator('#remote-browse').click();await phone.page.locator('#remote-bar').waitFor();
  console.log('PASS: a paired phone discovers the TV and selects it; the TV itself shows no remote button');

  await phone.page.locator('#catalog-q').fill('動畫');await phone.page.locator('#catalog-form').evaluate(f=>f.requestSubmit());
  await phone.page.locator('.anime-card').first().click();await phone.page.locator('.episode-button').first().waitFor();
  await phone.page.locator('.episode-button').first().click();
  await tv.page.waitForFunction(()=>TVState.route().get('episode')==='29599'&&!document.getElementById('video').paused);
  await tv.page.waitForFunction(()=>document.getElementById('video').currentTime===300);
  assert.match(await tv.page.locator('#remote-toast').textContent(),/手機：播放 動畫測試 第 3 集/);
  assert.equal(await phone.page.locator('#watch-player').isVisible(),false);
  await phone.page.locator('#remote-bar-title').filter({hasText:'動畫測試 [03]'}).waitFor();
  await tv.page.screenshot({path:path.join(artifacts,'tv-remote-play.png')});
  await phone.page.screenshot({path:path.join(artifacts,'phone-casting.png')});
  console.log('PASS: search and pick on the phone; the TV plays that episode from the shared resume point');

  await phone.page.locator('#remote-bar [data-remote=toggle]').click();
  await tv.page.waitForFunction(()=>document.getElementById('video').paused);
  await phone.page.locator('#remote-bar [data-remote=toggle]').filter({hasText:'▶'}).waitFor();
  await phone.page.locator('#remote-bar-open').click();await phone.page.locator('#remote-now').waitFor();
  await phone.page.locator('[data-remote=seek][data-delta="10"]').click();
  await tv.page.waitForFunction(()=>document.getElementById('video').currentTime===310);
  await phone.page.locator('#remote-next:not(:disabled)').click();
  await tv.page.waitForFunction(()=>TVState.route().get('episode')==='29605'&&!document.getElementById('video').paused);
  await phone.page.locator('#remote-now-title').filter({hasText:'[04]'}).waitFor();
  await phone.page.locator('#remote-close').click();
  console.log('PASS: pause, seek and next episode from the phone, with now-playing feedback');

  await phone.page.locator('#remote-bar-stop').click();await phone.page.locator('#remote-bar').waitFor({state:'hidden'});
  await phone.page.locator('.episode-button').first().click();await phone.page.locator('#watch-player').waitFor();
  assert.equal((await tvVideo(tv.page)).episode,'29605');
  console.log('PASS: stopping remote control plays on the phone again and leaves the TV alone');

  for(const width of [320,390]){
    await phone.page.setViewportSize({width,height:700});await phone.page.locator('#remote-toggle').click();await phone.page.waitForTimeout(100);
    assert.equal(await phone.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await phone.page.keyboard.press('Escape');await phone.page.locator('#remote-panel').waitFor({state:'hidden'});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: 320/390px layouts, Escape closes the remote, zero uncaught page errors');
}catch(error){
  let index=0;
  for(const context of browser.contexts())for(const page of context.pages()){try{await page.screenshot({path:path.join(artifacts,'remote-failure-'+index+++'.png'),fullPage:true});}catch{}}
  console.error('Uncaught page errors',errors);throw error;
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
