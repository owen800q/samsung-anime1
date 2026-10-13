import { allowedCaller } from './adapter.js';
// Short-lived invitations in the existing WATCH_HISTORY Durable Object namespace.
const PAIR_TTL = 5 * 60 * 1000;
const PAIR_DELIVERY_TTL = 60 * 1000;
const PAIR_CONFIRM_TTL = 2 * 60 * 1000;
const pairJSON = (data, status = 200) => Response.json(data, {status, headers: {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff'
}});
const pairRandom = (bytes = 32) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
export const pairHash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
const pairHex = value => typeof value === 'string' && /^[a-f0-9]{32,64}$/.test(value);
function pairDigits() {
  let n;
  do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= 4294000000);
  return String(n % 1000000).padStart(6, '0');
}
export async function pairBody(request, noun = '配對') {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw Object.assign(new Error('請使用 JSON 請求。'), {status: 415});
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('請提供' + noun + '資料。'), {status: 400});
  let text = '', size = 0; const decoder = new TextDecoder();
  try {
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel(); throw Object.assign(new Error(noun + '資料過長。'), {status: 413}); }
      text += decoder.decode(value, {stream: true});
    }
    const data = JSON.parse(text + decoder.decode());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch (error) { throw error.status ? error : Object.assign(new Error(noun + '資料無效。'), {status: 400}); }
  finally { reader.releaseLock(); }
}
export async function pairingRoute(request, env) {
  const url = new URL(request.url);
  if (!allowedCaller(request)) return pairJSON({error: '請從本站進行配對。'}, 403);
  if (request.method !== 'POST') return pairJSON({error: 'Method not allowed'}, 405);
  const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{32})$/)?.[1];
  if (!token) return pairJSON({error: '請先啟用此瀏覽器的觀看紀錄。'}, 401);
  if (!env.WATCH_HISTORY) return pairJSON({error: '雲端同步尚未啟用，觀看紀錄仍保留在此裝置。'}, 503);
  const action = url.pathname.slice('/api/pairing/'.length);
  if (!['create', 'preview', 'approve', 'status', 'accept', 'cancel', 'ack'].includes(action)) return pairJSON({error: '找不到配對功能。'}, 404);
  try {
    const body = await pairBody(request);
    const client = await pairHash(request.headers.get('cf-connecting-ip') || 'unknown');
    const stub = env.WATCH_HISTORY.get(env.WATCH_HISTORY.idFromName('pairing:v1'));
    return await stub.fetch(new Request('https://history.internal/pairing/' + action, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Pairing-Client': client}, body: JSON.stringify(body)
    }));
  } catch (error) { return pairJSON({error: error.status ? error.message : '配對服務暫時未能回應，請重試。'}, error.status || 503); }
}
export class PairingSessions {
  constructor(storage, env) { this.storage = storage; this.env = env; this.locks = new Map(); }
  fetch(request) { return this.handle(request); }
  // Serialise work per invitation across cross-object fetches; unrelated invitations are not blocked.
  exclusive(key, task) {
    const run = (this.locks.get(key) || Promise.resolve()).then(task), tail = run.catch(() => {});
    this.locks.set(key, tail); tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }
  async scheduleCleanup() {
    if (!await this.storage.getAlarm()) await this.storage.setAlarm(Date.now() + 60000);
  }
  async limit(client, kind, maximum) {
    const now = Date.now(), window = 600000;
    const key = 'rate:' + Math.floor(now / window) + ':' + kind + ':' + client;
    const allowed = await this.storage.transaction(async tx => {
      const record = await tx.get(key) || {count: 0, expiresAt: (Math.floor(now / window) + 1) * window};
      if (record.count >= maximum) return false;
      record.count++; await tx.put(key, record); return true;
    });
    await this.scheduleCleanup(); return allowed;
  }
  stub(name) { return this.env.WATCH_HISTORY.get(this.env.WATCH_HISTORY.idFromName(name)); }
  async snapshot(name) {
    const response = await this.stub(name).fetch(new Request('https://history.internal/pairing-export'));
    if (!response.ok) throw new Error('Snapshot unavailable');
    return response.json();
  }
  async handle(request) {
    const action = new URL(request.url).pathname.split('/').pop();
    const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{32})$/)?.[1];
    if (!token) return pairJSON({error: 'Unauthorized'}, 401);
    const actor = await pairHash(token), body = await request.json();
    const client = request.headers.get('x-pairing-client') || 'unknown';
    if (['create', 'preview', 'approve'].includes(action)) {
      if (!await this.limit(client, action === 'create' ? 'create' : 'guess', action === 'create' ? 10 : 30)) return pairJSON({error: '配對嘗試太頻密，請稍後再試。'}, 429);
    }
    if (action === 'create') return this.create(body, actor);
    let id = body.sessionId;
    if (action === 'preview') {
      if (typeof body.ticket === 'string' && /^[a-f0-9]{48}$/.test(body.ticket)) id = await this.storage.get('qr:' + await pairHash(body.ticket));
      else if (typeof body.code === 'string' && /^\d{6}$/.test(body.code)) id = await this.storage.get('code:' + body.code);
      else return pairJSON({error: '請輸入電視／電腦顯示的六位數字。'}, 400);
    }
    if (!pairHex(id)) return pairJSON({error: '配對碼無效或已過期，請在原裝置產生新碼。'}, 410);
    return this.exclusive(id, () => this.act(action, id, body, actor, token));
  }
  async create(body, actor) {
    const now = Date.now();
    if (!await this.limit(actor, 'profile-create', 10) || !await this.limit('all', 'global-create', 1000)) return pairJSON({error: '請稍後再產生配對碼。'}, 429);
    if (!pairHex(body.secret) || body.secret.length !== 64) return pairJSON({error: '配對授權無效。'}, 400);
    const secretHash = await pairHash(body.secret), existingId = await this.storage.get('owner:' + secretHash);
    if (existingId) {
      const existing = await this.storage.get('session:' + existingId);
      if (existing?.owner === actor && existing.status === 'pending' && existing.expiresAt > now) return pairJSON({sessionId: existing.id, ticket: existing.ticket, code: existing.code, expiresAt: existing.expiresAt, pollAfter: 2});
    }
    const id = pairRandom(16), ticket = pairRandom(24), ticketHash = await pairHash(ticket);
    // Reserve the code in the same transaction that checks it, so two invitations never share digits.
    const session = await this.storage.transaction(async tx => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = pairDigits();
        if (await tx.get('code:' + code)) continue;
        const created = {id, code, owner: actor, secretHash, ticket, ticketHash, status: 'pending', expiresAt: now + PAIR_TTL};
        await tx.put('session:' + id, created); await tx.put('code:' + code, id);
        await tx.put('qr:' + ticketHash, id); await tx.put('owner:' + secretHash, id);
        return created;
      }
      return null;
    });
    if (!session) return pairJSON({error: '暫時未能產生配對碼，請重試。'}, 503);
    await this.scheduleCleanup();
    return pairJSON({sessionId: id, ticket, code: session.code, expiresAt: session.expiresAt, pollAfter: 2}, 201);
  }
  async act(action, id, body, actor, token) {
    const now = Date.now(), session = await this.storage.get('session:' + id);
    if (!session || now >= (session.deliveryUntil || session.expiresAt)) return pairJSON({error: '配對碼無效或已過期，請在原裝置產生新碼。'}, 410);
    if (action === 'preview') {
      if (session.status !== 'pending') return pairJSON({error: '此配對碼已使用或已取消。'}, 410);
      const confirmation = pairRandom();
      const source = await this.snapshot(session.owner), destination = actor === session.owner ? source : await this.snapshot(actor);
      session.preview = {actor, hash: await pairHash(confirmation), destinationCount: destination.entries.length};
      await this.storage.put('session:' + id, session);
      return pairJSON({sessionId: id, confirmation, code: session.code, expiresAt: session.expiresAt, sourceCount: source.entries.length, destinationCount: destination.entries.length, alreadyLinked: actor === session.owner});
    }
    if (action === 'approve') {
      if (session.status === 'approved' && session.approvedBy === actor && pairHex(body.confirmation) && session.preview?.hash === await pairHash(body.confirmation)) return pairJSON({status: 'approved', verify: session.verify});
      if (session.status !== 'pending' || !pairHex(body.confirmation) || session.preview?.actor !== actor || session.preview.hash !== await pairHash(body.confirmation)) return pairJSON({error: '確認已失效，請重新輸入配對碼。'}, 409);
      // Nothing is merged or delivered yet: the requesting screen must also accept, comparing this number with the phone.
      session.status = 'approved'; session.profile = token; session.approvedBy = actor; session.verify = pairDigits().slice(-2);
      session.deliveryUntil = now + PAIR_CONFIRM_TTL;
      await this.storage.put('session:' + id, session); await this.scheduleCleanup();
      return pairJSON({status: 'approved', verify: session.verify});
    }
    if (actor !== session.owner || !pairHex(body.secret) || await pairHash(body.secret) !== session.secretHash) return pairJSON({error: '配對授權無效。'}, 403);
    if (action === 'status') {
      if (session.status === 'approved') return pairJSON({status: 'approved', verify: session.verify, destinationCount: session.preview?.destinationCount ?? 0, alreadyLinked: session.approvedBy === session.owner});
      return pairJSON({status: session.status, expiresAt: session.expiresAt});
    }
    if (action === 'accept') {
      if (session.status === 'accepted') return pairJSON({status: 'accepted', profile: session.profile});
      if (session.status !== 'approved') return pairJSON({error: '手機尚未確認。'}, 409);
      if (session.owner !== session.approvedBy) {
        const snapshot = await this.snapshot(session.owner);
        const merged = await this.stub(session.approvedBy).fetch(new Request('https://history.internal/pairing-import', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(snapshot)}));
        if (!merged.ok) return pairJSON({error: '未能合併紀錄，未有切換裝置；請重試。'}, 503);
      }
      // Only the requester, authenticated with a separate secret, receives the shared credential.
      session.status = 'accepted'; session.deliveryUntil = Date.now() + PAIR_DELIVERY_TTL;
      await this.storage.put('session:' + id, session);
      return pairJSON({status: 'accepted', profile: session.profile});
    }
    if (action === 'cancel' && session.status === 'accepted') return pairJSON({error: '已確認連接，正在完成。'}, 409);
    if (action === 'ack' && !['accepted', 'completed'].includes(session.status)) return pairJSON({error: '配對尚未完成。'}, 409);
    if (action === 'cancel' || action === 'ack') {
      session.status = action === 'ack' ? 'completed' : 'cancelled'; delete session.profile; delete session.preview; delete session.ticket;
      await this.storage.put('session:' + id, session);
      return pairJSON({status: session.status});
    }
    return pairJSON({error: 'Not found'}, 404);
  }
  async cleanup() {
    let remaining = false;
    for (const prefix of ['session:', 'rate:']) {
      let cursor;
      for (;;) {
        const records = await this.storage.list({prefix, limit: 128, ...(cursor ? {startAfter: cursor} : {})});
        if (!records.size) break;
        for (const [key, value] of records) {
          cursor = key;
          if (Date.now() < (value.deliveryUntil || value.expiresAt)) { remaining = true; continue; }
          if (prefix === 'rate:') { await this.storage.delete(key); continue; }
          await this.exclusive(value.id, () => this.storage.transaction(async tx => {
            const current = await tx.get(key);
            if (!current || Date.now() < (current.deliveryUntil || current.expiresAt)) { remaining ||= !!current; return; }
            for (const index of ['code:' + current.code, 'qr:' + current.ticketHash, 'owner:' + current.secretHash]) if (await tx.get(index) === current.id) await tx.delete(index);
            await tx.delete(key);
          }));
        }
        if (records.size < 128) break;
      }
    }
    if (remaining) await this.storage.setAlarm(Date.now() + 60000);
  }
}
// Internal only. The public history route never forwards these paths.
export async function pairingHistory(storage, request, validateProgress, validateSetting) {
  const path = new URL(request.url).pathname;
  if (path === '/pairing-export' && request.method === 'GET') {
    return storage.transaction(async tx => {
      const result = {entries: [], settings: []};
      for (const [indexKey, prefix, out] of [['index', 'ep:', 'entries'], ['dm-index', 'dm:', 'settings']]) {
        const index = await tx.get(indexKey) || [];
        for (let i = 0; i < index.length; i += 128) {
          const keys = index.slice(i, i + 128).map(x => prefix + (typeof x === 'object' ? x.id : x));
          result[out].push(...(await tx.get(keys)).values());
        }
      }
      return pairJSON(result);
    });
  }
  if (path !== '/pairing-import' || request.method !== 'POST') return pairJSON({error: 'Not found'}, 404);
  const data = await request.json();
  if (!Array.isArray(data.entries) || data.entries.length > 500 || !Array.isArray(data.settings) || data.settings.length > 500) return pairJSON({error: 'Invalid snapshot'}, 400);
  return storage.transaction(async tx => {
    for (const [items, prefix, indexKey, validate] of [[data.entries, 'ep:', 'index', validateProgress], [data.settings, 'dm:', 'dm-index', validateSetting]]) {
      let index = await tx.get(indexKey) || [];
      for (const source of items) {
        const valid = validate(source); if (!valid) continue;
        const key = prefix + valid.episodeId, old = await tx.get(key), stamp = source.updatedAt;
        if (!Number.isFinite(stamp) || stamp <= 0 || stamp > Date.now() + 60000 || (old && old.updatedAt >= stamp)) continue;
        await tx.put(key, {...valid, revision: (old?.revision || 0) + 1, updatedAt: stamp});
        index = index.filter(x => String(typeof x === 'object' ? x.id : x) !== valid.episodeId);
        index.push(prefix === 'ep:' ? {id: valid.episodeId} : valid.episodeId);
      }
      const dated = [];
      for (let i = 0; i < index.length; i += 128) {
        const part = index.slice(i, i + 128), values = await tx.get(part.map(x => prefix + (typeof x === 'object' ? x.id : x)));
        for (const x of part) dated.push({x, at: values.get(prefix + (typeof x === 'object' ? x.id : x))?.updatedAt || 0});
      }
      dated.sort((a, b) => b.at - a.at);
      for (const {x} of dated.slice(500)) await tx.delete(prefix + (typeof x === 'object' ? x.id : x));
      await tx.put(indexKey, dated.slice(0, 500).map(x => x.x));
    }
    return pairJSON({merged: true});
  });
}
