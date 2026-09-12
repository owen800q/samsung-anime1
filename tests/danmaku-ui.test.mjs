import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const script=await readFile(new URL('../src/danmaku.js',import.meta.url),'utf8');
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(){
 const draws=[],nodes=new Map(),requests=[],stored=new Map(),frames=new Map();let fid=0;
 const context={clearRect(){draws.length=0;},setTransform(){},measureText:s=>({width:s.length*12}),strokeText(){},fillText(text,x,y){draws.push({text,x,y});}};
 class El extends EventTarget{constructor(){super();this.hidden=false;this.value='';this.textContent='';this.children=[];this.attrs={};}setAttribute(k,v){this.attrs[k]=v;}append(x){this.children.push(x);}replaceChildren(){this.children=[];}querySelector(){return this.children[0];}focus(){}getContext(){return context;}}
 const get=id=>{if(!nodes.has(id))nodes.set(id,new El());return nodes.get(id);};
 const video=get('video');Object.assign(video,{currentTime:0,duration:1500,paused:true,ended:false});Object.assign(get('danmaku-canvas'),{clientWidth:900,clientHeight:400,width:900,height:400});
 const document=new EventTarget();document.getElementById=get;document.createElement=()=>new El();document.hidden=false;
 const window=new EventTarget();window.devicePixelRatio=1;
 const source={provider:'bahamut',id:'10',url:'https://ani.gamer.com.tw/animeVideo.php?sn=10',title:'fixture'};
 const entry=(id,src=source)=>({episodeId:id,source:src,offset:0,revision:1});stored.set('1',entry('1'));stored.set('2',entry('2',{...source,id:'20',url:'https://ani.gamer.com.tw/animeVideo.php?sn=20'}));
 const hook={fetch:null,settings:null};
 window.TVState={danmakuSettings:async(id,data)=>{if(hook.settings)return hook.settings(id,data);if(data)stored.set(id,{...data,revision:data.revision+1});return Response.json({entry:stored.get(id)||{episodeId:id,source:null,offset:0,revision:0}});}};
 const fetch=async url=>{requests.push(url);if(hook.fetch)return hook.fetch(url);return Response.json({comments:[{time:1,mode:1,color:'#ffffff',text:'<script>literal</script>'},{time:361,mode:5,color:'#ffffff',text:'later'}]});};
 const sandbox={window,document,localStorage:{getItem(){return null;},setItem(){}},fetch,AbortController,AbortSignal,setInterval(){},requestAnimationFrame:fn=>{frames.set(++fid,fn);return fid;},cancelAnimationFrame:id=>frames.delete(id)};
 vm.runInNewContext(script,sandbox);
 const fire=(id,type)=>get(id).dispatchEvent(new Event(type,{cancelable:true}));
 return {get,video,draws,requests,stored,source,entry,hook,window,document,frames,fire,open:(info,extra={})=>window.TVDanmaku.open({episodeId:String(info),title:'fixture [01]',seriesTitle:'fixture',...extra})};
}
test('canvas follows video time, pauses without advancing, supports seek, offset and toggling',async()=>{
 const f=fixture();await f.open(1);await flush();f.video.currentTime=2;f.fire('video','seeked');
 assert.equal(f.draws[0].text,'<script>literal</script>');const x=f.draws[0].x;
 f.fire('video','pause');assert.equal(f.draws[0].x,x,'wall time does not move paused comments');
 f.video.currentTime=3;f.fire('video','seeked');assert.ok(f.draws[0].x<x);
 f.get('danmaku-offset').value='4';f.fire('danmaku-offset-form','submit');await flush();await flush();assert.equal(f.stored.get('1').offset,4);assert.equal(f.draws.length,0);
 f.video.currentTime=6;f.fire('video','seeked');assert.ok(f.draws.length);
 f.fire('danmaku-toggle','click');assert.equal(f.draws.length,0);assert.equal(f.get('danmaku-toggle').attrs['aria-pressed'],'false');
 f.fire('danmaku-toggle','click');assert.ok(f.draws.length);
 f.window.TVDanmaku.stop();assert.equal(f.draws.length,0);
});
test('switching episodes ignores delayed comments and delayed settings from previous episode',async()=>{
 const f=fixture();let release;
 f.hook.fetch=url=>url.includes('id=10&')?new Promise(r=>release=()=>r(Response.json({comments:[{time:1,mode:1,color:'#fff',text:'OLD'}]}))):Promise.resolve(Response.json({comments:[{time:1,mode:1,color:'#ffffff',text:'NEW'}]}));
 await f.open(1);await f.open(2);await flush();release();await flush();f.video.currentTime=2;f.fire('video','seeked');assert.deepEqual(f.draws.map(x=>x.text),['NEW']);
 let settingsRelease;f.hook.settings=id=>id==='1'?new Promise(r=>settingsRelease=()=>r(Response.json({entry:f.entry('1')}))):Promise.resolve(Response.json({entry:f.stored.get(id)}));
 const opening=f.open(1);await f.open(2);settingsRelease();await opening;await flush();assert.equal(f.get('danmaku-source-link').href,f.stored.get('2').source.url);
});
test('Bilibili seeks load correct segment, avoid repeat requests and retry failed segments',async()=>{
 const f=fixture();f.stored.set('1',f.entry('1',{provider:'bilibili',id:'100',url:'https://www.bilibili.com/video/BV1xx411c7mD?p=1',title:'bili'}));
 let denied=true;f.hook.fetch=async url=>url.endsWith('segment=2')&&denied?Response.json({error:'source unavailable'},{status:502}):Response.json({comments:[{time:361,mode:1,color:'#ffffff',text:'segment two'}]});
 await f.open(1);await flush();f.video.currentTime=400;f.fire('video','seeked');await flush();assert.equal(f.get('danmaku-retry').hidden,false);
 const n=f.requests.length;f.fire('video','timeupdate');await flush();assert.equal(f.requests.length,n,'failed request does not repeat on every timeupdate');
 denied=false;f.fire('danmaku-retry','click');await flush();assert.ok(f.requests.at(-1).endsWith('segment=2'));
 f.video.currentTime=362;f.fire('video','seeked');await flush();assert.ok(f.draws.some(x=>x.text==='segment two'));
});
test('a delayed refresh cannot replace a newer saved offset',async()=>{
 const f=fixture();await f.open(1);await flush();let release;
 f.hook.settings=async(id,data)=>{if(data){const entry={...data,revision:2};f.stored.set(id,entry);return Response.json({entry});}return new Promise(r=>release=()=>r(Response.json({entry:f.entry(id)})));};
 f.window.dispatchEvent(new Event('focus'));f.get('danmaku-offset').value='8';f.fire('danmaku-offset-form','submit');await flush();release();await flush();
 assert.equal(f.get('danmaku-offset').value,'8');
});
test('unmatched episodes show source selection; settings failure exposes retry',async()=>{
 const f=fixture();await f.open(3);assert.match(f.get('danmaku-status').textContent,/未配對/);assert.equal(f.requests.length,0);
 f.hook.settings=async()=>Response.json({error:'offline'},{status:503});await f.open(1);assert.equal(f.get('danmaku-retry').hidden,false);assert.match(f.get('danmaku-status').textContent,/offline/);
});

test('automatic pairing requires exact title, year and episode; no match for another year',async()=>{
 for(const year of ['2026','2025']){
  const f=fixture();f.hook.fetch=async url=>{
   if(url.includes('catalog-item'))return Response.json({item:{title:'fixture',year:'2026',aliases:[]}});
   if(url.includes('/search?'))return Response.json({results:[{title:'fixture',url:f.source.url}]});
   if(url.includes('/resolve?'))return Response.json({title:'fixture',year,episodes:[{...f.source,label:'1'}]});
   return Response.json({comments:[]});
  };
  await f.open(3,{seriesId:'1959'});for(let i=0;i<5;i++)await flush();
  assert.equal(Boolean(f.stored.get('3')?.source),year==='2026');
 }
});
