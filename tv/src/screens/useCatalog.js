import { useEffect, useRef, useState } from 'preact/hooks';
import { CancelToken, json } from '../lib/http.js';
import { errorMessage } from '../lib/format.js';

// Bangumi details (score/rank) shared by every grid in this session.
const details = {};

/**
 * Paged `/api/catalog` results for `query` (an object of filter params, or null to stay idle).
 * Matched titles are hydrated with Bangumi scores 8 at a time, like the website.
 */
export function useCatalog(query) {
  const key = query ? JSON.stringify(query) : '';
  const [state, setState] = useState({ items: [], nextPage: null, loading: !!query, error: '', total: null, years: [], genres: [], notes: [], sort: null, page: 0 });
  const [, setVersion] = useState(0);
  const token = useRef(null);

  function hydrate(list, cancel) {
    const missing = list.filter(item => item.bgmId && !(item.id in details));
    (async () => {
      for (let i = 0; i < missing.length; i += 8) {
        if (cancel.cancelled) return;
        try {
          const data = await json('/api/metadata?ids=' + missing.slice(i, i + 8).map(x => x.id).join(','), { cancel });
          missing.slice(i, i + 8).forEach(item => { details[item.id] = data.details[item.id]; });
          setVersion(v => v + 1);
        } catch (_) { if (cancel.cancelled) return; }
      }
    })();
  }

  function load(page) {
    if (!query) return;
    if (token.current && page === 1) token.current.cancel();
    if (page === 1 || !token.current) token.current = new CancelToken();
    const cancel = token.current;
    const params = Object.assign({ page: String(page) }, query);
    const qs = Object.keys(params).filter(k => params[k] !== '' && params[k] != null).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
    setState(s => Object.assign({}, s, { loading: true, error: '' }, page === 1 ? { items: [], nextPage: null, page: 0 } : null));
    json('/api/catalog?' + qs, { cancel }).then(data => {
      if (cancel.cancelled) return;
      data.items.forEach(item => { if (item.metadata && !(item.id in details)) details[item.id] = item.metadata; });
      const notes = [];
      if (data.stale) notes.push('Anime1 目錄暫時未能更新，現顯示已儲存的目錄。');
      if (data.total == null) notes.push((data.genre ? '題材分類' : '排行榜') + '只顯示已配對 Bangumi 資料、且 Anime1 有收錄的動畫。');
      setState(s => {
        const seen = {};
        const base = page === 1 ? [] : s.items;
        base.forEach(x => { seen[x.id] = true; });
        const fresh = data.items.filter(x => !seen[x.id]);
        return { items: base.concat(fresh), nextPage: data.nextPage, loading: false, error: '', total: data.total, years: data.years || s.years, genres: data.genres || s.genres, notes, sort: data.sort, page };
      });
      hydrate(data.items, cancel);
    }).catch(error => {
      if (cancel.cancelled) return;
      setState(s => Object.assign({}, s, { loading: false, error: errorMessage(error, '未能載入目錄') }));
    });
  }

  useEffect(() => {
    if (query) load(1);
    else setState(s => Object.assign({}, s, { items: [], loading: false, error: '', nextPage: null }));
    return () => { if (token.current) token.current.cancel(); };
  }, [key]);

  return {
    state,
    details,
    more() { if (state.nextPage && !state.loading && !state.error) load(state.nextPage); },
    retry() { load(state.items.length && state.nextPage ? state.nextPage : 1); },
    caption() {
      const n = state.items.length;
      if (!n) return state.nextPage ? '這頁暫未配對到片源，可以繼續向下搵。' : '';
      return state.total == null ? '已找到 ' + n + ' 套 · 依 Bangumi ' + (state.sort === 'rank' ? '排名' : '熱度') + '排序' : '共 ' + state.total + ' 套 · 已顯示 ' + n + ' 套';
    },
  };
}
