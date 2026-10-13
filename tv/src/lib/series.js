// Episode lists from `/api/series` (Anime1 category archive), merged across archive pages
// and cached for the session so the detail page and the player share them.
import { json } from './http.js';
import { episodeIdOf } from './format.js';

const cache = {};

function sortEpisodes(list) {
  return list.slice().sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant', { numeric: true }));
}

/** Resolves { title, episodes: [{ id, url, title, label }], nextPage }. */
export function loadSeries(seriesId, page, opts) {
  const id = String(seriesId);
  const known = cache[id];
  if (!page && known) return Promise.resolve(known);
  const p = page || 1;
  return json('/api/series?id=' + encodeURIComponent(id) + '&page=' + p, Object.assign({ fallback: '讀取集數失敗。' }, opts)).then(data => {
    if (!Array.isArray(data.episodes) || !data.episodes.length) throw new Error('暫時未有集數資料。');
    const merged = {};
    if (p > 1 && known) known.episodes.forEach(ep => { merged[ep.url] = ep; });
    data.episodes.forEach(ep => {
      if (/^https:\/\/anime1\.me\/\d{1,10}$/.test(ep.url)) merged[ep.url] = Object.assign({ id: episodeIdOf(ep.url) }, ep);
    });
    const result = { title: data.title, episodes: sortEpisodes(Object.keys(merged).map(k => merged[k])), nextPage: data.nextPage || null };
    cache[id] = result;
    return result;
  });
}

export function cachedSeries(seriesId) {
  return cache[String(seriesId)] || null;
}
