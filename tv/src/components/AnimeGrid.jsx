import { Poster } from './Poster.jsx';
import { scoreText } from '../lib/format.js';

/**
 * Catalogue grid. Calls `onNearEnd` when a card in the last two rows takes focus so the
 * screen can fetch the next page before the user reaches the bottom.
 */
export function AnimeGrid({ items, details, group, onSelect, onNearEnd, autofocusFirst }) {
  const threshold = Math.max(0, items.length - 12);
  return (
    <div class="poster-grid" data-focus-group={group}>
      {items.map((item, i) => {
        const data = details && details[item.id];
        const meta = [item.year, item.season ? item.season + '季' : '', scoreText(data)].filter(Boolean).join(' · ');
        return (
          <Poster key={item.id} title={item.title} coverId={item.bgmId ? item.id : null} badge={item.episodes} subtitle={meta}
            onSelect={() => onSelect(item)}
            attrs={{ onFocus: onNearEnd && i >= threshold ? onNearEnd : undefined, 'data-index': i, 'data-autofocus': autofocusFirst && i === 0 ? '' : undefined }} />
        );
      })}
    </div>
  );
}
