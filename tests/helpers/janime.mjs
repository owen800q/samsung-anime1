// Fixtures shaped like janime.cc: series pages carry the player's episodes as Astro island props
// (JSON in an HTML attribute, each value wrapped as [type, value]).
const wrap = value => Array.isArray(value) ? [1, value.map(wrap)] : value && typeof value === 'object' ? [0, Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wrap(v)]))] : [0, value];
const attribute = value => JSON.stringify(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** episodes: [{ slug, sort?, mp4?: { cht?, chs? } (stream tokens), m3u8?: true }] */
export function seriesPage({ id, title, episodes, airing = true }) {
  const list = episodes.map((e, i) => {
    const overseas = Object.entries(e.mp4 || {}).map(([lang, token]) => ({ lang, quality: '1080p', type: 'mp4', url: 'https://stream.janime.cc/stream/v/' + token }));
    const standard = e.m3u8 ? [{ url: 'https://cdn.example.test/' + id + '/' + e.slug + '/index.m3u8', type: 'm3u8', lang: 'chs', quality: '1080p' }] : [];
    return { slug: String(e.slug), title: '第 ' + e.slug + ' 話', url: overseas[0]?.url || standard[0]?.url || '', sort: e.sort ?? Number(e.slug) ?? i, type: overseas.length ? 'mp4' : 'm3u8', sources: { ...(standard.length ? { standard } : {}), ...(overseas.length ? { overseas } : {}) } };
  });
  const props = attribute(Object.fromEntries(Object.entries({ episodes: list, animeId: String(id), animeTitle: title, lang: 'zh-tw' }).map(([k, v]) => [k, wrap(v)])));
  return '<!DOCTYPE html><html><head><title>《' + title + '》' + (airing ? '連載中' : '全集已完結') + '線上看 - 簡愛動漫 (Janime)</title></head><body>'
    + '<astro-island uid="a" component-url="/_astro/NodeSelector.X1.js" props="' + attribute({ animeId: [0, String(id)] }) + '"></astro-island>'
    + '<astro-island uid="b" component-url="/_astro/EpisodePlayer.D0njMQHG.js" component-export="default" props="' + props + '" ssr client="load"></astro-island></body></html>';
}

/** Catalogue index row: [id, Traditional title, Simplified title, year, first air date, format, season, genres, score]. */
export const indexRow = (id, title, { year = 2026, date = year + '-10-05', format = 'tv', season = 'autumn', genres = ['奇幻'], simplified = title } = {}) => [id, title, simplified, year, date, format, season, genres, 7.1];
