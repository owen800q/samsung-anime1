import { useEffect, useRef, useState } from 'preact/hooks';
import { useRouter, useActive } from '../router.js';
import { CancelToken, apiUrl, json } from '../lib/http.js';
import { loadSeries } from '../lib/series.js';
import * as store from '../lib/store.js';
import { clock, errorMessage, facts, shortLabel } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { Empty, Spinner } from '../components/Status.jsx';
import { focusFirst } from '../lib/focus.js';

const RANGE = 50;

/** Anime details, episode grid with saved progress, and Bangumi short comments. */
export function Detail({ item: initial, id: initialId }) {
  const router = useRouter();
  const active = useActive();
  const animeId = String(initial ? initial.id : initialId);
  const [item, setItem] = useState(initial || null);
  const [itemError, setItemError] = useState('');
  const [meta, setMeta] = useState(null);
  const [series, setSeries] = useState(null);
  const [seriesError, setSeriesError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [range, setRange] = useState(0);
  const [history, setHistory] = useState(0);
  const [coverBroken, setCoverBroken] = useState(false);
  const [comments, setComments] = useState({ page: 1, list: [], status: '', loading: false, error: false, nextPage: null, total: 0 });
  const token = useRef(new CancelToken());
  const commentsToken = useRef(null);
  const rangeSet = useRef(false);

  useEffect(() => () => { token.current.cancel(); if (commentsToken.current) commentsToken.current.cancel(); }, []);
  useEffect(() => store.subscribe(kind => { if (kind === 'history') setHistory(h => h + 1); }), []);
  useEffect(() => { if (active) { void store.refresh(); setHistory(h => h + 1); } }, [active]);

  // ---------- catalogue item, Bangumi metadata, identity matching ----------
  function loadMeta(target) {
    json('/api/metadata?ids=' + target.id, { cancel: token.current }).then(data => setMeta(data.details[target.id] || null)).catch(() => {});
  }
  function withItem(target) {
    setItem(target);
    if (target.bgmId) { loadMeta(target); loadComments(target, 1); return; }
    setComments(c => Object.assign({}, c, { status: '這套動畫尚未配對 Bangumi，暫未能顯示評論。' }));
    // Unmatched titles may still resolve through the Worker's title matching (can take ~1 minute).
    json('/api/catalog-item?id=' + target.id + '&match=1', { cancel: token.current, timeout: 60000 }).then(data => {
      if (!data.item.bgmId) return;
      const next = Object.assign({}, target, data.item);
      setItem(next);
      setCoverBroken(false);
      loadMeta(next);
      loadComments(next, 1);
    }).catch(() => {});
  }
  function loadItem() {
    setItemError('');
    json('/api/catalog-item?id=' + encodeURIComponent(animeId), { cancel: token.current }).then(data => withItem(data.item))
      .catch(e => { if (!e.cancelled) setItemError(errorMessage(e, '動畫資料暫時無法讀取。')); });
  }
  useEffect(() => {
    if (initial) withItem(initial); else loadItem();
    loadEpisodes(0);
  }, []);

  // ---------- episodes ----------
  function loadEpisodes(page) {
    setSeriesError('');
    if (page) setLoadingMore(true);
    loadSeries(animeId, page, { cancel: token.current }).then(data => {
      setSeries(data);
      setLoadingMore(false);
      if (!rangeSet.current) {
        rangeSet.current = true;
        const last = store.latest(animeId);
        const at = last ? data.episodes.findIndex(ep => ep.id === String(last.episodeId)) : -1;
        if (at > 0) setRange(Math.floor(at / RANGE));
      }
    }).catch(e => {
      setLoadingMore(false);
      if (!e.cancelled) setSeriesError(errorMessage(e, '讀取集數失敗。'));
    });
  }

  // ---------- comments ----------
  function loadComments(target, page) {
    if (commentsToken.current) commentsToken.current.cancel();
    const cancel = commentsToken.current = new CancelToken();
    setComments(c => Object.assign({}, c, { loading: true, error: false, status: '正在讀取 Bangumi 評論…' }));
    json('/api/comments?id=' + target.id + '&page=' + page, { cancel }).then(data => {
      const status = !data.matched ? '這套動畫尚未配對 Bangumi，暫未能顯示評論。' : data.total === 0 ? '暫時未有 Bangumi 短評。'
        : data.comments.length ? '共 ' + data.total + ' 則短評 · 最新在前 · 可能包含劇透' : '這一頁暫未有可顯示的短評。';
      setComments({ page, list: data.comments, status, loading: false, error: false, nextPage: data.nextPage, total: data.total });
    }).catch(e => {
      if (cancel.cancelled) return;
      setComments(c => Object.assign({}, c, { loading: false, error: true, retryPage: page, status: 'Bangumi 評論暫時無法讀取。' + (c.list.length ? ' 仍顯示第 ' + c.page + ' 頁。' : '') }));
    });
  }

  useEffect(() => {
    if (series && active) setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) focusFirst('.screen.is-active [data-autofocus]'); }, 30);
  }, [series]);

  const episodes = series ? series.episodes : [];
  void history;
  const last = store.latest(animeId);
  const resumeIndex = last ? episodes.findIndex(ep => ep.id === String(last.episodeId)) : -1;
  const ranges = [];
  for (let i = 0; i < episodes.length; i += RANGE) ranges.push({ start: i, end: Math.min(episodes.length, i + RANGE) });
  const shown = ranges[range] ? episodes.slice(ranges[range].start, ranges[range].end) : [];
  const title = item ? item.title : (series && series.title) || '正在讀取動畫…';
  const coverId = item && item.bgmId && !coverBroken ? item.id : null;

  // Archive page 1 holds the newest episodes; starting from the first one needs the older pages.
  async function playFirst() {
    let data = series;
    setLoadingMore(true);
    try {
      for (let i = 0; data.nextPage && i < 20; i++) data = await loadSeries(animeId, data.nextPage, { cancel: token.current });
    } catch (e) {
      if (!e.cancelled) setSeriesError(errorMessage(e, '讀取集數失敗。'));
    }
    setLoadingMore(false);
    setSeries(data);
    play(data.episodes[0]);
  }

  function play(ep) {
    router.watch({ episodeId: ep.id, seriesId: animeId, seriesTitle: (series && series.title) || title, title: ((series && series.title) || title) + ' ' + ep.label, autoplay: true });
  }

  return (
    <div class="detail" data-scroll="y" data-scroll-pad="140">
      <div class="detail-backdrop" style={coverId ? { backgroundImage: 'url("' + apiUrl('/api/cover?id=' + coverId) + '")' } : null} />
      <div class="detail-hero">
        <div class="detail-cover">
          <div class="poster-fallback"><small>ANIME</small><strong>{title}</strong></div>
          {coverId ? <img src={apiUrl('/api/cover?id=' + coverId)} alt="" onError={() => setCoverBroken(true)} /> : null}
        </div>
        <div class="detail-info">
          <div class="detail-eyebrow">{item ? facts(item) : '準備開播'}</div>
          <h1 class="detail-title">{title}</h1>
          {meta && meta.score ? <p class="detail-rating"><Icon name="star" />Bangumi {Number(meta.score).toFixed(1)} / 10 · {meta.ratingCount} 人評分{meta.rank ? ' · 排名 #' + meta.rank : ''}</p> : null}
          {meta && meta.tags && meta.tags.length ? <div class="detail-tags">{meta.tags.map(t => <span key={t} class="tag">{t}</span>)}</div> : null}
          <p class="detail-intro">{itemError || (meta && meta.summary) || '暫未有簡介，仍然可以從下方選集播放。'}</p>
          <p class="detail-history">{last ? '上次觀看：' + last.title + ' · ' + (last.completed ? '已看完' : '看到 ' + clock(last.position)) : '尚未有觀看紀錄'}</p>
          <div class="detail-actions">
            <button type="button" tabIndex={-1} class="btn btn-primary btn-lg focusable" data-autofocus disabled={!episodes.length || loadingMore}
              onClick={() => (resumeIndex >= 0 ? play(episodes[resumeIndex]) : playFirst())}>
              <Icon name="play" />
              {resumeIndex >= 0 ? '繼續播放 ' + episodes[resumeIndex].label : loadingMore ? '正在讀取集數…' : '由第一集開始播放'}
            </button>
            {resumeIndex >= 0 && (resumeIndex > 0 || (series && series.nextPage)) && <button type="button" tabIndex={-1} class="btn btn-lg focusable" disabled={loadingMore} onClick={playFirst}>從第一集看</button>}
            {itemError && <button type="button" tabIndex={-1} class="btn btn-lg focusable" onClick={loadItem}><Icon name="refresh" />重新讀取</button>}
          </div>
        </div>
      </div>

      <section class="episodes">
        <h2 class="section-title">選擇集數{series ? <small> · 已載入 {episodes.length} 集</small> : null}</h2>
        {seriesError && !series && <Empty title="讀取集數失敗" message={seriesError} actionLabel="重新讀取集數" onAction={() => loadEpisodes(0)} />}
        {!series && !seriesError && <Spinner label="正在讀取集數…" />}
        {ranges.length > 1 && (
          <div class="tab-row tab-row-sm" data-scroll="x" data-scroll-pad="120">
            <div class="tab-row-track" data-focus-group="detail-ranges">
              {ranges.map((r, i) => (
                <button key={i} type="button" tabIndex={-1} class={'chip focusable' + (i === range ? ' is-selected' : '')}
                  onClick={() => setRange(i)}>{shortLabel(episodes[r.start].label)}–{shortLabel(episodes[r.end - 1].label)}</button>
              ))}
            </div>
          </div>
        )}
        <div class="episode-grid" data-focus-group="detail-episodes">
          {shown.map(ep => {
            const saved = store.get(ep.id);
            const watching = last && String(last.episodeId) === ep.id;
            return (
              <button key={ep.id} type="button" tabIndex={-1} class={'episode focusable' + (watching ? ' is-watching' : '') + (saved && saved.completed ? ' is-done' : '')}
                onClick={() => play(ep)} aria-label={ep.label}>
                <span class="episode-label">{shortLabel(ep.label)}</span>
                {saved ? <small class="episode-note">{saved.completed ? '已看完' : clock(saved.position)}</small> : null}
                {saved && saved.duration ? <span class="episode-progress"><i style={{ width: Math.min(100, (saved.completed ? 1 : saved.position / saved.duration) * 100) + '%' }} /></span> : null}
              </button>
            );
          })}
        </div>
        {series && series.nextPage && (
          <button type="button" tabIndex={-1} class="btn focusable" disabled={loadingMore} onClick={() => loadEpisodes(series.nextPage)}>
            {loadingMore ? '正在讀取…' : '載入較早集數'}
          </button>
        )}
        {series && seriesError && <p class="detail-note">{seriesError}</p>}
      </section>

      <section class="comments">
        <h2 class="section-title"><Icon name="chat" /> Bangumi 評論</h2>
        <p class="detail-note">{comments.status}</p>
        <div class="comment-list" data-focus-group="detail-comments">
          {comments.list.map((c, i) => (
            <article key={comments.page + ':' + i} class="comment focusable" tabIndex={-1}>
              <div class="comment-meta">
                <strong>{c.author}</strong>
                {c.rating != null ? <span class="comment-rating">★ {c.rating} / 10</span> : null}
                {c.updatedAt ? <time>{new Date(c.updatedAt * 1000).toLocaleDateString('zh-HK')}</time> : null}
              </div>
              <p>{c.text}</p>
            </article>
          ))}
        </div>
        <div class="comment-pages">
          {comments.error && <button type="button" tabIndex={-1} class="btn focusable" onClick={() => loadComments(item, comments.retryPage || 1)}><Icon name="refresh" />重試載入評論</button>}
          {(comments.page > 1 || comments.nextPage) && (
            <div class="comment-pager">
              <button type="button" tabIndex={-1} class="btn focusable" disabled={comments.loading || comments.page <= 1} onClick={() => loadComments(item, comments.page - 1)}>← 上一頁</button>
              <span>第 {comments.page} 頁</span>
              <button type="button" tabIndex={-1} class="btn focusable" disabled={comments.loading || !comments.nextPage} onClick={() => loadComments(item, comments.nextPage)}>下一頁 →</button>
            </div>
          )}
        </div>
        <p class="attribution">動畫資料：Bangumi、bangumi-data（CC BY 4.0）· 片源：Anime1 · 獨立相容介面，並非 Anime1 官方網站。</p>
      </section>
    </div>
  );
}
