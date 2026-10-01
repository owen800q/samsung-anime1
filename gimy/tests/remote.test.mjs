import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteRoute, remoteCommand} from '../src/remote-server.js';
import {WatchHistory} from '../src/sync-server.js';
import {makeEnv, MemoryStorage} from './helpers/pairing-storage.mjs';
const A='a'.repeat(32), B='b'.repeat(32), TV='1'.repeat(32), PHONE='2'.repeat(32), OTHER='3'.repeat(32);
function api(env,action,data,token=A,headers={}){
  return remoteRoute(new Request('https://site.test/api/remote/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,...headers},body:JSON.stringify(data)}),env);
}
const json=async response=>(await response).json();
const tv={device:TV,name:'客廳電視',kind:'tv'}, phone={device:PHONE,name:'我的手機',kind:'phone'};
const play={type:'play',episodeId:'29599',seriesId:'1959',title:'動畫 [03]',seriesTitle:'動畫'};
const playing={episodeId:'29599',title:'動畫 [03]',position:120,duration:1400,paused:false,hasPrevious:false,hasNext:true};

test('remote routes require bearer auth, POST JSON, known actions and a configured store',async()=>{
  const {env}=makeEnv();
  assert.equal((await api(env,'poll',tv,'')).status,401);
  assert.equal((await api(env,'nope',tv)).status,404);
  assert.equal((await api({},'poll',tv)).status,503);
  assert.equal((await api(env,'poll',tv,A,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await api(env,'poll',{...tv,name:'x'.repeat(2100)})).status,413);
  assert.equal((await api(env,'poll',{device:'nope'})).status,400);
  assert.equal((await remoteRoute(new Request('https://site.test/api/remote/poll'),env)).status,405);
  assert.equal((await remoteRoute(new Request('https://site.test/api/remote/socket'),env)).status,426);
  const upgrade=protocol=>remoteRoute(new Request('https://site.test/api/remote/socket?device='+TV,{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':protocol}}),env);
  assert.equal((await upgrade('gimy-remote.v1')).status,401);
  assert.equal((await upgrade(A)).status,401);
  assert.equal((await upgrade('gimy-remote.v1, '+A)).status,501);
});
test('commands are validated strictly',()=>{
  assert.deepEqual(remoteCommand(play),play);
  assert.deepEqual(remoteCommand({type:'seek',delta:-10}),{type:'seek',delta:-10});
  assert.deepEqual(remoteCommand({type:'next',extra:1}),{type:'next'});
  for(const bad of [null,{type:'play',episodeId:'x'},{type:'play',episodeId:'1',seriesId:'<b>'},{type:'seek',delta:0},{type:'seek',delta:601},{type:'seek',delta:'10'},{type:'eval'}])assert.equal(remoteCommand(bad),null);
  assert.equal(remoteCommand({...play,title:'a\u0000b'.repeat(200)}).title.length,350);
});
test('a phone sees the TV on the same profile, sends a play command, and the TV receives it once',async()=>{
  const {env}=makeEnv();
  const first=await json(api(env,'poll',{...tv,since:null}));
  assert.deepEqual(first.commands,[]);
  const seen=await json(api(env,'poll',{...phone,since:null}));
  assert.deepEqual(seen.devices.map(d=>[d.name,d.kind]).sort(),[['客廳電視','tv'],['我的手機','phone']]);
  const sent=await api(env,'send',{...phone,target:TV,command:play});
  assert.equal(sent.status,202);assert.equal((await sent.json()).target.name,'客廳電視');
  const next=await json(api(env,'poll',{...tv,since:first.seq}));
  assert.deepEqual(next.commands.map(x=>[x.command,x.from.name]),[[play,'我的手機']]);
  assert.deepEqual((await json(api(env,'poll',{...tv,since:next.seq}))).commands,[]);
  assert.deepEqual((await json(api(env,'poll',{...phone,since:seen.seq}))).commands,[]);
});
test('remote control never crosses profiles, targets itself or reaches offline screens',async()=>{
  const {env,stores}=makeEnv();
  await api(env,'poll',tv);await api(env,'poll',phone,B);
  assert.equal((await api(env,'send',{...phone,target:TV,command:play},B)).status,404);
  assert.equal((await api(env,'send',{...tv,target:TV,command:play})).status,404);
  assert.equal((await api(env,'send',{...phone,target:TV,command:{type:'rm'}})).status,400);
  const [name]=[...stores.keys()].filter(key=>key!=='pairing:v1'&&stores.get(key).data.has('remote')&&stores.get(key).data.get('remote').devices[TV]);
  const state=await stores.get(name).get('remote');state.devices[TV].seenAt=Date.now()-60000;await stores.get(name).put('remote',state);
  const offline=await api(env,'send',{...phone,target:TV,command:play});
  assert.equal(offline.status,409);assert.match((await offline.json()).error,/客廳電視/);
});
test('queued commands expire instead of replaying an old play request',async()=>{
  const {env,stores}=makeEnv();const first=await json(api(env,'poll',tv));await api(env,'poll',phone);
  await api(env,'send',{...phone,target:TV,command:play});
  for(const store of stores.values()){const state=await store.get('remote');if(state?.queue?.length){state.queue[0].at=Date.now()-31000;await store.put('remote',state);}}
  assert.deepEqual((await json(api(env,'poll',{...tv,since:first.seq}))).commands,[]);
});
test('now-playing state is validated and shared with other devices; null clears it',async()=>{
  const {env}=makeEnv();await api(env,'poll',phone);
  assert.equal((await api(env,'state',{...tv,state:{...playing,position:-1}})).status,400);
  assert.equal((await api(env,'state',{...tv,state:{...playing,duration:0}})).status,400);
  const shared=await json(api(env,'state',{...tv,state:{...playing,title:'<img src=x>',extra:'dropped'}}));
  const screen=shared.devices.find(d=>d.id===TV);
  assert.deepEqual(screen.state,{...playing,title:'<img src=x>'});
  assert.equal((await json(api(env,'poll',phone))).devices.find(d=>d.id===TV).state.position,120);
  await api(env,'state',{...tv,state:null});
  assert.equal((await json(api(env,'poll',phone))).devices.find(d=>d.id===TV).state,null);
});
test('device lists stay bounded',async()=>{
  const {env}=makeEnv();
  for(let i=0;i<25;i++)await api(env,'poll',{device:i.toString(16).padStart(32,'0'),kind:'phone'});
  assert.equal((await json(api(env,'poll',tv))).devices.length,20);
});

class FakeSocket{
  constructor(){this.sent=[];this.readyState=1;this.attachment=null;}
  send(text){this.sent.push(text);} close(){this.readyState=3;}
  serializeAttachment(value){this.attachment=value;} deserializeAttachment(){return this.attachment;}
  messages(){return this.sent.filter(x=>x!=='pong').map(x=>JSON.parse(x));}
}
function socketHub(){
  globalThis.WebSocketPair=function(){return {0:new FakeSocket(),1:new FakeSocket()};};
  const accepted=[];
  const ctx={storage:new MemoryStorage(),acceptWebSocket(ws,tags){ws.tags=tags;accepted.push(ws);},getWebSockets(tag){return accepted.filter(ws=>!tag||ws.tags.includes(tag));}};
  return {history:new WatchHistory(ctx,{}),accepted};
}
test('WebSocket clients are tagged per device, get pushed commands and presence, and go offline on close',async()=>{
  const {history,accepted}=socketHub();
  try{
    await history.remote.open({id:TV,name:'客廳電視',kind:'tv'},null);
    const tvSocket=accepted[0],hello=tvSocket.messages()[0];
    assert.equal(hello.type,'hello');assert.deepEqual(hello.commands,[]);
    await history.remote.open({id:PHONE,name:'我的手機',kind:'phone'},null);
    const phoneSocket=accepted[1];
    assert.deepEqual(tvSocket.messages().at(-1).devices.map(d=>d.id).sort(),[TV,PHONE]);
    const post=(path,data)=>history.fetch(new Request('https://history.internal/remote/'+path,{method:'POST',body:JSON.stringify(data)}));
    assert.equal((await post('send',{...phone,target:TV,command:{type:'toggle'}})).status,202);
    const pushed=tvSocket.messages().at(-1);
    assert.equal(pushed.type,'command');assert.deepEqual(pushed.command,{type:'toggle'});assert.equal(pushed.from.name,'我的手機');
    assert.equal(phoneSocket.messages().some(x=>x.type==='command'),false);
    await post('state',{...tv,state:playing});
    assert.equal(phoneSocket.messages().at(-1).devices.find(d=>d.id===TV).state.position,120);
    await history.webSocketMessage(phoneSocket,'ping');assert.equal(phoneSocket.sent.at(-1),'pong');
    await history.webSocketMessage(phoneSocket,JSON.stringify({type:'devices'}));assert.equal(phoneSocket.messages().at(-1).devices.length,2);
    tvSocket.readyState=3;await history.webSocketClose(tvSocket);
    assert.deepEqual(phoneSocket.messages().at(-1).devices.map(d=>d.id),[PHONE]);
    assert.equal((await post('send',{...phone,target:TV,command:{type:'toggle'}})).status,409);
    await history.remote.open({id:TV,name:'客廳電視',kind:'tv'},pushed.seq-1);
    assert.deepEqual(accepted[2].messages()[0].commands.map(x=>x.seq),[pushed.seq]);
  }finally{delete globalThis.WebSocketPair;}
});

