import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const code=readFileSync(new URL('../src/player.js',import.meta.url),'utf8');
function setup(request){
  class Element extends EventTarget{
    constructor(){super();this.children=[];this.isConnected=true;this.attrs={};const classes=new Set();this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)};}
    append(...nodes){this.children.push(...nodes);}
    setAttribute(k,v){this.attrs[k]=v;}removeAttribute(k){delete this.attrs[k];}
    querySelector(){return null;}contains(x){return this.children.includes(x);}
    focus(){document.activeElement=this;}
  }
  const nodes=Object.fromEntries(['screen','danmaku-canvas','empty','fullscreen'].map(id=>[id,new Element()]));
  const document=new EventTarget();document.getElementById=id=>nodes[id];document.createElement=()=>new Element();document.body=new Element();document.activeElement=nodes.fullscreen;
  document.exitFullscreen=async()=>{document.fullscreenElement=null;document.dispatchEvent(new Event('fullscreenchange'));};
  nodes.screen.requestFullscreen=request&&function(){return request(document,this);};
  const window=new EventTarget();window.scrollX=3;window.scrollY=120;window.scrollTo=(x,y)=>{window.restored={x,y};};
  let player,draws=0;window.addEventListener('resize',()=>draws++);
  function DPlayer(opts){player=this;this.video=new Element();opts.container.append(this.video);this.fullScreen={};this.resize=()=>{};this.controller={show(){}};}
  vm.runInNewContext(code,{window,document,DPlayer,Event});
  return {nodes,document,window,player,draws:()=>draws,exit:nodes.screen.children.at(-1)};
}
test('fullscreen requests the DPlayer container containing both video and canvas',async()=>{
  let target;const s=setup(async(doc,el)=>{target=el;doc.fullscreenElement=el;});
  await s.player.fullScreen.request();assert.equal(target,s.nodes.screen);
  assert.ok(target.contains(s.player.video));assert.ok(target.contains(s.nodes['danmaku-canvas']));
  assert.equal(s.exit.hidden,false);assert.ok(s.draws()>0);
  await s.player.fullScreen.cancel();assert.equal(s.document.fullscreenElement,null);assert.equal(s.exit.hidden,true);
});
test('denied fullscreen falls back without replacing video, canvas or playback time',async()=>{
  const s=setup(async()=>{throw new Error('denied')});s.player.video.currentTime=347;
  await s.player.fullScreen.toggle('browser');assert.ok(s.nodes.screen.classList.contains('dplayer-fulled'));
  assert.equal(s.player.video.currentTime,347);assert.ok(s.nodes.screen.contains(s.nodes['danmaku-canvas']));
  s.exit.dispatchEvent(new Event('click'));await Promise.resolve();
  assert.equal(s.nodes.screen.classList.contains('dplayer-fulled'),false);assert.equal(s.document.body.classList.contains('dplayer-web-fullscreen-fix'),false);
  assert.equal(s.document.activeElement,s.nodes.fullscreen);assert.equal(s.window.restored.y,120);
});
test('iPhone without container fullscreen uses web mode, never native video fullscreen',async()=>{
  const s=setup();s.player.video.webkitEnterFullscreen=()=>assert.fail('video-only fullscreen loses canvas');
  await s.player.fullScreen.request();assert.ok(s.window.TVPlayer.isExpanded());
  const e=new Event('keydown',{cancelable:true});Object.defineProperty(e,'keyCode',{value:10009});s.document.dispatchEvent(e);
  assert.equal(e.defaultPrevented,true);assert.equal(s.window.TVPlayer.isExpanded(),false);
});
test('explicit web fullscreen and Escape preserve paused overlay redraw',async()=>{
  const s=setup(()=>assert.fail('web mode must not request browser fullscreen'));
  await s.player.fullScreen.request('web');const before=s.draws();
  const e=new Event('keydown',{cancelable:true});Object.defineProperty(e,'key',{value:'Escape'});s.document.dispatchEvent(e);
  assert.ok(s.draws()>before);assert.equal(s.exit.hidden,true);
});
test('late rejected fullscreen request cannot reopen player after navigation',async()=>{
  let reject;const s=setup(()=>new Promise((_,r)=>{reject=r}));const pending=s.player.fullScreen.request();
  await s.window.TVPlayer.leave();reject(new Error('denied'));await pending;assert.equal(s.window.TVPlayer.isExpanded(),false);
});
test('vendored DPlayer styles match explicit CSP hashes without allowing arbitrary inline styles',()=>{
  const styles=[];const head={appendChild:x=>styles.push(x)};
  const document={baseURI:'https://example.com/',querySelector:()=>head,createTextNode:textContent=>({textContent}),
    createElement:()=>({href:'https://example.com/',protocol:'https:',host:'example.com',pathname:'/',search:'',hash:'',hostname:'example.com',port:'',setAttribute(){},appendChild(x){this.text=(this.text||'')+x.textContent;},style:{}})};
  const context={self:{},window:{navigator:{userAgent:'Node'},location:{href:'https://example.com/'}},document,navigator:{userAgent:'Node'},btoa:s=>Buffer.from(s,'binary').toString('base64'),URL,console,setTimeout:()=>0,clearTimeout(){}};
  vm.runInNewContext(readFileSync(new URL('../src/vendor/dplayer-1.27.1.min.js',import.meta.url),'utf8'),context);
  const headers=readFileSync(new URL('../src/_headers',import.meta.url),'utf8');assert.equal(styles.length,2);
  for(const style of styles){const hash=createHash('sha256').update(style.text).digest('base64');assert.ok(headers.includes('sha256-'+hash));}
  assert.ok(!headers.includes("'unsafe-inline'"));assert.equal(typeof context.self.DPlayer,'function');
});
