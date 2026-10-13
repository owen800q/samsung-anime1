import { useState } from 'preact/hooks';
import { apiUrl } from '../lib/http.js';

/**
 * 3:4 anime card. Covers come through the Worker (`/api/cover`) only for Bangumi-matched
 * titles; others show the title on a gradient. `progress` (0–1) draws a bar.
 */
export function Poster({ title, coverId, badge, subtitle, progress, onSelect, attrs }) {
  const [broken, setBroken] = useState(false);
  return (
    <button type="button" class="poster focusable" tabIndex={-1} onClick={onSelect} {...attrs}>
      <div class="poster-art">
        <div class="poster-fallback"><small>ANIME</small><strong>{title}</strong></div>
        {coverId && !broken ? <img src={apiUrl('/api/cover?id=' + coverId)} alt="" onError={() => setBroken(true)} /> : null}
        {badge ? <span class="poster-badge">{badge}</span> : null}
        {progress > 0 ? <span class="poster-progress"><i style={{ width: Math.min(100, progress * 100) + '%' }} /></span> : null}
      </div>
      <div class="poster-title">{title}</div>
      <div class="poster-meta">{subtitle}</div>
    </button>
  );
}
