import { useEffect, useState } from 'preact/hooks';
import { useRouter, useKeys } from '../router.js';
import * as store from '../lib/store.js';
import { clock, seriesTitleOf, timeAgo } from '../lib/format.js';
import { Poster } from '../components/Poster.jsx';
import { Empty } from '../components/Status.jsx';

/** Synced watch history, newest first. OK resumes the episode; blue opens the anime. */
export function History() {
  const router = useRouter();
  const [items, setItems] = useState(store.all);
  const [sync, setSync] = useState(store.syncStatus);
  useEffect(() => {
    void store.refresh();
    return store.subscribe(kind => {
      if (kind === 'history') setItems(store.all());
      if (kind === 'sync') setSync(store.syncStatus());
    });
  }, []);

  function focused() {
    const el = document.activeElement;
    const i = el && el.getAttribute && el.getAttribute('data-index');
    return i == null ? null : items[i];
  }
  useKeys(action => {
    if (action !== 'blue') return false;
    const entry = focused();
    if (!entry || !entry.seriesId) return false;
    router.push('detail', { id: String(entry.seriesId) });
    return true;
  });

  return (
    <div class="page" data-scroll="y" data-scroll-pad="160">
      <header class="page-header page-header-row">
        <h1 class="page-title">觀看紀錄</h1>
        <div class="page-tools">
          <span class="hint-inline">確認：繼續觀看</span>
          <span class="hint-inline"><b class="key-blue" />動畫詳情</span>
          <span class="hint-inline">{sync}</span>
        </div>
      </header>
      <section class="page-body">
        {items.length > 0 ? (
          <div class="poster-grid" data-focus-group="history-grid">
            {items.map((entry, i) => (
              <Poster key={entry.episodeId} title={entry.title} coverId={entry.seriesId}
                subtitle={(entry.completed ? '已看完' : '看到 ' + clock(entry.position) + ' / ' + clock(entry.duration)) + ' · ' + timeAgo(entry.updatedAt)}
                progress={entry.duration ? (entry.completed ? 1 : entry.position / entry.duration) : 0}
                onSelect={() => router.watch({ episodeId: entry.episodeId, seriesId: entry.seriesId != null ? String(entry.seriesId) : null, seriesTitle: entry.seriesTitle || seriesTitleOf(entry.title), title: entry.title, autoplay: true })}
                attrs={{ 'data-index': i, 'data-autofocus': i === 0 ? '' : undefined }} />
            ))}
          </div>
        ) : (
          <Empty title="未有觀看紀錄" message="播放動畫後會自動儲存。手機或電腦的紀錄可用「裝置同步」連接。" />
        )}
      </section>
    </div>
  );
}
