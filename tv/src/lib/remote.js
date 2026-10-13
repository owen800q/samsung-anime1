// Phone remote, receiving side (ported from the website's remote.js). The TV registers as a
// screen on its sync profile; phones on the same profile send play/toggle/seek/next/previous
// commands and see what the TV is playing.
import { API, call, randomHex } from './http.js';
import * as store from './store.js';

const PROTOCOL = 'anime1-remote.v1';
const HEX = /^[a-f0-9]{32}$/;
const KIND = 'tv';
export const DEFAULT_NAME = 'Samsung 電視';

function get(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function set(key, value) { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (_) {} }

let device = get('anime1-device');
if (!HEX.test(device || '')) { device = randomHex(16); set('anime1-device', device); }
let name = get('anime1-device-name') || DEFAULT_NAME;
let devices = [];
let seq = null;
let socket = null;
let mode = 'off';
let timer = null;
let failures = 0;
let retrySocketAt = 0;
let available = true;
let polling = false;
let playing;
let published = null;
let stateTimer = null;
const commandListeners = [];
const deviceListeners = [];

const identity = () => ({ device, name, kind: KIND });

/** fn(command, fromName) for every command addressed to this TV. */
export function onCommand(fn) {
  commandListeners.push(fn);
  return () => { const i = commandListeners.indexOf(fn); if (i >= 0) commandListeners.splice(i, 1); };
}
/** fn(devices) whenever the profile's online devices change. */
export function onDevices(fn) {
  deviceListeners.push(fn);
  return () => { const i = deviceListeners.indexOf(fn); if (i >= 0) deviceListeners.splice(i, 1); };
}
export const deviceName = () => name;
export const deviceId = () => device;
export const others = () => devices.filter(d => d.id !== device);
export const isAvailable = () => available;

export function rename(next) {
  name = String(next || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || DEFAULT_NAME;
  set('anime1-device-name', name);
  connect();
  return name;
}

function request(action, data) {
  return call('/api/remote/' + action, { body: data, auth: store.profile(), timeout: 8000 }).then(r => {
    if (!r.ok) throw Object.assign(new Error(r.data.error || '遙控服務暫時未能回應。'), { status: r.status });
    return r.data;
  });
}

function socketUrl() {
  const base = API || location.origin;
  const params = Object.keys(identity()).map(k => k + '=' + encodeURIComponent(identity()[k]));
  if (seq != null) params.push('since=' + seq);
  return base.replace(/^http/, 'ws') + '/api/remote/socket?' + params.join('&');
}

// Transport: a hibernating WebSocket when available, otherwise short polling.
function disconnect() {
  clearTimeout(timer); timer = null; mode = 'off';
  if (socket) { const old = socket; socket = null; old.onopen = old.onclose = old.onmessage = null; try { old.close(); } catch (_) {} }
}
export function connect() {
  disconnect();
  if (!available) return;
  if (typeof WebSocket !== 'function' || Date.now() < retrySocketAt) { void poll(); return; }
  let ws;
  let opened = false;
  try { ws = new WebSocket(socketUrl(), [PROTOCOL, store.profile()]); } catch (_) { retrySocketAt = Date.now() + 300000; void poll(); return; }
  socket = ws; mode = 'connecting';
  ws.onopen = () => { opened = true; failures = 0; mode = 'socket'; heartbeat(); };
  ws.onmessage = event => { if (event.data !== 'pong') try { receive(JSON.parse(event.data)); } catch (_) {} };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null; clearTimeout(timer);
    if (!opened) { retrySocketAt = Date.now() + 300000; void poll(); return; }
    mode = 'off'; failures++; timer = setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, failures)));
  };
}
function heartbeat() {
  clearTimeout(timer);
  timer = setTimeout(() => { if (socket && socket.readyState === 1) { socket.send('ping'); heartbeat(); } }, 30000);
}
async function poll() {
  clearTimeout(timer); mode = 'poll';
  if (polling) return;
  polling = true;
  try {
    const result = await request('poll', Object.assign(identity(), { since: seq }));
    if (mode !== 'poll') return;
    run(result.commands); seq = Math.max(seq || 0, result.seq); setDevices(result.devices);
  } catch (error) {
    if ([404, 501, 503].indexOf(error.status) >= 0) { available = false; mode = 'off'; setDevices([]); return; }
  } finally { polling = false; }
  if (mode !== 'poll') return;
  if (typeof WebSocket === 'function' && retrySocketAt && Date.now() >= retrySocketAt) { retrySocketAt = 0; connect(); return; }
  timer = setTimeout(() => void poll(), document.hidden ? 15000 : 2000);
}
function receive(data) {
  if (data.type === 'hello') { run(data.commands); seq = Math.max(seq || 0, data.seq); setDevices(data.devices); }
  else if (data.type === 'command') run([data]);
  else if (data.type === 'devices') setDevices(data.devices);
}
function run(commands) {
  (commands || []).forEach(item => {
    if (seq != null && item.seq <= seq) return;
    seq = item.seq;
    const from = (item.from && item.from.name) || '另一部裝置';
    commandListeners.slice().forEach(fn => { try { fn(item.command, from); } catch (_) {} });
  });
}
function setDevices(list) {
  const before = devices.map(d => d.id);
  devices = Array.isArray(list) ? list : [];
  if (devices.some(d => d.id !== device && before.indexOf(d.id) < 0)) schedule(0);
  deviceListeners.slice().forEach(fn => { try { fn(devices); } catch (_) {} });
}
export function refreshDevices() {
  if (mode === 'socket' && socket) socket.send(JSON.stringify({ type: 'devices' }));
  else if (mode === 'poll') void poll();
}

/**
 * Report what this screen plays (null when nothing): sent immediately on changes, otherwise
 * at most every 10 seconds, and only while another device on the profile is online.
 * state: { episodeId, title, position, duration, paused, hasPrevious, hasNext }
 */
export function setPlaying(state) {
  playing = state;
  const drift = published && playing ? Math.abs(playing.position - published.position - (published.paused ? 0 : (Date.now() - published.sentAt) / 1000)) : 0;
  const urgent = !published !== !playing || (playing && (playing.episodeId !== published.episodeId || playing.paused !== published.paused || drift > 3));
  schedule(urgent ? 0 : 10000);
}
function schedule(delay) {
  if (!available || playing === undefined || !devices.some(d => d.id !== device)) return;
  if (stateTimer && delay) return;
  clearTimeout(stateTimer); stateTimer = setTimeout(() => void publish(), delay);
}
async function publish() {
  stateTimer = null;
  published = playing ? Object.assign({}, playing, { sentAt: Date.now() }) : null;
  try { setDevices((await request('state', Object.assign(identity(), { state: playing }))).devices); } catch (_) {}
}

store.subscribe(kind => { if (kind === 'profile-changed') { seq = null; devices = []; available = true; connect(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && (mode === 'off' || mode === 'poll')) connect(); });
window.addEventListener('online', () => { if (mode !== 'socket') connect(); });
