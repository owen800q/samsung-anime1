// Episode danmaku (Dandanplay / Bahamut / Bilibili), ported from the website's danmaku.js:
// automatic pairing, per-provider offsets, merged + deduplicated comments, source filter and
// a canvas overlay that follows video.currentTime. The UI lives in the player; this module
// only reports state through `onChange`.
import { CancelToken, json as getJson } from './http.js';
import * as store from './store.js';

export const PROVIDERS = ['bahamut', 'bilibili', 'dandanplay'];
export const DENSITIES = [{ value: 4, label: '少量' }, { value: 8, label: '適中' }, { value: 12, label: '較多' }];
export const providerName = p => ({ bahamut: '動畫瘋', bilibili: 'Bilibili', dandanplay: '彈彈play（含關聯來源）' })[p] || p;

const sourceKey = src => src.provider + ':' + src.id;
// NFKC folds full-width forms; then drop whitespace, ASCII/CJK punctuation and symbols
// (Chromium 56 lacks \p{…} escapes, which the website uses for the same comparison).
const normal = s => String(s).normalize('NFKC').toLowerCase().replace(/[\s!-\/:-@\[-`{-~ -¿×÷ -⯿　-〿・！-／：-＠［-｀｛-･]/g, '');
// Strip only numeric episode suffixes, not season numbers or special labels.
export const seriesName = s => normal(String(s).normalize('NFKC').replace(/\s*\[\d+(?:\.\d+)?\]\s*$/, ''));

// Mirrors pickEpisodes in title-match.js.
export function pickEpisodes(episodes, n) {
  if (episodes.some(x => x.group === '0')) episodes = episodes.filter(x => x.group === undefined || x.group === '0');
  const numbered = episodes.filter(x => /^\d+(?:\.\d+)?$/.test(x.label));
  const exact = numbered.filter(x => Number(x.label) === Number(n));
  if (exact.length || !Number.isInteger(Number(n)) || Number(n) < 1) return exact;
  const whole = numbered.filter(x => Number.isInteger(Number(x.label))).sort((a, b) => a.label - b.label);
  const consecutive = whole.length > 0 && Number(whole[0].label) > 1 && whole.every((x, i) => Number(x.label) === Number(whole[0].label) + i);
  return consecutive && whole[Number(n) - 1] ? [whole[Number(n) - 1]] : [];
}

function readDensity() {
  let d = 8;
  try { d = Number(localStorage.getItem('anime1-danmaku-density')) || 8; } catch (_) {}
  return [4, 8, 12].indexOf(d) >= 0 ? d : 8;
}

export class Danmaku {
  constructor(video, canvas, onChange) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange || (() => {});
    this.episode = null; this.setting = null; this.epoch = 0; this.cancel = new CancelToken();
    this.searchEpoch = 0; this.saving = false;
    this.segments = new Map(); this.pending = new Set(); this.failed = new Set();
    this.layout = []; this.layoutKey = ''; this.sourceEpoch = 0; this.raf = 0;
    this.enabled = true; this.density = readDensity(); this.filter = 'all';
    this.matchErrors = []; this.matching = false; this.statusText = '';
    this.metrics = { font: 20, speed: 100 }; this.sprites = new Map(); this.spriteKey = '';
    this.clockMedia = 0; this.clockWall = 0; this.reported = -1; this.shown = 0;
    const kick = () => { this.ensureSegments(); this.kick(); };
    this.handlers = {
      playing: kick, pause: kick, seeked: kick, loadedmetadata: kick, ratechange: kick, waiting: kick,
      timeupdate: () => { this.ensureSegments(); if (!this.raf) this.draw(); },
    };
    Object.keys(this.handlers).forEach(k => video.addEventListener(k, this.handlers[k]));
    this.onResize = () => { this.layoutKey = ''; this.draw(); };
    window.addEventListener('resize', this.onResize);
    this.onVisible = () => { if (!document.hidden) { void this.refreshSetting(); this.kick(); } };
    document.addEventListener('visibilitychange', this.onVisible);
    this.poll = setInterval(() => { if (!document.hidden) void this.refreshSetting(); }, 30000);
  }

  destroy() {
    this.stop();
    Object.keys(this.handlers).forEach(k => this.video.removeEventListener(k, this.handlers[k]));
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisible);
    clearInterval(this.poll);
  }

  // ---------- state for the UI ----------
  sources() {
    const s = this.setting;
    return (s && s.sources) || (s && s.source ? [Object.assign({}, s.source, { offset: s.offset || 0 })] : []);
  }
  visibleSource(src) { return this.filter === 'all' || this.filter === src.provider; }
  snapshot() {
    return {
      enabled: this.enabled, density: this.density, filter: this.filter, status: this.statusText,
      sources: this.sources(), retry: this.matchErrors.length > 0 || this.failed.size > 0, matching: this.matching,
      query: this.episode ? (this.episode.seriesTitle || this.episode.title) : '',
    };
  }
  changed() { this.onChange(this.snapshot()); }
  status(text) { this.statusText = text; this.changed(); }

  // ---------- episode lifecycle ----------
  resetSource() {
    this.sourceEpoch++; this.segments.clear(); this.pending.clear(); this.failed.clear();
    this.layout = []; this.layoutKey = ''; this.clearCanvas();
  }
  stop() {
    this.epoch++; this.episode = null; this.setting = null; this.cancel.cancel(); this.cancel = new CancelToken();
    this.searchEpoch++; this.saving = false; this.matchErrors = []; this.matching = false;
    this.resetSource(); cancelAnimationFrame(this.raf); this.raf = 0;
  }
  /** info: { episodeId, title, seriesTitle, seriesId } */
  async open(info) {
    this.stop();
    this.filter = 'all'; this.enabled = true; this.episode = info;
    const e = this.epoch;
    this.status('正在讀取本集彈幕設定…');
    await this.refreshSetting();
    if (e !== this.epoch) return;
    if (this.setting) void this.autoMatch(info, e, this.searchEpoch);
  }

  currentSegment(src) {
    return src.provider === 'bilibili' ? Math.max(1, Math.floor(Math.max(0, this.video.currentTime - (src.offset || 0)) / 360) + 1) : 1;
  }
  async loadSegment(src, index) {
    const key = sourceKey(src) + ':' + index;
    if (!this.enabled || this.pending.has(key) || this.segments.has(key) || this.failed.has(key) || index > 240) return;
    this.pending.add(key);
    const e = this.epoch, g = this.sourceEpoch, cancel = this.cancel;
    try {
      const data = await getJson('/api/danmaku/comments?provider=' + src.provider + '&id=' + encodeURIComponent(src.id) + '&segment=' + index, { cancel, fallback: '彈幕暫時無法讀取。' });
      if (e !== this.epoch || g !== this.sourceEpoch) return;
      if (!Array.isArray(data.comments)) throw new Error('彈幕資料不完整。');
      this.segments.set(key, { src, index, comments: data.comments }); this.layoutKey = '';
      this.segments.forEach((v, k) => { if (v.src.provider === 'bilibili' && Math.abs(v.index - this.currentSegment(v.src)) > 1) this.segments.delete(k); });
      this.loadedStatus(); this.draw();
    } catch (error) {
      if (e === this.epoch && g === this.sourceEpoch && !cancel.cancelled) {
        this.failed.add(key);
        this.matchErrors = this.matchErrors.filter(x => x.key !== key);
        this.matchErrors.push({ key, text: providerName(src.provider) + '：' + (error.message || '讀取失敗') });
        this.loadedStatus();
      }
    } finally {
      if (e === this.epoch && g === this.sourceEpoch) { this.pending.delete(key); this.loadedStatus(); }
    }
  }
  ensureSegments() {
    if (!this.enabled || !this.episode) return;
    const v = this.video;
    this.sources().forEach(src => {
      const index = this.currentSegment(src);
      void this.loadSegment(src, index);
      if (src.provider === 'bilibili') {
        const time = Math.max(0, v.currentTime - (src.offset || 0));
        if (time % 360 < 15 && index > 1) void this.loadSegment(src, index - 1);
        if (time % 360 > 330 && (!isFinite(v.duration) || v.currentTime + 30 < v.duration)) void this.loadSegment(src, index + 1);
      }
    });
  }
  mergedComments() {
    const seen = new Set(), out = [];
    this.segments.forEach(({ src, comments }) => {
      if (!this.visibleSource(src)) return;
      comments.forEach(c => {
        const time = c.time + (src.offset || 0);
        const key = time.toFixed(2) + ':' + c.mode + ':' + c.text;
        if (seen.has(key)) return;
        seen.add(key); out.push(Object.assign({}, c, { time }));
      });
    });
    return out.sort((a, b) => a.time - b.time);
  }
  loadedStatus() {
    if (!this.enabled) { this.status('彈幕已關閉'); return; }
    const count = this.mergedComments().length;
    const sources = this.sources();
    const detail = sources.filter(s => this.visibleSource(s)).map(src => {
      let n = 0;
      this.segments.forEach(x => { if (sourceKey(x.src) === sourceKey(src)) n += x.comments.length; });
      return providerName(src.provider) + ' ' + n;
    }).join(' · ');
    this.status((count ? '已載入 ' + count + ' 條彈幕' : this.pending.size ? '正在讀取本集彈幕…' : sources.length ? '本時段暫時未有彈幕' : this.matching ? '正在自動配對本集彈幕來源…' : '本集未配對彈幕，未找到能確定對應本集的來源')
      + (detail ? ' · ' + detail : '') + (this.matching && sources.length ? ' · 正在配對其他來源…' : '')
      + (this.matchErrors.length ? '；' + this.matchErrors.map(x => x.text).join('；') : ''));
  }
  startSource() {
    this.matchErrors = this.matchErrors.filter(x => x.key.indexOf('match') === 0);
    this.resetSource();
    if (!this.sources().length) { this.status('本集未配對彈幕，會自動尋找對應來源。'); return; }
    if (this.filter !== 'all' && !this.sources().some(x => x.provider === this.filter)) this.filter = 'all';
    this.ensureSegments(); this.loadedStatus();
  }
  async refreshSetting() {
    if (!this.episode || this.saving) return;
    const e = this.epoch, revision = this.setting && this.setting.revision, cancel = this.cancel;
    try {
      const r = await store.danmakuSettings(this.episode.episodeId, null, cancel);
      if (e !== this.epoch || this.saving || (this.setting && this.setting.revision) !== revision) return;
      if (!r.ok) throw new Error(r.data.error || '彈幕設定同步失敗。');
      if (!this.setting || r.data.entry.revision !== this.setting.revision) { this.setting = r.data.entry; this.startSource(); }
    } catch (error) {
      if (e === this.epoch && !cancel.cancelled) { this.matchErrors = this.matchErrors.filter(x => x.key !== 'setting').concat([{ key: 'setting', text: error.message || '彈幕設定同步失敗，請重試。' }]); this.loadedStatus(); }
    }
  }
  /** Replace this provider's pairing (or the whole list with `complete`). Resolves true when saved. */
  async saveSource(source, offset, complete) {
    const list = complete || (!source ? [] : this.sources().filter(x => x.provider !== source.provider).concat([Object.assign({}, source, { offset: offset || 0 })]));
    this.searchEpoch++;
    if (!this.episode || this.saving) return false;
    const e = this.epoch, id = this.episode.episodeId;
    this.saving = true; this.status('正在儲存本集彈幕設定…');
    try {
      const r = await store.danmakuSettings(id, { episodeId: id, source: list[0] || null, sources: list, offset: (list[0] && list[0].offset) || 0, revision: (this.setting && this.setting.revision) || 0 }, this.cancel);
      if (e !== this.epoch) return false;
      if (r.status === 409) { this.setting = r.data.entry; this.startSource(); throw new Error('另一裝置已更新配對，已載入最新設定，請重新選擇。'); }
      if (!r.ok) throw new Error(r.data.error || '未能儲存彈幕設定。');
      this.setting = r.data.entry; this.startSource();
      return true;
    } catch (error) {
      if (e === this.epoch) { this.status(error.message || '未能儲存，請重試。'); }
      return false;
    } finally {
      if (e === this.epoch) this.saving = false;
    }
  }
  setOffset(provider, offset) {
    if (!isFinite(offset) || Math.abs(offset) > 300) return Promise.resolve(false);
    return this.saveSource(null, 0, this.sources().map(x => (x.provider === provider ? Object.assign({}, x, { offset }) : x)));
  }
  clear() { return this.saveSource(null, 0); }
  retry() {
    this.failed.clear(); this.matchErrors = [];
    const e = this.epoch;
    void this.refreshSetting().then(() => {
      if (e !== this.epoch) return;
      this.ensureSegments();
      if (this.setting) void this.autoMatch(this.episode, e, this.searchEpoch);
    });
  }
  setEnabled(on) {
    this.enabled = on;
    if (on) { this.loadedStatus(); this.ensureSegments(); this.kick(); }
    else { cancelAnimationFrame(this.raf); this.raf = 0; this.clearCanvas(); this.status('彈幕已關閉'); }
  }
  setDensity(value) {
    this.density = value;
    try { localStorage.setItem('anime1-danmaku-density', String(value)); } catch (_) {}
    this.layoutKey = ''; this.draw(); this.changed();
  }
  setFilter(provider) {
    this.filter = provider; this.layoutKey = ''; this.loadedStatus(); this.draw();
  }

  // ---------- manual pairing ----------
  /** Search Bahamut (+ Dandanplay when configured). Resolves { results, errors }. */
  async search(q) {
    const g = ++this.searchEpoch, cancel = this.cancel;
    const availability = await getJson('/api/danmaku/providers', { cancel });
    const providers = ['bahamut'].concat(availability.dandanplay ? ['dandanplay'] : []);
    const settled = await Promise.allSettled(providers.map(p => getJson('/api/danmaku/search?q=' + encodeURIComponent(q) + '&provider=' + p, { cancel, fallback: '搜尋失敗。' })));
    if (g !== this.searchEpoch) throw Object.assign(new Error('cancelled'), { cancelled: true });
    const results = [], errors = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') r.value.results.forEach(x => results.push(x));
      else errors.push(providerName(providers[i]) + '：' + r.reason.message);
    });
    return { results, errors };
  }
  /** Episodes of a source URL (search result, Bahamut/Bilibili/Dandanplay link). */
  resolve(url) {
    return getJson('/api/danmaku/resolve?url=' + encodeURIComponent(url), { cancel: this.cancel, fallback: '讀取來源失敗。' });
  }

  // Add missing providers without replacing saved/manual pairings. Never guess seasons.
  async autoMatch(info, e, g) {
    if (!info || !info.seriesId || this.matching || (this.setting && this.setting.revision && !this.sources().length)) return;
    const m = info.title.match(/\[(\d+(?:\.\d+)?)\]\s*$/);
    const n = m && m[1];
    if (!n) return;
    const cancel = this.cancel;
    let revision = this.setting && this.setting.revision;
    const current = () => e === this.epoch && g === this.searchEpoch && revision === (this.setting && this.setting.revision) && !cancel.cancelled;
    const has = provider => this.sources().some(x => x.provider === provider);
    this.matching = true; this.loadedStatus();
    try {
      // The plain catalogue entry is immediate; the Bangumi identity may take an LLM turn.
      const plain = getJson('/api/catalog-item?id=' + encodeURIComponent(info.seriesId), { cancel });
      const matched = getJson('/api/catalog-item?id=' + encodeURIComponent(info.seriesId) + '&match=1', { cancel, timeout: 60000 });
      plain.catch(() => {}); matched.catch(() => {});
      const pair = async (provider, request) => {
        const item = (await request).item;
        if (!current() || has(provider)) return null;
        const names = [item.title].concat(item.aliases || []).map(seriesName);
        let mappingError;
        if (provider === 'dandanplay' && item.bgmId) {
          try {
            const match = await getJson('/api/danmaku/match?bgmId=' + item.bgmId + '&episode=' + encodeURIComponent(n), { cancel });
            if (match.sources.length === 1) return match.sources[0];
          } catch (error) { if (cancel.cancelled) throw error; mappingError = error; }
        }
        const noMatch = async () => {
          const fallback = await getJson('/api/danmaku/fallback?id=' + encodeURIComponent(info.seriesId) + '&provider=' + provider + '&episode=' + encodeURIComponent(n), { cancel, timeout: 60000 });
          if (fallback.sources.length === 1) return fallback.sources[0];
          if (mappingError) throw mappingError;
          return null;
        };
        const found = await getJson('/api/danmaku/search?q=' + encodeURIComponent(item.title) + '&provider=' + provider, { cancel });
        const exact = found.results.filter(x => names.indexOf(seriesName(x.title)) >= 0);
        if (exact.length !== 1) return noMatch();
        const d = await getJson('/api/danmaku/resolve?url=' + encodeURIComponent(exact[0].url), { cancel });
        const year = d.year || exact[0].year;
        if (![d.title].concat(d.aliases || []).some(x => names.indexOf(seriesName(x)) >= 0) || !/^\d{4}$/.test(year) || String(item.year).split('/').indexOf(year) < 0) return noMatch();
        const eps = pickEpisodes(d.episodes, n);
        return eps.length === 1 ? eps[0] : noMatch();
      };
      // Save each provider as soon as it pairs: a fast Bahamut match must not wait for 彈彈play.
      let saves = Promise.resolve();
      const add = source => {
        saves = saves.then(async () => {
          if (!source || !current() || this.saving || has(source.provider)) return;
          if (await this.saveSource(null, 0, this.sources().concat([Object.assign({}, source, { offset: 0 })]))) { g = this.searchEpoch; revision = this.setting && this.setting.revision; }
        });
        return saves;
      };
      const jobs = [
        pair('bahamut', plain).then(add),
        (async () => {
          const availability = await getJson('/api/danmaku/providers', { cancel });
          if (!availability.dandanplay) throw new Error('彈彈play 尚未完成後端配置');
          return add(await pair('dandanplay', matched));
        })(),
      ];
      const results = await Promise.allSettled(jobs);
      await saves;
      if (!current()) return;
      this.matchErrors = this.matchErrors.filter(x => x.key.indexOf('match') !== 0).concat(
        results.map((r, i) => (r.status === 'rejected' ? { key: 'match:' + i, text: '自動配對暫時失敗：' + r.reason.message } : null)).filter(Boolean));
      this.matching = false;
      if (!this.sources().length && !this.matchErrors.length) { this.status('未找到能確定對應本集的彈幕來源，影片仍可播放。'); return; }
      this.loadedStatus();
    } catch (error) {
      if (current()) this.matchErrors = [{ key: 'match', text: '自動配對暫時失敗：' + (error.message || '來源無法讀取') }];
    } finally {
      if (e === this.epoch) { this.matching = false; if (this.matchErrors.length) this.loadedStatus(); }
    }
  }

  // ---------- rendering ----------
  clearCanvas() { if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  buildLayout(w, h) {
    const ctx = this.ctx;
    const font = Math.max(16, Math.min(40, w / 36)), rows = Math.max(3, Math.min(this.density, Math.floor(h / (font * 1.45)))), speed = w / 7;
    ctx.font = '600 ' + font + 'px Arial, sans-serif';
    const laneEnds = [], fixedEnds = [];
    for (let i = 0; i < rows; i++) { laneEnds.push(-Infinity); fixedEnds.push(-Infinity); }
    this.layout = [];
    this.mergedComments().forEach(c => {
      const width = Math.min(w, ctx.measureText(c.text).width);
      let lane = -1;
      if (c.mode === 1) {
        for (let i = 1; i < rows - 1; i++) if (laneEnds[i] <= c.time) { lane = i; break; }
        if (lane < 0) return;
        laneEnds[lane] = c.time + (width + 24) / speed;
      } else {
        lane = c.mode === 5 ? 0 : rows - 1;
        if (fixedEnds[lane] > c.time) return;
        fixedEnds[lane] = c.time + 4;
      }
      this.layout.push(Object.assign({}, c, { width, y: font + (h - font * 1.2) * lane / rows, duration: c.mode === 1 ? (w + width) / speed : 4 }));
    });
    return { font, speed };
  }
  // TV browsers report currentTime in coarse steps; advance a wall clock between reports.
  syncClock() { this.clockMedia = this.reported = this.shown = this.video.currentTime; this.clockWall = performance.now(); }
  playhead() {
    const v = this.video, current = v.currentTime;
    if (v.paused || v.ended || v.seeking || v.readyState < 3) { this.syncClock(); return current; }
    const t = performance.now(), rate = v.playbackRate || 1, predicted = this.clockMedia + (t - this.clockWall) / 1000 * rate;
    if (current !== this.reported) {
      this.reported = current;
      const drift = current - predicted;
      if (Math.abs(drift) > 0.5) { this.clockMedia = this.shown = current; this.clockWall = t; return current; }
      this.clockMedia += drift * 0.1;
    }
    this.shown = Math.max(this.shown, this.clockMedia + (t - this.clockWall) / 1000 * rate);
    return this.shown;
  }
  // Rasterise each comment once; blitting a bitmap per frame is far cheaper on TV CPUs.
  sprite(c, dpr) {
    const key = c.color + '|' + c.text;
    let s = this.sprites.get(key);
    if (s) return s;
    if (this.sprites.size > 2000) this.sprites.clear();
    const font = this.metrics.font, pad = 4, el = document.createElement('canvas'), g = el.getContext('2d');
    if (!g) return null;
    const width = c.width + pad * 2, height = Math.ceil(font * 1.35) + pad * 2;
    el.width = Math.ceil(width * dpr); el.height = Math.ceil(height * dpr); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = '600 ' + font + 'px Arial, sans-serif'; g.lineWidth = 3; g.lineJoin = 'round'; g.strokeStyle = '#000000'; g.fillStyle = c.color;
    g.strokeText(c.text, pad, pad + font, c.width); g.fillText(c.text, pad, pad + font, c.width);
    s = { el, pad, font, width, height };
    this.sprites.set(key, s);
    return s;
  }
  draw() {
    const ctx = this.ctx, canvas = this.canvas;
    if (!ctx) return;
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!w || !h) return;
    const parts = [];
    this.segments.forEach((v, k) => parts.push(k + ':' + v.comments.length));
    const key = [w, h, dpr, this.density, this.filter, parts.join(',')].join('|');
    if (key !== this.layoutKey) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.metrics = this.buildLayout(w, h); this.layoutKey = key; }
    if (this.spriteKey !== this.metrics.font + '|' + dpr) { this.sprites.clear(); this.spriteKey = this.metrics.font + '|' + dpr; }
    ctx.clearRect(0, 0, w, h);
    if (!this.enabled || !this.episode || !this.sources().length) return;
    const time = this.playhead(), layout = this.layout;
    let lo = 0, hi = layout.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (layout[mid].time < time - 15) lo = mid + 1; else hi = mid; }
    ctx.globalAlpha = 0.85;
    for (let i = lo; i < layout.length; i++) {
      const c = layout[i], age = time - c.time;
      if (age < 0) break;
      if (age > c.duration) continue;
      const x = c.mode === 1 ? w - age * this.metrics.speed : (w - c.width) / 2, s = this.sprite(c, dpr);
      if (s) ctx.drawImage(s.el, x - s.pad, c.y - s.font - s.pad, s.width, s.height);
    }
    ctx.globalAlpha = 1;
  }
  animate() {
    this.raf = 0; this.draw();
    const v = this.video;
    if (this.enabled && this.episode && !v.paused && !v.ended && !document.hidden) this.raf = requestAnimationFrame(() => this.animate());
  }
  kick() {
    this.syncClock();
    if (!this.raf && this.enabled && this.episode && !this.video.paused && !document.hidden) this.raf = requestAnimationFrame(() => this.animate());
    else this.draw();
  }
}
