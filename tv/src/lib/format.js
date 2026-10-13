export const FORMATS = { tv: 'TV 動畫', movie: '劇場版', web: '網絡動畫', ova: 'OVA / 特別篇', unknown: '動畫' };

/** m:ss like the website (used for saved progress). */
export function clock(value) {
  const s = Math.max(0, Math.floor(Number(value) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** mm:ss or h:mm:ss for the player bar. */
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = n => (n < 10 ? '0' : '') + n;
  return h ? h + ':' + pad(m) + ':' + pad(s % 60) : pad(m) + ':' + pad(s % 60);
}

export function timeAgo(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (diff < 60000) return '啱啱';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分鐘前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小時前';
  if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 日前';
  const d = new Date(Number(ts));
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

export function errorMessage(error, fallback) {
  const msg = error && !error.cancelled && (error.message || String(error));
  return msg || fallback || '出現問題，請重試';
}

export function episodeIdOf(url) {
  const m = String(url || '').match(/\/(\d+)\/?$/);
  return m ? m[1] : '';
}

/** "作品名 [05]" → "作品名" (series title from an episode title). */
export function seriesTitleOf(title) {
  return String(title || '').replace(/\s*\[[^\]]+\]\s*$/, '');
}

/** Short episode label for a grid button: "第 5 集" → "5". */
export function shortLabel(label) {
  const m = String(label || '').match(/^第\s*(.+?)\s*集$/);
  return m ? m[1] : String(label || '');
}

export function facts(item) {
  return [item.year, item.season ? item.season + '季' : '', FORMATS[item.format] || '動畫', item.episodes].filter(Boolean).join(' · ');
}

export function scoreText(data) {
  return data && data.score ? '★ ' + Number(data.score).toFixed(1) + (data.rank ? ' · #' + data.rank : '') : '';
}
