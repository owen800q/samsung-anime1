import test from 'node:test';
import assert from 'node:assert/strict';
import {pairingRoute} from '../src/pairing-server.js';
import {historyRoute} from '../src/sync-server.js';
import {makeEnv, profileName, progress} from './helpers/pairing-storage.mjs';
const A='a'.repeat(32), B='b'.repeat(32), C='c'.repeat(32), secret='d'.repeat(64);
function api(env, action, data, token=A, headers={}) {
  return pairingRoute(new Request('https://site.test/api/pairing/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'CF-Connecting-IP':'192.0.2.1',...headers},body:JSON.stringify(data)}),env);
}
const json=async response=>(await response).json();
const create=env=>json(api(env,'create',{secret}));
const accept=(env,s)=>api(env,'accept',{sessionId:s.sessionId,secret});
async function seed(env,token,entries,settings=[]) {
  const store=env.WATCH_HISTORY.get(await profileName(token)).storage;
  for(const entry of entries)await store.put('ep:'+entry.episodeId,entry);
  await store.put('index',entries.map(x=>({id:x.episodeId})));
  for(const entry of settings)await store.put('dm:'+entry.episodeId,entry);
  await store.put('dm-index',settings.map(x=>x.episodeId));return store;
}
test('pairing requires same-origin POST, bearer auth, JSON and a bounded body',async()=>{
  const {env}=makeEnv();
  assert.equal((await api(env,'create',{secret},'')).status,401);
  assert.equal((await api(env,'create',{secret},A,{Origin:'https://evil.test'})).status,403);
  assert.equal((await api(env,'create',{secret},A,{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await api(env,'create',{secret},A,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await api(env,'create',{secret,huge:'x'.repeat(2200)})).status,413);
  assert.equal((await api(env,'create',{secret})).status,201);
  assert.equal((await pairingRoute(new Request('https://site.test/api/pairing/create'),env)).status,405);
  assert.equal((await api({},'create',{secret})).status,503);
  assert.equal((await api(env,'export',{})).status,404);
  assert.equal((await api(env,'create',{})).status,400);
});
test('invitations expire in five minutes, retry safely and do not expose permanent credentials',async()=>{
  const {env}=makeEnv(),before=Date.now(),r=await api(env,'create',{secret}),session=await r.json();
  assert.equal(r.headers.get('cache-control'),'no-store');
  assert.match(session.code,/^\d{6}$/);assert.match(session.ticket,/^[a-f0-9]{48}$/);
  assert.ok(session.expiresAt>=before+300000&&session.expiresAt<=Date.now()+300000);
  assert.equal(JSON.stringify(session).includes(A),false);assert.equal(session.secret,undefined);
  assert.deepEqual(await create(env),session);
});
test('a QR preview is bound to explicit approval and never returns the long-term profile',async()=>{
  const {env}=makeEnv();await seed(env,A,[progress()]);const s=await create(env);
  const p=await json(api(env,'preview',{ticket:s.ticket},B));
  assert.equal(p.sourceCount,1);assert.equal(p.destinationCount,0);assert.equal(p.code,s.code);
  assert.equal(JSON.stringify(p).includes(A),false);assert.equal(JSON.stringify(p).includes(B),false);
  assert.equal((await api(env,'approve',{sessionId:s.sessionId},B)).status,409);
  assert.equal((await api(env,'approve',{sessionId:s.sessionId,confirmation:p.confirmation},C)).status,409);
  assert.equal((await json(api(env,'status',{sessionId:s.sessionId,secret}))).status,'pending');
});
test('short code pairing merges both histories by latest save, not furthest position, and settings',async()=>{
  const {env}=makeEnv(),now=Date.now();
  const dm={episodeId:'29599',source:null,offset:2,revision:2,updatedAt:now-1000};
  const oldSource=await seed(env,A,[progress('29599',1000,now-5000),progress('29605',70,now-1000)],[dm]);
  const destination=await seed(env,B,[progress('29599',20,now-1000),progress('29606',60,now-2000)]);
  const s=await create(env),p=await json(api(env,'preview',{code:s.code},B));
  assert.equal(p.sourceCount,2);assert.equal(p.destinationCount,2);
  const approve={sessionId:s.sessionId,confirmation:p.confirmation};
  const approved=await json(api(env,'approve',approve,B));
  assert.equal(approved.status,'approved');assert.match(approved.verify,/^\d{2}$/);
  assert.deepEqual(await json(api(env,'approve',approve,B)),approved);
  assert.equal((await destination.get('index')).length,2);
  assert.deepEqual(await json(api(env,'status',{sessionId:s.sessionId,secret})),{status:'approved',verify:approved.verify,destinationCount:2,alreadyLinked:false});
  assert.equal((await accept(env,s)).status,200);
  assert.equal((await destination.get('index')).length,3);
  assert.equal((await destination.get('ep:29599')).position,20);
  assert.equal((await destination.get('ep:29605')).updatedAt,now-1000);
  assert.equal((await destination.get('dm:29599')).offset,2);
  assert.equal((await oldSource.get('ep:29599')).position,1000);
  assert.equal((await api(env,'status',{sessionId:s.sessionId,secret:'e'.repeat(64)})).status,403);
  assert.equal((await api(env,'status',{sessionId:s.sessionId,secret},B)).status,403);
  assert.equal((await api(env,'accept',{sessionId:s.sessionId,secret},B)).status,403);
  assert.equal((await json(accept(env,s))).profile,B);
  assert.equal((await json(api(env,'status',{sessionId:s.sessionId,secret}))).profile,undefined);
  assert.equal((await api(env,'cancel',{sessionId:s.sessionId,secret})).status,409);
  assert.equal((await api(env,'ack',{sessionId:s.sessionId,secret})).status,200);
  assert.equal((await json(api(env,'status',{sessionId:s.sessionId,secret}))).profile,undefined);
  assert.equal((await api(env,'preview',{code:s.code},C)).status,410);
});
test('cancelled, invalid and expired codes cannot be used; expiry is not silently renewed',async()=>{
  const {env,stores}=makeEnv();const s=await create(env);
  assert.equal((await api(env,'preview',{code:'123'},B)).status,400);
  assert.equal((await api(env,'preview',{ticket:'f'.repeat(48)},B)).status,410);
  assert.equal((await api(env,'cancel',{sessionId:s.sessionId,secret})).status,200);
  assert.equal((await api(env,'preview',{code:s.code},B)).status,410);
  const next=await json(api(env,'create',{secret:'e'.repeat(64)}));
  const store=stores.get('pairing:v1'),entry=await store.get('session:'+next.sessionId);
  entry.expiresAt=Date.now()-1;await store.put('session:'+next.sessionId,entry);
  assert.equal((await api(env,'status',{sessionId:next.sessionId,secret:'e'.repeat(64)})).status,410);
});
test('IP-based guess limits cannot be bypassed by rotating anonymous profile tokens',async()=>{
  const {env}=makeEnv();
  for(let i=0;i<30;i++)assert.equal((await api(env,'preview',{code:'000000'},i.toString(16).padStart(32,'0'))).status,410);
  assert.equal((await api(env,'preview',{code:'000000'},B)).status,429);
  assert.equal((await api(env,'preview',{code:'000000'},B,{'CF-Connecting-IP':'192.0.2.2'})).status,410);
});
test('concurrent confirmations cannot swap the approved destination twice',async()=>{
  const {env}=makeEnv();const s=await create(env);
  const p1=await json(api(env,'preview',{code:s.code},B)),p2=await json(api(env,'preview',{code:s.code},C));
  const results=await Promise.all([api(env,'approve',{sessionId:s.sessionId,confirmation:p1.confirmation},B),api(env,'approve',{sessionId:s.sessionId,confirmation:p2.confirmation},C)]);
  assert.deepEqual(results.map(x=>x.status),[409,200]);
  assert.equal((await json(accept(env,s))).profile,C);
});
test('alarm cleanup removes session secrets and indexes but pairing expiry does not expire history',async()=>{
  const {env,stores}=makeEnv();await seed(env,A,[progress()]);
  const s=await create(env),p=await json(api(env,'preview',{code:s.code},B));
  await api(env,'approve',{sessionId:s.sessionId,confirmation:p.confirmation},B);await accept(env,s);
  const store=stores.get('pairing:v1'),session=await store.get('session:'+s.sessionId);
  session.deliveryUntil=Date.now()-1;await store.put('session:'+s.sessionId,session);
  await env.WATCH_HISTORY.get('pairing:v1').alarm();
  assert.equal(await store.get('session:'+s.sessionId),undefined);
  assert.equal(await store.get('code:'+s.code),undefined);
  assert.equal((await store.list({prefix:'qr:'})).size,0);
  assert.equal((await store.list({prefix:'owner:'})).size,0);
  const result=await historyRoute(new Request('https://site.test/api/history',{headers:{Authorization:'Bearer '+B}}),env);
  assert.equal((await result.json()).entries[0].position,234);
});
test('same-profile pairing is harmless and still requires confirmation',async()=>{
  const {env}=makeEnv();await seed(env,A,[progress()]);
  const s=await create(env),p=await json(api(env,'preview',{code:s.code},A));assert.equal(p.alreadyLinked,true);
  await api(env,'approve',{sessionId:s.sessionId,confirmation:p.confirmation},A);
  assert.equal((await json(api(env,'status',{sessionId:s.sessionId,secret}))).alreadyLinked,true);
  assert.equal((await json(accept(env,s))).profile,A);
});
test('a failed import leaves the invitation awaiting acceptance and does not deliver a profile',async()=>{
  const {env}=makeEnv();const s=await create(env),p=await json(api(env,'preview',{code:s.code},B));
  const target=env.WATCH_HISTORY.get(await profileName(B)),original=target.fetch.bind(target);
  target.fetch=request=>new URL(request.url).pathname==='/pairing-import'?Response.json({error:'fixture'},{status:503}):original(request);
  assert.equal((await api(env,'approve',{sessionId:s.sessionId,confirmation:p.confirmation},B)).status,200);
  assert.equal((await accept(env,s)).status,503);
  assert.equal((await json(api(env,'status',{sessionId:s.sessionId,secret}))).status,'approved');
});
test('merge retains the 500 newest episodes without re-dating old entries',async()=>{
  const {env}=makeEnv(),now=Date.now();
  await seed(env,A,Array.from({length:300},(_,i)=>progress(String(i+1),20,now-100000+i)));
  const target=await seed(env,B,Array.from({length:300},(_,i)=>progress(String(i+301),30,now-1000+i)));
  const s=await create(env),p=await json(api(env,'preview',{code:s.code},B));
  await api(env,'approve',{sessionId:s.sessionId,confirmation:p.confirmation},B);await accept(env,s);
  assert.equal((await target.get('index')).length,500);
  assert.equal(await target.get('ep:1'),undefined);
  assert.equal((await target.get('ep:101')).updatedAt,now-99900);
});
test('a guessed code approved by a stranger reads nothing until the requesting screen accepts, and can be rejected',async()=>{
  const {env}=makeEnv();await seed(env,A,[progress()]);const intruder=await seed(env,C,[]);
  const s=await create(env),p=await json(api(env,'preview',{code:s.code},C));
  assert.equal((await api(env,'accept',{sessionId:s.sessionId,secret})).status,409);
  await api(env,'approve',{sessionId:s.sessionId,confirmation:p.confirmation},C);
  assert.equal((await intruder.get('index')).length,0);
  assert.equal((await api(env,'accept',{sessionId:s.sessionId,secret},C)).status,403);
  assert.deepEqual(await json(api(env,'cancel',{sessionId:s.sessionId,secret})),{status:'cancelled'});
  assert.equal((await accept(env,s)).status,409);
  assert.equal((await intruder.get('index')).length,0);
  assert.equal((await api(env,'preview',{code:s.code},B)).status,410);
});
test('an unaccepted approval expires instead of waiting indefinitely',async()=>{
  const {env,stores}=makeEnv();const s=await create(env),p=await json(api(env,'preview',{code:s.code},B));
  await api(env,'approve',{sessionId:s.sessionId,confirmation:p.confirmation},B);
  const store=stores.get('pairing:v1'),session=await store.get('session:'+s.sessionId);
  assert.ok(session.deliveryUntil>Date.now()+60000&&session.deliveryUntil<=Date.now()+120000);
  session.deliveryUntil=Date.now()-1;await store.put('session:'+s.sessionId,session);
  assert.equal((await accept(env,s)).status,410);
});
test('a slow merge on one invitation does not block other invitations',async()=>{
  const {env}=makeEnv();const s=await create(env),p=await json(api(env,'preview',{code:s.code},B));
  await api(env,'approve',{sessionId:s.sessionId,confirmation:p.confirmation},B);
  const target=env.WATCH_HISTORY.get(await profileName(B)),original=target.fetch.bind(target);let release,reached;
  const importing=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  target.fetch=async request=>{if(new URL(request.url).pathname==='/pairing-import'){reached();await gate;}return original(request);};
  const slow=accept(env,s);await importing;
  const other=await api(env,'create',{secret:'e'.repeat(64)},C);
  assert.equal(other.status,201);
  release();assert.equal((await json(slow)).profile,B);
});
