import {WatchHistory} from '../../src/sync-server.js';
export class MemoryStorage {
  data = new Map(); alarmAt = null;
  async get(key) { return structuredClone(Array.isArray(key) ? new Map(key.filter(k => this.data.has(k)).map(k => [k, this.data.get(k)])) : this.data.get(key)); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async delete(key) { return this.data.delete(key); }
  async transaction(fn) { return fn(this); }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(at) { this.alarmAt = at; }
  async list({prefix = '', limit = 128, startAfter = ''} = {}) { return new Map([...this.data].filter(([key]) => key.startsWith(prefix) && key > startAfter).sort(([a], [b]) => a < b ? -1 : 1).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])); }
}
export function makeEnv(Storage = MemoryStorage) {
  const objects = new Map(), stores = new Map();
  const env = {WATCH_HISTORY: {idFromName: n => n, get: n => {
    if (!stores.has(n)) stores.set(n, new Storage(n));
    if (!objects.has(n)) objects.set(n, new WatchHistory({storage: stores.get(n)}, env));
    return objects.get(n);
  }}};
  return {env, stores, objects};
}
export const profileName = async token => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(x => x.toString(16).padStart(2, '0')).join('');
export const progress = (id = '29599', position = 234, updatedAt = Date.now()) => ({episodeId: id, seriesId: '1959', title: '動畫 [03]', seriesTitle: '動畫', position, duration: 1400, completed: false, revision: 1, updatedAt});
