// Fixture-backed Chromium checks against the built Worker and a SQLite storage adapter.
// Not a physical-TV, live-media or deployed-Cloudflare test.
import {createRequire} from 'node:module';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import worker,{WatchHistory} from '../dist/_worker.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const decodeQR=require('jsqr');
const artifacts=process.env.PAIRING_ARTIFACT_DIR||'/tmp/anime1-pairing-check';
await mkdir(artifacts,{recursive:true});
const sql=new DatabaseSync(':memory:');
sql.exec('CREATE TABLE records(profile TEXT,k TEXT,v TEXT,PRIMARY KEY(profile,k))');
let transactions=Promise.resolve();
class Storage {
  constructor(profile){this.profile=profile;}
  async get(key){
    if(Array.isArray(key)){assert.ok(key.length<=128);const pairs=await Promise.all(key.map(async k=>[k,await this.get(k)]));return new Map(pairs.filter(([,v])=>v!==undefined));}
    const row=sql.prepare('SELECT v FROM records WHERE profile=? AND k=?').get(this.profile,key);return row?JSON.parse(row.v):undefined;
  }
  async put(k,v){sql.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(this.profile,k,JSON.stringify(v));}
  async delete(k){sql.prepare('DELETE FROM records WHERE profile=? AND k=?').run(this.profile,k);}
  transaction(fn){const run=transactions.then(async()=>{sql.exec('BEGIN');try{const result=await fn(this);sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}});transactions=run.catch(()=>{});return run;}
  async list({prefix='',limit=128,startAfter=''}){return new Map(sql.prepare('SELECT k,v FROM records WHERE profile=? AND k LIKE ? AND k>? ORDER BY k LIMIT ?').all(this.profile,prefix+'%',startAfter,limit).map(x=>[x.k,JSON.parse(x.v)]));}
  async getAlarm(){return this.get('__alarm');}
  async setAlarm(at){return this.put('__alarm',at);}
}
const objects=new Map();
const env={WATCH_HISTORY:{idFromName:x=>x,get:x=>{if(!objects.has(x))objects.set(x,new WatchHistory({storage:new Storage(x)},env));return objects.get(x);}}};
const item={id:'1959',title:'動畫測試',episodes:'1-10',year:2026,season:'夏',format:'tv',bgmId:null};
const eps=['29599','29605'].map((id,i)=>({url:'https://anime1.me/'+id,title:'動畫測試 [0'+(i+3)+']',label:'第 '+(i+3)+' 集'}));
const security={'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'};
let pairCreates=0;
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://'+req.headers.host);let data;
    if(url.pathname.startsWith('/api/pairing/')||url.pathname.startsWith('/api/remote/')||['/api/history','/api/danmaku/settings'].includes(url.pathname)){
      if(url.pathname==='/api/pairing/create')pairCreates++;
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const result=await worker.fetch(new Request(url,{method:req.method,headers:req.headers,body:['POST','PUT'].includes(req.method)?Buffer.concat(chunks):undefined}),env);
      res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());return;
    }
    if(url.pathname==='/api/catalog')data={items:[item],years:['2026'],genres:[],nextPage:null,total:1};
    else if(url.pathname==='/api/catalog-item')data={item};
    else if(['/api/series','/api/episodes'].includes(url.pathname))data={title:item.title,episodes:eps,nextPage:null};
    else if(url.pathname==='/api/metadata')data={details:{}};
    else if(url.pathname==='/api/resolve'){let body='';for await(const chunk of req)body+=chunk;const id=JSON.parse(body).url.split('/').pop();data={url:'https://anime1.me/'+id,title:eps.find(x=>x.url.endsWith(id)).title,seriesId:'1959',media:'/api/media?id='+id,previous:null,next:null};}
    else if(url.pathname==='/api/media'){res.writeHead(204);res.end();return;}
    else if(url.pathname.startsWith('/api/danmaku/'))data={dandanplay:false,results:[],episodes:[],sources:[]};
    if(data){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;}
    const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(filename.includes('..')){res.writeHead(400);res.end();return;}
    const content=await readFile(new URL('../dist/'+filename,import.meta.url));
    const type=filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.svg')?'image/svg+xml':'text/html';
    res.writeHead(200,{...security,'Content-Type':type});res.end(content);
  }catch(e){console.error(e);res.writeHead(500);res.end('Fixture error');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
const errors=[];
async function device(width,height,storageState){
  const context=await browser.newContext({viewport:{width,height},storageState});
  await context.addInitScript(()=>{
    Object.defineProperty(HTMLMediaElement.prototype,'duration',{get(){return this._duration||NaN;}});
    HTMLMediaElement.prototype.load=function(){if(this.hasAttribute('src')){this._duration=1400;setTimeout(()=>this.dispatchEvent(new Event('loadedmetadata')),0);}else this._duration=NaN;};
    HTMLMediaElement.prototype.pause=function(){this.dispatchEvent(new Event('pause'));};
    HTMLMediaElement.prototype.play=async function(){this.dispatchEvent(new Event('playing'));};
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('.anime-card').waitFor();return{context,page};
}
async function saved(page,id,position){
  await page.evaluate(({id,position})=>{TVState.save({episodeId:id,seriesId:'1959',title:'動畫測試 [03]',seriesTitle:'動畫測試',position,duration:1400,completed:false});return TVState.flush();},{id,position});
  await page.waitForFunction(id=>TVState.get(id)?.dirty===false,id);
}
async function approve(page){await page.locator('#pair-match').check();await page.locator('#pair-approve').click();await page.locator('#pair-done').waitFor();return (await page.locator('#pair-done-verify').textContent()).trim();}
async function accept(page,verify){await page.locator('#pair-accept').waitFor();assert.equal((await page.locator('#pair-verify').textContent()).trim(),verify);await page.locator('#pair-accept-yes').click();}
async function pairing(page){await page.locator('#sync-toggle').click();await page.locator('#pair-create').click();await page.waitForFunction(()=>document.getElementById('pair-digits').textContent.replace(/\s/g,'').length===6&&!document.getElementById('pair-wait').hidden);return page.evaluate(()=>JSON.parse(sessionStorage.getItem('anime1-pairing')));}
try{
  const office=await device(1440,900),phone=await device(390,844),tv=await device(1280,720);
  await saved(office.page,'29599',754);await saved(office.page,'29605',60);
  const officeOldProfile=await office.page.evaluate(()=>TVState.profile());
  const createsBeforeOpen=pairCreates;await office.page.locator('#sync-toggle').click();await office.page.locator('#pair-home').waitFor();
  assert.equal(pairCreates,createsBeforeOpen);assert.equal(await office.page.evaluate(()=>document.activeElement.id),'pair-create');
  await office.page.locator('#pair-close').click();
  const first=await pairing(office.page);
  assert.equal(await office.page.locator('#sync-code').isVisible(),false);
  assert.equal(await office.page.locator('input:focus').count(),0);
  await office.page.locator('#pair-qr').screenshot({path:path.join(artifacts,'qr.png')});
  await office.page.screenshot({path:path.join(artifacts,'desktop-pairing.png')});
  const pixels=await office.page.locator('#pair-qr').evaluate(canvas=>({width:canvas.width,height:canvas.height,data:[...canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data]}));
  const scan=decodeQR(new Uint8ClampedArray(pixels.data),pixels.width,pixels.height);
  assert.equal(scan?.data,base+'/#pair='+first.ticket);
  await phone.page.goto(scan.data);await phone.page.locator('#pair-confirm').waitFor();
  assert.equal(new URL(phone.page.url()).hash.includes('pair='),false);
  assert.equal(await phone.page.locator('#pair-empty-warning').isVisible(),true);
  assert.equal(await phone.page.locator('#pair-approve').isDisabled(),true);
  assert.equal((await phone.page.locator('#pair-confirm-code').textContent()).replace(/\s/g,''),first.code);
  await phone.page.screenshot({path:path.join(artifacts,'mobile-confirmation.png'),fullPage:true});
  const firstVerify=await approve(phone.page);assert.match(firstVerify,/^\d{2}$/);
  assert.equal(await office.page.evaluate(old=>TVState.profile()===old,officeOldProfile),true);
  await accept(office.page,firstVerify);
  await office.page.waitForFunction(old=>TVState.profile()!==old,officeOldProfile);
  await office.page.locator('#sync-panel').waitFor({state:'hidden'});
  await phone.page.evaluate(()=>TVState.refresh());
  assert.equal(await phone.page.evaluate(()=>TVState.get('29599').position),754);
  const sharedProfile=await phone.page.evaluate(()=>TVState.profile());
  assert.equal(await office.page.evaluate(()=>TVState.profile()),sharedProfile);
  const officeSaved=await office.context.storageState();await office.context.close();
  console.log('PASS: QR independently decodes; explicit confirmation preserves office history on an initially empty phone');

  await phone.page.locator('#pair-finish').click();const second=await pairing(tv.page);
  await tv.page.screenshot({path:path.join(artifacts,'tv-pairing-1280.png')});
  assert.equal(await tv.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.ok(await tv.page.locator('#pair-qr').evaluate(el=>el.getBoundingClientRect().bottom<innerHeight));
  await tv.page.keyboard.press('ArrowRight');
  assert.equal(await tv.page.evaluate(()=>document.getElementById('sync-panel').contains(document.activeElement)),true);
  const createsBeforeReload=pairCreates;await tv.page.reload();await tv.page.locator('#pair-wait').waitFor();
  assert.equal(pairCreates,createsBeforeReload);
  assert.equal((await tv.page.locator('#pair-digits').textContent()).replace(/\s/g,''),second.code);
  await phone.page.locator('#sync-toggle').click();await phone.page.locator('#pair-enter').click();
  await phone.page.locator('#pair-code-input').fill(second.code.slice(0,3)+' '+second.code.slice(3));
  assert.equal(await phone.page.locator('#pair-code-input').getAttribute('inputmode'),'numeric');
  await phone.page.locator('#pair-submit').click();await phone.page.locator('#pair-confirm').waitFor();await accept(tv.page,await approve(phone.page));
  await tv.page.waitForFunction(token=>TVState.profile()===token,sharedProfile);
  await tv.page.locator('#sync-panel').waitFor({state:'hidden'});
  assert.equal(await tv.page.evaluate(()=>TVState.get('29599').position),754);
  sql.prepare("DELETE FROM records WHERE profile='pairing:v1'").run();
  const createsAfterLink=pairCreates;await tv.page.reload();await tv.page.waitForFunction(()=>TVState.get('29599')?.position===754);
  assert.equal(pairCreates,createsAfterLink);assert.equal(await tv.page.locator('#sync-panel').isVisible(),false);
  await tv.page.locator('[data-preset=history]').click();await tv.page.locator('.history-row').first().waitFor();
  await tv.page.locator('.history-row').filter({hasText:'12:34'}).locator('button').click();
  await tv.page.waitForFunction(()=>document.getElementById('video').currentTime===754);
  await saved(tv.page,'29599',800);await phone.page.evaluate(()=>TVState.refresh());
  assert.equal(await phone.page.evaluate(()=>TVState.get('29599').position),800);
  const nextOffice=await device(1440,900,officeSaved);await nextOffice.page.evaluate(()=>TVState.refresh());
  assert.equal(await nextOffice.page.evaluate(()=>TVState.get('29599').position),800);
  console.log('PASS: six-digit input, waiting reload, closed office, TV resume at 12:34 and persistent three-device sync after leases expire');

  await phone.page.locator('#pair-finish').click();await phone.page.locator('#sync-toggle').click();await phone.page.locator('#pair-enter').click();
  await phone.page.locator('#pair-code-input').fill('12');await phone.page.locator('#pair-submit').click();
  await phone.page.locator('#pair-error').filter({hasText:'六位'}).waitFor();
  await phone.page.route('**/api/pairing/preview',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture unavailable"}'}));
  await phone.page.locator('#pair-code-input').fill('000001');await phone.page.locator('#pair-submit').click();
  await phone.page.locator('#pair-error').filter({hasText:'fixture unavailable'}).waitFor();
  assert.equal(await phone.page.evaluate(()=>TVState.profile()),sharedProfile);
  assert.equal(await phone.page.evaluate(()=>TVState.get('29599').position),800);
  await phone.page.unroute('**/api/pairing/preview');await phone.page.locator('#pair-close').click();
  console.log('PASS: malformed code and network failure leave current progress untouched');

  const stranger=await device(390,844);const rejected=await pairing(tv.page);
  await stranger.page.locator('#sync-toggle').click();await stranger.page.locator('#pair-enter').click();
  await stranger.page.locator('#pair-code-input').fill(rejected.code);await stranger.page.locator('#pair-submit').click();
  await stranger.page.locator('#pair-confirm').waitFor();await approve(stranger.page);
  await tv.page.locator('#pair-accept').waitFor();await tv.page.locator('#pair-accept-no').click();await tv.page.locator('#pair-home').waitFor();
  assert.equal(await tv.page.evaluate(()=>TVState.profile()),sharedProfile);
  assert.equal((await objects.get('pairing:v1').storage.get('session:'+rejected.sessionId)).status,'cancelled');
  assert.equal(await stranger.page.evaluate(()=>TVState.get('29599')),undefined);
  await tv.page.locator('#pair-close').click();await stranger.context.close();
  console.log('PASS: an unexpected phone approval is shown for comparison and can be rejected without merging');

  await tv.page.goto(base);const expiring=await pairing(tv.page);
  const db=objects.get('pairing:v1').storage,record=await db.get('session:'+expiring.sessionId);
  record.expiresAt=Date.now()-1;await db.put('session:'+expiring.sessionId,record);
  await tv.page.locator('#pair-renew').waitFor();assert.equal(await tv.page.locator('#pair-qr').isVisible(),false);
  await tv.page.locator('#pair-renew').click();await tv.page.locator('#pair-qr').waitFor();
  const renewed=await tv.page.evaluate(()=>JSON.parse(sessionStorage.getItem('anime1-pairing')));
  assert.notEqual(renewed.sessionId,expiring.sessionId);
  await tv.page.locator('#pair-options').click();await tv.page.locator('#pair-home').waitFor();
  assert.equal((await db.get('session:'+renewed.sessionId)).status,'cancelled');
  await tv.page.locator('#sync-advanced').evaluate(el=>el.open=true);
  assert.equal(await tv.page.locator('#sync-code').inputValue(),sharedProfile.match(/.{1,4}/g).join('-'));
  await tv.page.locator('#pair-close').click();
  console.log('PASS: expired-code UI, explicit renewal, cancellation and hidden-by-default legacy recovery');

  for(const [width,height]of [[320,700],[390,844],[1920,1080]]){
    await phone.page.setViewportSize({width,height});await phone.page.locator('#sync-toggle').click();await phone.page.waitForTimeout(200);
    assert.equal(await phone.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await phone.page.keyboard.press('Tab');assert.equal(await phone.page.evaluate(()=>document.getElementById('sync-panel').contains(document.activeElement)),true);
    await phone.page.keyboard.press('Escape');await phone.page.locator('#sync-panel').waitFor({state:'hidden'});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: 320/390/1280/1440/1920px layouts, remote/Tab focus, Escape and zero uncaught page errors');
}catch(error){
  let index=0;
  for(const context of browser.contexts())for(const page of context.pages()){
    try{await page.screenshot({path:path.join(artifacts,'failure-'+index+++'.png'),fullPage:true});console.error('Page state',await page.evaluate(()=>({hash:location.hash,sync:document.getElementById('sync-status')?.textContent,error:document.getElementById('pair-error')?.textContent})));}catch{}
  }
  console.error('Uncaught page errors',errors);throw error;
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));sql.close();}
