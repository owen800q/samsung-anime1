// Watch history synced through the Worker's Durable Object, ported from the website's
// state.js. The same localStorage keys are used, so the profile token works the same way:
// it identifies this TV's cloud profile, and pairing switches it to the phone's.
import { call, randomHex } from './http.js';

const PROFILE = /^[a-f0-9]{32}$/;
const listeners = [];

function read(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (_) { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
}

let token = read('anime1-profile', null);
if (!PROFILE.test(token || '')) { token = randomHex(16); write('anime1-profile', token); }
let entries = read('anime1-history:' + token, {});
let pulling = null;
let sending = null;
let syncText = '正在連接雲端紀錄…';

/** kind: 'history' | 'sync' | 'profile-changing' | 'profile-changed' | 'playback-resume' */
export function subscribe(fn) {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}
function emit(kind) {
  listeners.slice().forEach(fn => { try { fn(kind); } catch (_) {} });
}
function announce() {
  write('anime1-history:' + token, entries);
  emit('history');
}
function status(text) {
  syncText = text;
  emit('sync');
}

export const profile = () => token;
export const syncStatus = () => syncText;

export function all() {
  return Object.keys(entries).map(k => entries[k]).sort((a, b) => b.updatedAt - a.updatedAt);
}
export function get(id) {
  return entries[String(id)];
}
/** Latest watched episode of a series. */
export function latest(seriesId) {
  return all().filter(x => String(x.seriesId) === String(seriesId))[0];
}

/** Upload dirty entries one by one; resolves true when everything is on the server. */
export function flush() {
  if (sending) return sending;
  const owner = token;
  sending = (async () => {
    try {
      for (;;) {
        const local = all().filter(x => x.dirty)[0];
        if (!local || owner !== token) break;
        const stamp = local.localStamp;
        const r = await call('/api/history', { method: 'PUT', body: local, auth: owner, timeout: 8000 });
        if (owner !== token) return false;
        if (!r.ok && r.status !== 409) throw new Error(r.data.error || '同步暫時無法使用');
        if (!r.data.entry) throw new Error('Missing progress');
        const current = entries[local.episodeId];
        if (r.status === 409 || (current && current.localStamp === stamp)) entries[local.episodeId] = Object.assign({}, r.data.entry, { dirty: false });
        else if (current) current.revision = r.data.entry.revision;
        announce();
      }
      status('觀看紀錄已儲存至雲端');
      return true;
    } catch (_) {
      status('暫存於此裝置，連線恢復後再同步');
      return false;
    }
  })();
  sending.then(() => { sending = null; }, () => { sending = null; });
  return sending;
}

/** Upload pending progress, then pull the server's history. */
export function refresh() {
  if (pulling) return pulling;
  const owner = token;
  pulling = (async () => {
    try {
      const uploaded = await flush();
      const r = await call('/api/history', { auth: owner, timeout: 8000 });
      if (!r.ok) throw new Error('History unavailable');
      if (owner !== token) return false;
      (r.data.entries || []).forEach(remote => {
        const local = entries[remote.episodeId];
        if (!(local && local.dirty) && remote.revision >= ((local && local.revision) || 0)) entries[remote.episodeId] = Object.assign({}, remote, { dirty: false });
      });
      announce();
      status(uploaded ? '觀看紀錄已儲存至雲端' : '仍有紀錄暫存於此裝置，連線恢復後再同步');
      return uploaded;
    } catch (_) {
      status('暫存於此裝置，連線恢復後再同步');
      return false;
    }
  })();
  pulling.then(() => { pulling = null; }, () => { pulling = null; });
  return pulling;
}

/** Record progress: { episodeId, seriesId, title, seriesTitle, position, duration, completed }. */
export function save(value) {
  const id = String(value.episodeId);
  const previous = entries[id];
  entries[id] = Object.assign({}, value, { episodeId: id, revision: (previous && previous.revision) || 0, updatedAt: Date.now(), localStamp: randomHex(16), dirty: true });
  const kept = {};
  all().slice(0, 500).forEach(x => { kept[x.episodeId] = x; });
  entries = kept;
  announce();
  void flush();
}

/** Switch to another cloud profile (pairing or recovery code). */
export async function changeProfile(next) {
  if (!PROFILE.test(next)) throw new Error('復原碼無效。');
  emit('profile-changing');
  const keep = message => { emit('playback-resume'); return new Error(message); };
  if (!await flush()) throw keep('仍有未儲存的紀錄，請連線後重試。');
  if (pulling) await pulling;
  if (!write('anime1-profile', next)) throw keep('電視無法保存連接，請重新開啟應用程式後再試。');
  token = next;
  entries = read('anime1-history:' + token, {});
  announce();
  const synced = await refresh();
  emit('profile-changed');
  return synced;
}

export const pauseForPairing = () => emit('profile-changing');
export const resumeAfterPairing = () => emit('playback-resume');

export function pairing(action, data, owner) {
  return call('/api/pairing/' + action, { body: data, auth: owner || token, timeout: 10000 });
}

export function danmakuSettings(episodeId, data, cancel) {
  return call('/api/danmaku/settings?episode=' + encodeURIComponent(episodeId), data
    ? { method: 'PUT', body: data, auth: token, timeout: 10000, cancel }
    : { auth: token, timeout: 10000, cancel });
}

setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
window.addEventListener('online', () => void refresh());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
void refresh();
