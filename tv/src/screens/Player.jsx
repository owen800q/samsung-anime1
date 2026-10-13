import { useEffect, useRef, useState } from 'preact/hooks';
import { useRouter, useKeys } from '../router.js';
import { CancelToken, apiUrl, call } from '../lib/http.js';
import { loadSeries, cachedSeries } from '../lib/series.js';
import * as store from '../lib/store.js';
import * as remote from '../lib/remote.js';
import { getSettings } from '../lib/settings.js';
import { Danmaku } from '../lib/danmaku.js';
import { clock, episodeIdOf, errorMessage, formatTime, seriesTitleOf, shortLabel } from '../lib/format.js';
import { setScreenSaver } from '../platform/tv.js';
import { Icon } from '../components/Icon.jsx';
import { toast } from '../components/Toast.jsx';
import { focusFirst } from '../lib/focus.js';
import { DanmakuPanel } from './DanmakuPanel.jsx';

const RATES = [0.75, 1, 1.25, 1.5, 2];
const OSD_TIMEOUT = 5000;
const SEEK_COMMIT_MS = 650;

/** Phone-remote transport commands for the player on top (see app.jsx). */
export const playerBus = {
  listener: null,
  emit(command) { if (this.listener) this.listener(command); },
};

/**
 * Full-screen player. Resolves the episode through the Worker (`/api/resolve`), streams
 * `/api/media`, resumes saved progress, overlays danmaku and reports state to phone remotes.
 */
export function Player({ episodeId: startId, seriesId: startSeries, seriesTitle: startSeriesTitle, title: startTitle, autoplay }) {
  const router = useRouter();
  const video = useRef(null);
  const canvas = useRef(null);
  const danmaku = useRef(null);
  const settings = useRef(getSettings());
  const [episodeId, setEpisodeId] = useState(String(startId));
  const [seriesId, setSeriesId] = useState(startSeries || null);
  const [series, setSeries] = useState(() => (startSeries ? cachedSeries(startSeries) : null));
  const [playback, setPlayback] = useState(null); // /api/resolve result
  const [status, setStatus] = useState('loading'); // loading | ready | playing | paused | ended | error
  const [message, setMessage] = useState('正在準備影片…');
  const [error, setError] = useState('');
  const [time, setTime] = useState({ current: 0, duration: 0, buffered: 0 });
  const [buffering, setBuffering] = useState(false);
  const [osd, setOsd] = useState(true);
  const [panel, setPanel] = useState(null); // 'episodes' | 'speed' | 'danmaku' | null
  const [rate, setRate] = useState(1);
  const [seekTarget, setSeekTarget] = useState(null);
  const [notice, setNotice] = useState('');
  const [dm, setDm] = useState(null);
  const [reload, setReload] = useState({ n: 0, refresh: false });
  const osdTimer = useRef(0);
  const seekTimer = useRef(0);
  const seekRef = useRef(null);
  const noticeTimer = useRef(0);
  const pendingResume = useRef(null);
  const armed = useRef(false);
  const lastSaved = useRef(0);
  const lastRecorded = useRef('');
  const autoplayNext = useRef(autoplay !== false);
  const info = useRef({ seriesTitle: startSeriesTitle || seriesTitleOf(startTitle), title: startTitle || '' });

  const episodes = series ? series.episodes : [];
  const at = episodes.findIndex(ep => ep.id === episodeId);
  const prev = at > 0 ? episodes[at - 1] : playback && playback.previous ? { id: episodeIdOf(playback.previous.url), title: playback.previous.title } : null;
  const next = at >= 0 && at < episodes.length - 1 ? episodes[at + 1] : playback && playback.next && at < 0 ? { id: episodeIdOf(playback.next.url), title: playback.next.title } : null;
  const live = useRef({});
  live.current = { prev, next, playback, status, panel, osd, episodeId, seriesId };

  // ---------- OSD ----------
  function showOsd(keep) {
    setOsd(true);
    clearTimeout(osdTimer.current);
    if (!keep) osdTimer.current = setTimeout(() => {
      const v = video.current;
      if (v && !v.paused && !live.current.panel) setOsd(false);
    }, OSD_TIMEOUT);
  }
  function flash(text) {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 4000);
  }

  // ---------- progress ----------
  function saveProgress() {
    const v = video.current, p = live.current.playback;
    if (!p || !armed.current || pendingResume.current || !(v.duration > 0) || !isFinite(v.duration)) return;
    lastSaved.current = Date.now();
    const id = episodeIdOf(p.url);
    const fingerprint = [id, Math.floor(v.currentTime * 10), v.ended].join(':');
    if (fingerprint === lastRecorded.current) return;
    lastRecorded.current = fingerprint;
    store.save({ episodeId: id, seriesId: p.seriesId || live.current.seriesId, title: p.title, seriesTitle: info.current.seriesTitle || seriesTitleOf(p.title), position: v.currentTime, duration: v.duration, completed: v.ended });
  }
  function restorePosition() {
    const v = video.current, saved = pendingResume.current;
    if (!saved || !(v.duration > 0) || !isFinite(v.duration)) return;
    pendingResume.current = null;
    v.currentTime = saved.completed ? 0 : Math.min(saved.position, Math.max(0, v.duration - 0.25));
    flash(saved.completed ? '本集已看完，從頭播放。' : '已接續上次進度 ' + clock(v.currentTime));
  }
  function report(cleared) {
    const v = video.current, p = live.current.playback;
    remote.setPlaying(!cleared && p ? {
      episodeId: episodeIdOf(p.url), title: p.title, position: v.currentTime || 0,
      duration: v.duration > 0 && isFinite(v.duration) ? v.duration : null, paused: v.paused,
      hasPrevious: !!live.current.prev, hasNext: !!live.current.next,
    } : null);
  }

  // ---------- series ----------
  useEffect(() => {
    if (!seriesId) return undefined;
    const cancel = new CancelToken();
    loadSeries(seriesId, 0, { cancel }).then(data => { setSeries(data); if (!info.current.seriesTitle) info.current.seriesTitle = data.title; }).catch(() => {});
    return () => cancel.cancel();
  }, [seriesId]);

  // ---------- load an episode ----------
  useEffect(() => {
    const v = video.current;
    const cancel = new CancelToken();
    if (danmaku.current) danmaku.current.stop();
    saveProgress();
    armed.current = false; pendingResume.current = null;
    setPlayback(null); setStatus('loading'); setError(''); setMessage('正在準備影片…'); setBuffering(false);
    setTime({ current: 0, duration: 0, buffered: 0 }); setSeekTarget(null); seekRef.current = null;
    showOsd(true);
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {}
    const slow = setTimeout(() => { if (!cancel.cancelled) setMessage('原站回應較慢，仍在取得播放資料…'); }, 12000);
    const sync = store.refresh();
    call('/api/resolve', { body: { url: 'https://anime1.me/' + episodeId, refresh: reload.refresh }, timeout: 65000, cancel, timeoutMessage: '取得播放資料逾時，請按「重新載入」重試。' }).then(async r => {
      if (!r.json) throw new Error('播放服務未能回應，請稍後重試。');
      if (!r.ok) throw new Error(r.data.error || '未能準備影片。');
      const data = r.data;
      if (!/^\/api\/media\?id=\d{1,10}$/.test(data.media) || typeof data.title !== 'string') throw new Error('播放資料不完整。');
      await sync;
      if (cancel.cancelled) return;
      if (data.seriesId && !live.current.seriesId) setSeriesId(String(data.seriesId));
      info.current.title = data.title;
      if (!info.current.seriesTitle) info.current.seriesTitle = seriesTitleOf(data.title);
      pendingResume.current = store.get(episodeIdOf(data.url)) || null;
      setPlayback(data);
      live.current.playback = data;
      setStatus('ready');
      setMessage('影片已準備好');
      v.src = apiUrl(data.media);
      v.playbackRate = rate;
      v.load();
      if (danmaku.current) void danmaku.current.open({ episodeId: episodeIdOf(data.url), title: data.title, seriesTitle: info.current.seriesTitle, seriesId: data.seriesId || live.current.seriesId });
      report();
      if (autoplayNext.current) {
        const p = v.play();
        if (p && p.catch) p.catch(() => { setMessage('請按確認鍵開始播放'); showOsd(true); });
      } else showOsd(true);
      autoplayNext.current = true;
    }).catch(e => {
      if (cancel.cancelled) return;
      setStatus('error');
      setError(errorMessage(e, '連線失敗，請重試。'));
      showOsd(true);
    }).then(() => clearTimeout(slow));
    return () => { cancel.cancel(); clearTimeout(slow); };
  }, [episodeId, reload.n]);

  // ---------- video events, danmaku, remote, lifecycle ----------
  useEffect(() => {
    const v = video.current;
    danmaku.current = new Danmaku(v, canvas.current, setDm);
    const on = (name, fn) => { v.addEventListener(name, fn); return () => v.removeEventListener(name, fn); };
    let started = false;
    const offs = [
      on('loadedmetadata', () => { restorePosition(); v.playbackRate = rateRef.current; }),
      on('durationchange', restorePosition),
      on('playing', () => {
        restorePosition();
        armed.current = true; lastSaved.current = Date.now();
        setStatus('playing'); setBuffering(false); setError(''); setScreenSaver(false); report();
        if (!started) { started = true; showOsd(); }
      }),
      on('pause', () => { saveProgress(); if (!v.ended && live.current.playback) { setStatus('paused'); showOsd(true); } setScreenSaver(true); report(); }),
      on('waiting', () => setBuffering(true)),
      on('canplay', () => setBuffering(false)),
      on('timeupdate', () => {
        const buffered = v.buffered && v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
        setTime({ current: v.currentTime, duration: v.duration || 0, buffered });
        if (Date.now() - lastSaved.current >= 15000) saveProgress();
        report();
      }),
      on('seeked', () => { saveProgress(); report(); }),
      on('ended', () => {
        saveProgress(); setScreenSaver(true); report();
        const n = live.current.next;
        if (settings.current.autoNext && n) go(n.id);
        else { setStatus('ended'); showOsd(true); }
      }),
      on('error', () => {
        if (!v.getAttribute('src') || !live.current.playback) return;
        const code = v.error && v.error.code;
        setStatus('error');
        setError('影片未能播放（' + (code || '未知') + '），可按「重新載入」更新播放連線。' + (code === 4 ? ' 電視可能無法解碼這一集的片源格式。' : ''));
        showOsd(true);
      }),
    ];
    const onHide = () => { if (document.hidden) { saveProgress(); v.pause(); } };
    document.addEventListener('visibilitychange', onHide);
    playerBus.listener = command => {
      if (command.type === 'toggle') togglePlay();
      else if (command.type === 'seek' && live.current.playback && isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + command.delta));
      else if (command.type === 'next' && live.current.next) go(live.current.next.id);
      else if (command.type === 'previous' && live.current.prev) go(live.current.prev.id);
    };
    // Pairing switches the cloud profile: stop, then reload the episode under the new profile.
    const offStore = store.subscribe(kind => {
      if (kind === 'profile-changing') { if (danmaku.current) danmaku.current.stop(); saveProgress(); armed.current = false; v.pause(); lastRecorded.current = ''; }
      if ((kind === 'profile-changed' || kind === 'playback-resume') && live.current.playback) { autoplayNext.current = false; setReload(r => ({ n: r.n + 1, refresh: false })); }
    });
    return () => {
      saveProgress();
      offs.forEach(off => off());
      offStore();
      playerBus.listener = null;
      document.removeEventListener('visibilitychange', onHide);
      clearTimeout(osdTimer.current); clearTimeout(seekTimer.current); clearTimeout(noticeTimer.current);
      danmaku.current.destroy(); danmaku.current = null;
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {}
      setScreenSaver(true);
      remote.setPlaying(null);
    };
  }, []);

  const rateRef = useRef(rate);
  rateRef.current = rate;

  // ---------- actions ----------
  function togglePlay() {
    const v = video.current, s = live.current.status;
    if (s === 'error' || s === 'loading' || !live.current.playback) return;
    if (s === 'ended') v.currentTime = 0;
    if (v.paused) {
      const p = v.play();
      if (p && p.catch) p.catch(e => flash(e && e.name === 'NotAllowedError' ? '請再按一次播放鍵，允許電視開始播放。' : '電視未能開始播放，可按「重新載入」更新影片連線。'));
    } else v.pause();
    showOsd();
  }
  function seekBy(delta) {
    const v = video.current;
    if (!v.duration || live.current.status === 'loading' || live.current.status === 'error') return;
    const base = seekRef.current != null ? seekRef.current : v.currentTime;
    const target = Math.max(0, Math.min(v.duration - 1, base + delta));
    seekRef.current = target;
    setSeekTarget(target);
    if (live.current.osd) showOsd();
    clearTimeout(seekTimer.current);
    // Rapid presses accumulate; the video seeks once the user pauses.
    seekTimer.current = setTimeout(() => {
      v.currentTime = target;
      seekRef.current = null;
      setSeekTarget(null);
    }, SEEK_COMMIT_MS);
  }
  function go(id) {
    if (!id || id === live.current.episodeId) return;
    saveProgress();
    setPanel(null);
    autoplayNext.current = true;
    setEpisodeId(String(id));
  }
  function reloadEpisode() {
    autoplayNext.current = true;
    setReload(r => ({ n: r.n + 1, refresh: true }));
  }
  function changeRate(r) {
    setRate(r);
    if (video.current) video.current.playbackRate = r;
    setPanel(null);
    showOsd();
  }
  function openPanel(name) {
    setPanel(name);
    setOsd(true);
    clearTimeout(osdTimer.current);
  }
  function toggleDanmaku() {
    const d = danmaku.current;
    if (!d) return;
    d.setEnabled(!d.enabled);
    flash(d.enabled ? '彈幕：開' : '彈幕：關');
  }

  useEffect(() => {
    if (panel === 'episodes' || panel === 'speed') setTimeout(() => focusFirst('.player-panel .is-current'), 0);
    if (!panel) setTimeout(() => { if (osd) focusFirst('.player-controls [data-autofocus]'); }, 0);
  }, [panel]);

  useEffect(() => {
    if (status === 'error') setTimeout(() => focusFirst('.player-error [data-autofocus]'), 0);
    else if (osd && !panel) setTimeout(() => {
      const el = document.activeElement;
      if (!el || !el.closest || !el.closest('.player-osd')) focusFirst('.player-controls [data-autofocus]');
    }, 0);
  }, [status, osd]);

  function leave() { saveProgress(); router.back(); }

  useKeys(action => {
    if (panel) {
      if (action === 'back') { setPanel(null); return true; }
      if (action === 'playpause' || action === 'play' || action === 'pause') { togglePlay(); return true; }
      return false;
    }
    if (status === 'error') {
      if (action === 'back') { leave(); return true; }
      if (action === 'next' && next) { go(next.id); return true; }
      if (action === 'previous' && prev) { go(prev.id); return true; }
      return false;
    }
    const v = video.current;
    switch (action) {
      case 'playpause': togglePlay(); return true;
      case 'play': if (v.paused) togglePlay(); return true;
      case 'pause': if (!v.paused) togglePlay(); return true;
      case 'stop': leave(); return true;
      case 'forward': seekBy(settings.current.seekStep * 3); return true;
      case 'rewind': seekBy(-settings.current.seekStep * 3); return true;
      case 'next': if (next) go(next.id); return true;
      case 'previous': if (prev) go(prev.id); return true;
      case 'green': openPanel('episodes'); return true;
      case 'yellow': openPanel('speed'); return true;
      case 'blue': openPanel('danmaku'); return true;
      case 'red': toggleDanmaku(); return true;
      case 'info': showOsd(); return true;
      default: break;
    }
    if (!osd) {
      // Bare video: arrows act directly, any other key wakes the controls.
      if (action === 'left') { seekBy(-settings.current.seekStep); return true; }
      if (action === 'right') { seekBy(settings.current.seekStep); return true; }
      if (action === 'enter') { togglePlay(); return true; }
      if (action === 'down') { openPanel('episodes'); return true; }
      if (action === 'up') { showOsd(); return true; }
      if (action === 'back') { leave(); return true; }
      return false;
    }
    showOsd();
    const focused = document.activeElement;
    const onBar = focused && focused.classList && focused.classList.contains('player-bar');
    if (onBar && (action === 'left' || action === 'right')) { seekBy(action === 'left' ? -settings.current.seekStep : settings.current.seekStep); return true; }
    if (action === 'back') {
      if (status === 'playing') { setOsd(false); return true; }
      leave(); return true;
    }
    return false;
  });

  const shownTime = seekTarget != null ? seekTarget : time.current;
  const pct = time.duration ? Math.min(100, shownTime / time.duration * 100) : 0;
  const bufferedPct = time.duration ? Math.min(100, time.buffered / time.duration * 100) : 0;
  const title = playback ? playback.title : info.current.title || '準備影片中';
  const current = at >= 0 ? episodes[at] : null;

  return (
    <div class={'player' + (osd || status !== 'playing' ? ' osd-visible' : '')}>
      <video ref={video} class="player-video" preload="auto" playsinline />
      <canvas ref={canvas} class="player-danmaku" aria-hidden="true" />

      {(status === 'loading' || buffering) && status !== 'error' && (
        <div class="player-loading">
          <span class="spinner spinner-lg" />
          <span>{status === 'loading' ? message : '緩衝中…'}</span>
        </div>
      )}

      {seekTarget != null && !osd && (
        <div class="player-seek-badge">
          <div>{seekTarget >= time.current ? '▶▶ ' : '◀◀ '}{formatTime(seekTarget)} / {formatTime(time.duration)}</div>
          <div class="player-seek-line"><i style={{ width: pct + '%' }} /></div>
        </div>
      )}

      {notice && <div class="player-notice">{notice}</div>}

      {status === 'error' && (
        <div class="player-error" data-focus-scope>
          <div class="player-error-title">暫時未能載入</div>
          <div class="player-error-text">{error}</div>
          <div class="player-error-actions">
            <button type="button" tabIndex={-1} class="btn btn-primary focusable" data-autofocus onClick={reloadEpisode}><Icon name="refresh" />重新載入</button>
            {next && <button type="button" tabIndex={-1} class="btn focusable" onClick={() => go(next.id)}>播放下一集</button>}
            <button type="button" tabIndex={-1} class="btn focusable" onClick={leave}>返回</button>
          </div>
        </div>
      )}

      <div class="player-top">
        <div class="player-title">{title}</div>
        <div class="player-sub">
          {status === 'playing' ? '播放中' : status === 'paused' ? '已暫停' : status === 'ended' ? '本集播放完畢' : status === 'ready' ? '影片已準備好' : status === 'error' ? '未能載入' : '準備中'}
          {episodes.length ? ' · ' + (current ? current.label : '') + ' / 共 ' + episodes.length + ' 集' : ''}
          {rate !== 1 ? ' · ' + rate + '×' : ''}
          {dm && !dm.enabled ? ' · 彈幕已關閉' : ''}
        </div>
      </div>

      {status !== 'error' && (
        <div class="player-osd">
          <div class="player-bar-row">
            <span class="player-time">{formatTime(shownTime)}</span>
            <div class="player-bar focusable" tabIndex={-1} role="slider" aria-label="播放進度"
              aria-valuemin={0} aria-valuemax={Math.floor(time.duration)} aria-valuenow={Math.floor(shownTime)} data-nav-up="none">
              <i class="player-bar-buffered" style={{ width: bufferedPct + '%' }} />
              <i class="player-bar-fill" style={{ width: pct + '%' }} />
              <i class="player-bar-knob" style={{ left: pct + '%' }} />
            </div>
            <span class="player-time">{formatTime(time.duration)}</span>
          </div>
          <div class="player-controls">
            <button type="button" tabIndex={-1} class="ctrl focusable" disabled={!prev} onClick={() => prev && go(prev.id)} aria-label="上一集"><Icon name="prev" /><span>上一集</span></button>
            <button type="button" tabIndex={-1} class="ctrl ctrl-main focusable" data-autofocus onClick={togglePlay} disabled={!playback} aria-label={status === 'playing' ? '暫停' : '播放'}>
              <Icon name={status === 'playing' ? 'pause' : 'play'} /><span>{status === 'playing' ? '暫停' : status === 'ended' ? '重播' : '播放'}</span>
            </button>
            <button type="button" tabIndex={-1} class="ctrl focusable" disabled={!next} onClick={() => next && go(next.id)} aria-label="下一集"><Icon name="next" /><span>下一集</span></button>
            <button type="button" tabIndex={-1} class="ctrl focusable" disabled={!episodes.length} onClick={() => openPanel('episodes')}><Icon name="list" /><span>選集</span></button>
            <button type="button" tabIndex={-1} class="ctrl focusable" onClick={() => openPanel('danmaku')}><Icon name="chat" /><span>彈幕{dm && !dm.enabled ? '（關）' : ''}</span></button>
            <button type="button" tabIndex={-1} class="ctrl focusable" onClick={() => openPanel('speed')}><Icon name="speed" /><span>{rate}×</span></button>
            <button type="button" tabIndex={-1} class="ctrl focusable" onClick={reloadEpisode}><Icon name="refresh" /><span>重新載入</span></button>
          </div>
          <div class="player-hints">
            <span><b>◀ ▶</b> 快退／快進 {settings.current.seekStep} 秒</span>
            <span><b>頻道 ▲▼</b> 上／下一集</span>
            <span><b class="key-red" /> 彈幕開關</span>
            <span><b class="key-green" /> 選集</span>
            <span><b class="key-yellow" /> 倍速</span>
            <span><b class="key-blue" /> 彈幕設定</span>
          </div>
        </div>
      )}

      {panel === 'episodes' && (
        <div class="player-panel" data-focus-scope>
          <h2 class="player-panel-title">選集 <small>{(series && series.title) || ''} · 共 {episodes.length} 集</small></h2>
          <div class="player-panel-body" data-scroll="y" data-scroll-pad="80">
            <div class="episode-grid episode-grid-compact">
              {episodes.map(ep => {
                const saved = store.get(ep.id);
                return (
                  <button key={ep.id} type="button" tabIndex={-1} class={'episode focusable' + (ep.id === episodeId ? ' is-current is-watching' : '') + (saved && saved.completed ? ' is-done' : '')}
                    onClick={() => go(ep.id)} aria-label={ep.label}>
                    <span class="episode-label">{shortLabel(ep.label)}</span>
                    {saved && saved.duration ? <span class="episode-progress"><i style={{ width: Math.min(100, (saved.completed ? 1 : saved.position / saved.duration) * 100) + '%' }} /></span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {panel === 'speed' && (
        <div class="player-panel player-panel-narrow" data-focus-scope>
          <h2 class="player-panel-title">播放速度</h2>
          <div class="speed-list">
            {RATES.map(r => (
              <button key={r} type="button" tabIndex={-1} class={'speed-item focusable' + (r === rate ? ' is-current' : '')} onClick={() => changeRate(r)}>
                {r === 1 ? '1.0× 正常' : r + '×'}
              </button>
            ))}
          </div>
        </div>
      )}

      {panel === 'danmaku' && danmaku.current && <DanmakuPanel engine={danmaku.current} state={dm} onClose={() => setPanel(null)} toast={toast} />}
    </div>
  );
}
