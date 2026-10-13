// JSON requests to the samsung-anime1 Worker. Chromium 56 has no AbortController, so a
// cancelled or timed-out request is ignored by the caller (and aborted where supported).
export const API = __API_BASE__;
/** Public address of the website, shown for pairing and encoded in the QR code. */
export const SITE = API || location.origin;

const canAbort = typeof AbortController === 'function';

export function apiUrl(path) {
  return API + path;
}

/** Cancellation token shared by a screen's in-flight requests. */
export class CancelToken {
  constructor() { this.cancelled = false; this.listeners = []; }
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.listeners.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
  }
  onCancel(fn) {
    if (this.cancelled) fn(); else this.listeners.push(fn);
  }
}

export function isCancel(error) {
  return !!(error && error.cancelled);
}

/**
 * Fetch `path` and parse JSON. Resolves `{ ok, status, data }`; rejects on network errors,
 * timeout (`status: 0`) and cancellation (`cancelled: true`).
 */
export function call(path, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const ctrl = canAbort ? new AbortController() : null;
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => {
      if (ctrl) ctrl.abort();
      finish(reject, Object.assign(new Error(o.timeoutMessage || '連線逾時，請重試。'), { status: 0, timeout: true }));
    }, o.timeout || 15000);
    if (o.cancel) o.cancel.onCancel(() => { if (ctrl) ctrl.abort(); finish(reject, Object.assign(new Error('cancelled'), { cancelled: true })); });
    const headers = {};
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.auth) headers.Authorization = 'Bearer ' + o.auth;
    const init = { method: o.method || (o.body !== undefined ? 'POST' : 'GET'), headers, credentials: 'omit' };
    if (o.body !== undefined) init.body = JSON.stringify(o.body);
    if (ctrl) init.signal = ctrl.signal;
    fetch(apiUrl(path), init).then(response => {
      const type = response.headers.get('content-type') || '';
      const parse = type.indexOf('application/json') >= 0 ? response.json() : Promise.resolve(null);
      return parse.then(data => finish(resolve, { ok: response.ok, status: response.status, data: data || {}, json: !!data }));
    }).catch(error => finish(reject, Object.assign(new Error('網絡連線失敗，請檢查電視網絡後重試。'), { status: 0, cause: error })));
  });
}

/** `call` that throws the Worker's error message on non-2xx responses. */
export function json(path, opts) {
  const fallback = (opts && opts.fallback) || '動畫資料暫時無法讀取。';
  return call(path, opts).then(r => {
    if (!r.json) throw Object.assign(new Error(fallback), { status: r.status });
    if (!r.ok) throw Object.assign(new Error(r.data.error || fallback), { status: r.status, data: r.data });
    return r.data;
  });
}

export function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
  return s;
}
