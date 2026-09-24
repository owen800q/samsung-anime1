import { pairBody, pairHash } from './pairing-server.js';
// Phone-to-TV remote control. Devices on the same sync profile meet in that profile's WATCH_HISTORY object.
const REMOTE_PROTOCOL = 'anime1-remote.v1';
const REMOTE_ONLINE = 25 * 1000;
const REMOTE_COMMAND_TTL = 30 * 1000;
const REMOTE_MAX_DEVICES = 20;
const REMOTE_OPEN = 1;
const remoteJSON = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
const remoteText = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
const remoteNames = {tv: '電視', computer: '電腦', phone: '手機'};
function remoteDevice(data) {
  if (!data || !/^[a-f0-9]{32}$/.test(data.device || '')) return null;
  const kind = Object.hasOwn(remoteNames, data.kind) ? data.kind : 'computer';
  return {id: data.device, kind, name: remoteText(data.name, 40) || remoteNames[kind]};
}
export function remoteCommand(command) {
  if (!command || typeof command !== 'object') return null;
  if (command.type === 'play') {
    if (!/^\d{1,10}$/.test(String(command.episodeId)) || command.seriesId != null && !/^\d{1,10}$/.test(String(command.seriesId))) return null;
    return {type: 'play', episodeId: String(command.episodeId), seriesId: command.seriesId == null ? null : String(command.seriesId), title: remoteText(command.title, 350), seriesTitle: remoteText(command.seriesTitle, 350)};
  }
  if (command.type === 'seek') return Number.isFinite(command.delta) && command.delta !== 0 && Math.abs(command.delta) <= 600 ? {type: 'seek', delta: command.delta} : null;
  return ['toggle', 'next', 'previous'].includes(command.type) ? {type: command.type} : null;
}
// undefined: invalid; null: nothing playing.
function remoteState(state) {
  if (state === null) return null;
  if (!state || typeof state !== 'object' || !/^\d{1,10}$/.test(String(state.episodeId)) || !Number.isFinite(state.position) || state.position < 0 || state.position > 86400) return undefined;
  if (state.duration !== null && !(Number.isFinite(state.duration) && state.duration > 0 && state.duration <= 86400)) return undefined;
  return {episodeId: String(state.episodeId), title: remoteText(state.title, 350), position: state.position, duration: state.duration, paused: state.paused !== false, hasPrevious: state.hasPrevious === true, hasNext: state.hasNext === true};
}
const remoteStub = async (env, token) => env.WATCH_HISTORY.get(env.WATCH_HISTORY.idFromName(await pairHash(token)));
export async function remoteRoute(request, env) {
  const url = new URL(request.url), action = url.pathname.slice('/api/remote/'.length);
  if (action === 'socket') {
    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return remoteJSON({error: '請使用 WebSocket 連線。'}, 426);
    // Browsers cannot set Authorization on a WebSocket; the profile travels as a subprotocol, never in the URL.
    const protocols = (request.headers.get('sec-websocket-protocol') || '').split(',').map(x => x.trim());
    const token = protocols.find(x => /^[a-f0-9]{32}$/.test(x));
    if (!protocols.includes(REMOTE_PROTOCOL) || !token) return remoteJSON({error: '請先啟用此瀏覽器的觀看紀錄。'}, 401);
    if (!env.WATCH_HISTORY) return remoteJSON({error: '雲端同步尚未啟用。'}, 503);
    const target = new URL('https://history.internal/remote/socket');
    for (const key of ['device', 'name', 'kind', 'since']) if (url.searchParams.has(key)) target.searchParams.set(key, url.searchParams.get(key));
    return (await remoteStub(env, token)).fetch(new Request(target, {headers: request.headers}));
  }
  if (request.method !== 'POST') return remoteJSON({error: 'Method not allowed'}, 405);
  if (!['poll', 'send', 'state'].includes(action)) return remoteJSON({error: '找不到遙控功能。'}, 404);
  const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{32})$/)?.[1];
  if (!token) return remoteJSON({error: '請先啟用此瀏覽器的觀看紀錄。'}, 401);
  if (!env.WATCH_HISTORY) return remoteJSON({error: '雲端同步尚未啟用。'}, 503);
  try {
    const body = await pairBody(request, '遙控');
    return await (await remoteStub(env, token)).fetch(new Request('https://history.internal/remote/' + action, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}));
  } catch (error) { return remoteJSON({error: error.status ? error.message : '遙控服務暫時未能回應，請重試。'}, error.status || 503); }
}
export class RemoteHub {
  constructor(ctx, storage) { this.ctx = ctx || {}; this.storage = storage; }
  sockets(tag, except) {
    let list = [];
    try { list = this.ctx.getWebSockets?.(tag) || []; } catch {}
    return list.filter(ws => ws !== except && (ws.readyState === undefined || ws.readyState === REMOTE_OPEN));
  }
  async load() { return await this.storage.get('remote') || {seq: 0, devices: {}, queue: []}; }
  async save(state, now) {
    state.queue = state.queue.filter(item => now - item.at < REMOTE_COMMAND_TTL).slice(-50);
    const kept = Object.values(state.devices).sort((a, b) => b.seenAt - a.seenAt).slice(0, REMOTE_MAX_DEVICES);
    state.devices = Object.fromEntries(kept.map(device => [device.id, device]));
    await this.storage.put('remote', state);
  }
  register(state, device, now) {
    const old = state.devices[device.id];
    state.devices[device.id] = {state: null, ...old, ...device, seenAt: now};
    return !old || old.name !== device.name || old.kind !== device.kind;
  }
  list(state, now, except) {
    const live = new Set(this.sockets(undefined, except).map(ws => { try { return ws.deserializeAttachment()?.device; } catch { return null; } }));
    return Object.values(state.devices).filter(d => live.has(d.id) || now - d.seenAt < REMOTE_ONLINE).map(d => ({id: d.id, name: d.name, kind: d.kind, state: d.state || null}));
  }
  pending(state, device, since, now) {
    if (!Number.isInteger(since) || since < 0) return [];
    return state.queue.filter(item => item.target === device && item.seq > since && now - item.at < REMOTE_COMMAND_TTL).map(({seq, from, command}) => ({seq, from, command}));
  }
  broadcast(message, except) {
    const text = JSON.stringify(message);
    for (const ws of this.sockets(undefined, except)) try { ws.send(text); } catch {}
  }
  async fetch(request) {
    const path = new URL(request.url).pathname, now = Date.now();
    if (path === '/remote/socket') return this.connect(request);
    let body; try { body = await request.json(); } catch {}
    const device = remoteDevice(body);
    if (!device) return remoteJSON({error: '裝置資料無效。'}, 400);
    const state = await this.load();
    if (path === '/remote/poll') {
      const changed = this.register(state, device, now); await this.save(state, now);
      const devices = this.list(state, now); if (changed) this.broadcast({type: 'devices', devices});
      return remoteJSON({seq: state.seq, commands: this.pending(state, device.id, body.since, now), devices});
    }
    if (path === '/remote/send') {
      const command = remoteCommand(body.command), target = state.devices[body.target];
      if (!command) return remoteJSON({error: '遙控指令無效。'}, 400);
      if (!target || target.id === device.id) return remoteJSON({error: '找不到這部裝置，請在電視開啟本網站並連接裝置同步。'}, 404);
      this.register(state, device, now);
      if (!this.list(state, now).some(d => d.id === target.id)) return remoteJSON({error: target.name + ' 未連線，請確認已開啟本網站。'}, 409);
      const item = {seq: ++state.seq, target: target.id, from: {id: device.id, name: device.name}, command, at: now};
      state.queue.push(item); await this.save(state, now);
      const message = JSON.stringify({type: 'command', seq: item.seq, from: item.from, command});
      for (const ws of this.sockets(target.id)) try { ws.send(message); } catch {}
      return remoteJSON({seq: item.seq, target: {id: target.id, name: target.name}}, 202);
    }
    if (path === '/remote/state') {
      const value = remoteState(body.state);
      if (value === undefined) return remoteJSON({error: '播放狀態無效。'}, 400);
      this.register(state, device, now); state.devices[device.id].state = value; await this.save(state, now);
      const devices = this.list(state, now); this.broadcast({type: 'devices', devices});
      return remoteJSON({devices});
    }
    return remoteJSON({error: 'Not found'}, 404);
  }
  async connect(request) {
    const url = new URL(request.url);
    const device = remoteDevice({device: url.searchParams.get('device'), name: url.searchParams.get('name') || '', kind: url.searchParams.get('kind')});
    if (!device) return remoteJSON({error: '裝置資料無效。'}, 400);
    if (typeof WebSocketPair !== 'function' || typeof this.ctx.acceptWebSocket !== 'function') return remoteJSON({error: '此伺服器未支援即時遙控。'}, 501);
    const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : null;
    return new Response(null, {status: 101, webSocket: await this.open(device, since), headers: {'Sec-WebSocket-Protocol': REMOTE_PROTOCOL}});
  }
  // Hibernatable socket: tagged by device so commands reach only their target.
  async open(device, since) {
    const now = Date.now(), [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [device.id]); server.serializeAttachment({device: device.id});
    const state = await this.load(); this.register(state, device, now); await this.save(state, now);
    const devices = this.list(state, now);
    server.send(JSON.stringify({type: 'hello', seq: state.seq, commands: this.pending(state, device.id, since, now), devices}));
    this.broadcast({type: 'devices', devices}, server);
    return client;
  }
  async message(ws, data) {
    if (data === 'ping') { ws.send('pong'); return; }
    let message; try { message = JSON.parse(data); } catch { return; }
    if (message?.type === 'devices') ws.send(JSON.stringify({type: 'devices', devices: this.list(await this.load(), Date.now())}));
  }
  async closed(ws) {
    let id; try { id = ws.deserializeAttachment()?.device; } catch {}
    try { ws.close(); } catch {}
    const now = Date.now(), state = await this.load();
    if (id && state.devices[id]) { state.devices[id].seenAt = now - REMOTE_ONLINE; await this.save(state, now); }
    this.broadcast({type: 'devices', devices: this.list(state, now, ws)}, ws);
  }
}
