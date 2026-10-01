// Keeps the www.jevai.org website session (Supabase auth) alive for the jev-session provider.
// JEV_COOKIE is the seed: the browser's Cookie header, which holds sb-<ref>-auth-token(.N) chunks
// encoded as "base64-" + base64url(JSON session). Supabase rotates refresh tokens and may revoke a
// session when an old one is reused, so refreshed tokens live in one Durable Object that refreshes
// serially; Worker isolates never refresh on their own. Tokens are never logged.
const JEV_SUPABASE_URL = 'https://sebhokoocyhjlqqiykbp.supabase.co';
// Publishable (anon) key from jevai.org's public frontend bundle; it is not a secret.
const JEV_SUPABASE_KEY = 'sb_publishable_hVHe999SBVkTufft88vrjQ_5T4NBCkH';
const JEV_AUTH_COOKIE = 'sb-sebhokoocyhjlqqiykbp-auth-token';
const JEV_CHUNK_SIZE = 3180; // @supabase/ssr chunk size
const JEV_REFRESH_MARGIN_MS = 120000;
function jevSessionError(status) { const error = new Error('Jev session unavailable'); error.matchReason = 'http_error'; error.status = status; return error; }
const base64UrlDecode = value => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'=')), c => c.charCodeAt(0)));
const base64UrlEncode = value => btoa(String.fromCharCode(...new TextEncoder().encode(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export function parseJevCookie(header) {
  const cookies = String(header || '').split(/;\s*/).map(part => { const at = part.indexOf('='); return at > 0 ? [part.slice(0, at).trim(), part.slice(at + 1).trim()] : null; }).filter(Boolean);
  const auth = cookies.filter(([name]) => name === JEV_AUTH_COOKIE || new RegExp('^' + JEV_AUTH_COOKIE + '\\.\\d+$').test(name))
    .sort(([a], [b]) => Number(a.split('.').pop()) - Number(b.split('.').pop()));
  if (!auth.length) throw jevSessionError(401);
  let value = auth.map(([, v]) => decodeURIComponent(v)).join('');
  if (value.startsWith('base64-')) value = base64UrlDecode(value.slice(7));
  const session = JSON.parse(value);
  if (typeof session?.refresh_token !== 'string' || typeof session.access_token !== 'string') throw jevSessionError(401);
  // Other site cookies (e.g. auth-flow verifiers) are kept as they were.
  return {session, extra: cookies.filter(([name]) => !name.startsWith(JEV_AUTH_COOKIE)).map(([n, v]) => n + '=' + v)};
}
export function buildJevCookie({session, extra = []}) {
  const value = 'base64-' + base64UrlEncode(JSON.stringify(session));
  const chunks = value.length <= JEV_CHUNK_SIZE ? [[JEV_AUTH_COOKIE, value]]
    : Array.from({length: Math.ceil(value.length / JEV_CHUNK_SIZE)}, (_, i) => [JEV_AUTH_COOKIE + '.' + i, value.slice(i * JEV_CHUNK_SIZE, (i + 1) * JEV_CHUNK_SIZE)]);
  return [...extra, ...chunks.map(([n, v]) => n + '=' + v)].join('; ');
}
async function refreshJevSession(session) {
  const response = await fetch(JEV_SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: {'Content-Type': 'application/json', apikey: JEV_SUPABASE_KEY}, body: JSON.stringify({refresh_token: session.refresh_token})});
  if (!response.ok) { await response.body?.cancel(); throw jevSessionError(response.status); }
  const next = await response.json();
  if (typeof next?.access_token !== 'string' || typeof next.refresh_token !== 'string') throw jevSessionError(502);
  const expiresAt = Number.isFinite(next.expires_at) ? next.expires_at : Math.floor(Date.now() / 1000) + (Number(next.expires_in) || 3600);
  return {...session, ...next, user: next.user || session.user, expires_at: expiresAt};
}
// Returns a current Cookie header, refreshing when close to expiry or when forced (after a 401).
// store: {get(), put(record)}; the caller must serialise calls.
export async function currentJevCookie(store, env, {force = false} = {}) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.JEV_COOKIE || ''));
  const seed = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  let record = await store.get(), changed = false;
  // A new JEV_COOKIE secret replaces the stored session.
  if (!record || record.seed !== seed) { record = {seed, ...parseJevCookie(env.JEV_COOKIE)}; changed = true; }
  if (force || !(record.session.expires_at * 1000 - Date.now() > JEV_REFRESH_MARGIN_MS)) {
    record = {...record, session: await refreshJevSession(record.session)}; changed = true;
  }
  if (changed) await store.put(record);
  return buildJevCookie(record);
}
// Without a Durable Object (local scripts, tests) one in-memory record is shared per process.
let localJevRecord = null, localJevLock = Promise.resolve();
export async function jevSessionCookie(env, {force = false} = {}) {
  if (env.WATCH_HISTORY) {
    const stub = env.WATCH_HISTORY.get(env.WATCH_HISTORY.idFromName('jev-session:v1'));
    const response = await stub.fetch('https://history.internal/jev-session' + (force ? '?force=1' : ''), {method: 'POST'});
    if (!response.ok) { await response.body?.cancel(); throw jevSessionError(response.status); }
    return (await response.json()).cookie;
  }
  const run = localJevLock.then(() => currentJevCookie({get: () => localJevRecord, put: record => { localJevRecord = record; }}, env, {force}));
  localJevLock = run.catch(() => {});
  return run;
}

