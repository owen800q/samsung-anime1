// Live smoothness check: plays a real video in Chromium with the built app and records, on every
// animation frame, where one scrolling comment is drawn on the danmaku canvas.
// Usage: node scripts/check-danmaku-smoothness.mjs [danmaku.js ...]   (default: dist/danmaku.js)
// Each file is measured on desktop Chromium and under a TV emulation (currentTime reported in
// 250ms steps, as on Samsung TV browsers, plus 4x CPU throttling).
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require(require('node:child_process').execSync('npm root -g').toString().trim()+'/playwright'));}
const root=new URL('../',import.meta.url);
const files=process.argv.slice(2).length?process.argv.slice(2):['dist/danmaku.js'];
const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});

async function testVideo(){
  const cache=path.join(tmpdir(),'danmaku-smoothness.webm');
  try{return await readFile(cache);}catch{}
  const page=await browser.newPage();
  const b64=await page.evaluate(()=>new Promise(resolve=>{
    const c=document.createElement('canvas');c.width=640;c.height=360;const g=c.getContext('2d');
    const rec=new MediaRecorder(c.captureStream(30),{mimeType:'video/webm;codecs=vp8'}),chunks=[];
    rec.ondataavailable=e=>chunks.push(e.data);
    rec.onstop=async()=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(new Blob(chunks,{type:'video/webm'}));};
    const start=performance.now();(function frame(){const t=(performance.now()-start)/1000;g.fillStyle='hsl('+(t*40%360)+',50%,30%)';g.fillRect(0,0,640,360);g.fillStyle='#fff';g.font='48px sans-serif';g.fillText(t.toFixed(2),40,200);if(t<16)requestAnimationFrame(frame);else rec.stop();})();
    rec.start(500);
  }));
  await page.close();const bytes=Buffer.from(b64,'base64');await mkdir(path.dirname(cache),{recursive:true});await writeFile(cache,bytes);return bytes;
}
const video=await testVideo();
const comments=[{time:0.3,mode:1,color:'#ffffff',text:'TRACK 追蹤這條彈幕'}];
for(let i=0;i<300;i++)comments.push({time:0.8+(i*0.047)%14,mode:1,color:['#ffffff','#fe0302','#00cd00','#ffff00'][i%4],text:'彈幕測試 '+i+' '+'哈'.repeat(i%12)});

async function measure(file,tv){
  const ctx=await browser.newContext({viewport:{width:1920,height:1080}});
  const script=await readFile(new URL(file,root));
  await ctx.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.pathname==='/danmaku.js')return route.fulfill({body:script,contentType:'application/javascript'});
    if(u.pathname==='/test.webm')return route.fulfill({body:video,contentType:'video/webm'});
    if(u.pathname==='/api/danmaku/settings')return route.fulfill({json:{entry:{episodeId:'e1',sources:[{provider:'bahamut',id:'1',url:'https://example.invalid/',title:'fixture',offset:0}],revision:1}}});
    if(u.pathname==='/api/danmaku/comments')return route.fulfill({json:{comments}});
    if(u.pathname.startsWith('/api/'))return route.fulfill({json:{items:[],episodes:[],years:[],genres:[]}});
    const name=u.pathname==='/'?'index.html':u.pathname.slice(1);
    try{return route.fulfill({body:await readFile(new URL('dist/'+name,root)),contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html'});}
    catch{return route.fulfill({status:404,body:''});}
  });
  await ctx.addInitScript(tv=>{
    if(tv){const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');
      Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{configurable:true,get(){const t=d.get.call(this);return this.paused?t:Math.floor(t/.25)*.25;},set(v){d.set.call(this,v);}});}
    const samples=window.__samples=[],P=CanvasRenderingContext2D.prototype,fill=P.fillText,image=P.drawImage;
    const record=(label,x)=>{if(String(label).startsWith('TRACK'))samples.push({t:performance.now(),x});};
    P.fillText=function(text,x,...rest){if(this.canvas.id==='danmaku-canvas')record(text,x);else this.canvas.__label=text;return fill.call(this,text,x,...rest);};
    P.drawImage=function(el,x,...rest){if(this.canvas.id==='danmaku-canvas')record(el.__label,x);return image.call(this,el,x,...rest);};
  },tv);
  const page=await ctx.newPage();if(process.env.DEBUG)page.on('pageerror',e=>console.log('pageerror',e.message));
  if(tv){const cdp=await ctx.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});}
  await page.goto('http://localhost:4173/');
  await page.waitForFunction(()=>window.TVDanmaku&&document.getElementById('video'));
  await page.evaluate(async()=>{
    // Reveal the player without routing through the catalogue.
    for(let e=document.getElementById('screen');e;e=e.parentElement)e.hidden=false;
    document.getElementById('empty').hidden=true;document.getElementById('screen').scrollIntoView();window.dispatchEvent(new Event('resize'));
    await window.TVDanmaku.open({episodeId:'e1',title:'fixture [01]',seriesTitle:'fixture'});
    const v=document.getElementById('video');v.muted=true;v.src='/test.webm';await v.play();
  });
  await page.waitForTimeout(10500);
  if(process.env.DEBUG)console.log(await page.evaluate(()=>{const v=document.getElementById('video'),c=document.getElementById('danmaku-canvas');return {t:v.currentTime,paused:v.paused,err:v.error?.message,rs:v.readyState,cw:c.clientWidth,ch:c.clientHeight,status:document.getElementById('danmaku-status').textContent,n:window.__samples.length};}));
  const result=await page.evaluate(()=>({samples:window.__samples,width:document.getElementById('danmaku-canvas').clientWidth}));
  await ctx.close();
  const s=result.samples.filter((p,i,a)=>i===0||p.t!==a[i-1].t),speed=result.width/7,steps=[];
  for(let i=1;i<s.length;i++){const dt=(s[i].t-s[i-1].t)/1000,dx=s[i-1].x-s[i].x;steps.push({dt,dx,err:Math.abs(dx-speed*dt)});}
  const moving=steps.filter(x=>x.dx>0.5),stalls=steps.length-moving.length,v=moving.map(x=>x.dx/x.dt),mean=v.reduce((a,b)=>a+b,0)/v.length;
  const cv=Math.sqrt(v.reduce((a,b)=>a+(b-mean)**2,0)/v.length)/mean;
  const backwards=steps.filter(x=>x.dx<-0.5).length;
  return {frames:s.length,fps:+(s.length/((s.at(-1).t-s[0].t)/1000)).toFixed(1),
    stalledFrames:(100*stalls/steps.length).toFixed(1)+'%',backwards,maxJumpPx:+Math.max(...steps.map(x=>x.dx)).toFixed(1),
    idealStepPx:+(speed/60).toFixed(1),speedVariation:(100*cv).toFixed(1)+'%',meanPositionErrorPx:+(steps.reduce((a,b)=>a+b.err,0)/steps.length).toFixed(2)};
}
const table={};
for(const file of files)for(const tv of [false,true])table[file+(tv?' · TV emulation':' · desktop')]=await measure(file,tv);
console.table(table);
await browser.close();
