import {createRequire} from 'node:module';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES?process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright/package.json':import.meta.url);
const {chromium}=require('playwright');
const server=http.createServer(async(req,res)=>{
 try{const path=new URL(req.url,'http://localhost').pathname;const file=path==='/'?'index.html':path.slice(1);
 const bytes=await readFile(new URL('../dist/'+file,import.meta.url));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(bytes);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const items=[1,2,3].map(id=>({id,title:'動畫 '+id,episodes:'1-2',year:'2026',format:'tv',bgmId:id===3?null:100+id}));
let mode='normal',release,commentCalls=0;
const text='<img src=x onerror="window.injected=true">\n精彩短評';
await page.route('**/api/**',async route=>{
 const u=new URL(route.request().url());let data={};
 if(u.pathname==='/api/catalog')data={items,years:['2026'],genres:[],total:3,nextPage:null};
 if(u.pathname==='/api/catalog-item')data={item:items.find(i=>i.id===Number(u.searchParams.get('id')))};
 if(u.pathname==='/api/metadata')data={details:{}};
 if(u.pathname==='/api/cover'){await route.fulfill({status:404});return;}
 if(u.pathname==='/api/history')data={records:[]};
 if(u.pathname==='/api/series')data={episodes:[{url:'https://anime1.me/29599',title:'第 1 集',label:'第 1 集'}],nextPage:null};
 if(u.pathname==='/api/comments'){
  commentCalls++;const p=Number(u.searchParams.get('page')),id=Number(u.searchParams.get('id'));
  if(mode==='delayed'&&id===1)await new Promise(r=>release=r);
  if(mode==='error'){await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'offline'})});return;}
  data={comments:mode==='empty'?[]:[{author:'作者 '+id,text:p===1?text:'第二頁評論',rating:8,updatedAt:1700000000}],total:mode==='empty'?0:21,nextPage:mode==='empty'||p===2?null:2,page:p,matched:true};
 }
 await route.fulfill({contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
});
try{
 await page.goto(base+'/#view=anime&id=1');await page.locator('.bangumi-comment').waitFor();
 assert.equal(await page.locator('.bangumi-comment p').textContent(),text);assert.equal(await page.locator('.bangumi-comment img').count(),0);
 assert.equal(await page.evaluate(()=>window.injected),undefined);assert.match(await page.locator('.comment-meta').textContent(),/8 \/ 10/);
 await page.locator('#comments-next').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#comments-page').textContent==='第 2 頁');
 assert.equal(await page.locator('#comments-next').isDisabled(),true);assert.equal(await page.locator('.bangumi-comment p').textContent(),'第二頁評論');
 await page.locator('#comments-prev').click();await page.waitForFunction(()=>document.querySelector('#comments-page').textContent==='第 1 頁');
 mode='error';await page.locator('#comments-next').click();await page.locator('#comments-retry').waitFor();
 assert.equal(await page.locator('.bangumi-comment p').textContent(),text);
 mode='normal';await page.locator('#comments-retry').click();await page.waitForFunction(()=>document.querySelector('#comments-page').textContent==='第 2 頁');
 await page.reload();await page.locator('.bangumi-comment').waitFor();assert.equal(await page.locator('#comments-page').textContent(),'第 1 頁');
 mode='delayed';await page.reload();await page.waitForFunction(()=>document.querySelector('#comments-status').textContent.includes('正在讀取'));
 // Playback controls become ready while the comment response is still pending.
 await page.waitForFunction(()=>!document.querySelector('#detail-episodes').disabled);
 await page.locator('#home-back').click();await page.locator('.anime-card').nth(1).click();await page.locator('.comment-meta strong').filter({hasText:'作者 2'}).waitFor();
 assert.ok(release);release();await page.waitForTimeout(100);assert.equal(await page.locator('.comment-meta strong').textContent(),'作者 2');
 await page.locator('#home-back').click();const before=commentCalls;await page.locator('.anime-card').nth(2).click();
 await page.waitForFunction(()=>document.querySelector('#comments-status').textContent.includes('尚未配對'));
 assert.equal(commentCalls,before);assert.equal(await page.locator('.bangumi-comment').count(),0);
 mode='empty';await page.goto(base+'/#view=anime&id=2');await page.waitForFunction(()=>document.querySelector('#comments-status').textContent.includes('暫時未有'));
 mode='normal';await page.reload();await page.locator('.bangumi-comment').waitFor();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
 assert.deepEqual(errors,[]);console.log('PASS: comment rendering/XSS, pagination, retry, reload, stale response isolation, unmatched/empty states, independent episodes, mobile width');
}finally{release?.();await browser.close();server.close();}
