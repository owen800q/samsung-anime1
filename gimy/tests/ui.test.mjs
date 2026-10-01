import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM,VirtualConsole} from 'jsdom';
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
test('UI opens slug episodes, preserves deep links, shows blocked-source errors and exposes pairing/history without missing controls',async()=>{
  const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>{if(!/Not implemented/.test(e.message))errors.push(e.message);});
  const dom=new JSDOM(await readFile(new URL('../src/index.html',import.meta.url),'utf8'),{url:'https://app.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console});
  const w=dom.window,$=id=>w.document.getElementById(id);w.AbortSignal=AbortSignal;w.AbortController=AbortController;
  w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLMediaElement.prototype.load=()=>{};w.HTMLMediaElement.prototype.pause=()=>{};w.HTMLCanvasElement.prototype.getContext=()=>({clearRect(){},measureText:()=>({width:100})});
  const calls=[];w.fetch=async(input,init={})=>{const path=String(input);calls.push({path,init});
    if(path==='/api/history')return Response.json(init.method==='PUT'?{entry:{...JSON.parse(init.body),revision:1}}:{entries:[]});
    if(path.startsWith('/api/catalog'))return Response.json({error:'Gimy 要求驗證。',code:'SOURCE_BLOCKED'},{status:502});
    if(path.startsWith('/api/remote'))return Response.json({seq:0,devices:[],commands:[]});
    if(path.startsWith('/api/episodes'))return Response.json({title:'測試電影',episodes:[{title:'正片',url:'https://gimytv.io/eps/202653122-zheng-pian.html'},{title:'下一集',url:'https://gimytv.io/eps/202653122-2.html'}]});
    if(path==='/api/resolve')return Response.json({error:'Gimy 拒絕了伺服器連線。',code:'SOURCE_BLOCKED'},{status:502});
    if(path==='/api/pairing/create')return Response.json({sessionId:'b'.repeat(32),code:'123456',expiresAt:Date.now()+300000});
    if(path==='/api/pairing/status')return Response.json({status:'pending'});
    if(path==='/api/pairing/cancel')return Response.json({ok:true});
    return Response.json({});
  };
  w.TVPlayer={leave:async()=>{},contains:()=>false,isExpanded:()=>false,unloadMedia(){},loadMedia(){}};
  w.TVDanmaku={stop(){},open(){}};w.TVQRCode=()=>{};
  for(const name of ['state.js','pairing.js','remote.js','app.js','home.js'])w.eval(await readFile(new URL('../src/'+name,import.meta.url),'utf8'));
  try{
    await tick();assert.equal($('catalog-error').hidden,false);assert.match($('catalog-error').textContent,/驗證/);
    $('open-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();
    assert.equal($('watch-player').hidden,false);assert.equal($('error').hidden,false);assert.match($('error').textContent,/拒絕/);assert.match(w.location.hash,/202653122-zheng-pian/);
    assert.equal(JSON.parse(calls.find(x=>x.path==='/api/resolve').init.body).url,'https://gimytv.io/eps/202653122-zheng-pian.html');
    assert.equal(w.document.querySelectorAll('.episode-button').length,2);
    $('sync-toggle').click();assert.equal($('sync-panel').hidden,false);$('pair-create').click();await tick();assert.equal($('pair-digits').textContent,'123 456');assert.equal($('pair-wait').hidden,false);
    $('pair-close').click();await tick();assert.equal($('sync-panel').hidden,true);
    $('home-back').click();await tick();w.document.querySelector('[data-preset="history"]').click();await tick();assert.equal($('watch-history').hidden,false);
    const p=w.TVState.profile();assert.equal(JSON.parse(w.localStorage.getItem('gimy-profile')),p);assert.equal(w.localStorage.getItem('anime1-profile'),null);
    assert.deepEqual(errors,[]);
  }finally{dom.window.close();}
});
test('vendored DPlayer mounts the live video and HLS adapter reuses it across sources',async()=>{
  const vc=new VirtualConsole(),errors=[];vc.on('jsdomError',e=>{if(!/Not implemented/.test(e.message))errors.push(e.message);});
  const dom=new JSDOM(await readFile(new URL('../src/index.html',import.meta.url),'utf8'),{url:'https://app.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=dom.window;w.scrollTo=()=>{};w.HTMLMediaElement.prototype.load=()=>{};w.HTMLMediaElement.prototype.pause=()=>{};
  w.eval(await readFile(new URL('../src/vendor/dplayer-1.27.1.min.js',import.meta.url),'utf8'));
  w.eval(await readFile(new URL('../src/player.js',import.meta.url),'utf8'));
  try{
    const video=w.document.getElementById('video');assert.ok(video);assert.equal(w.document.querySelectorAll('#video').length,1);
    w.TVPlayer.loadMedia('/api/media?token=test','mp4');assert.equal(video.getAttribute('src'),'/api/media?token=test');
    let attached,source,destroyed=0;
    w.Hls=class{static isSupported(){return true;}static Events={ERROR:'error'};on(){}loadSource(value){source=value;}attachMedia(value){attached=value;}destroy(){destroyed++;}};
    w.TVPlayer.loadMedia('/api/media?token=hls','hls');assert.equal(attached,video);assert.equal(source,'/api/media?token=hls');
    w.TVPlayer.loadMedia('/api/media?token=next','mp4');assert.equal(destroyed,1);assert.equal(video.getAttribute('src'),'/api/media?token=next');
    assert.deepEqual(errors,[]);
  }finally{dom.window.close();}
});
