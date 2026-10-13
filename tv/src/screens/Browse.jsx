import { useState } from 'preact/hooks';
import { useRouter, useKeys } from '../router.js';
import { TabRow } from '../components/TabRow.jsx';
import { AnimeGrid } from '../components/AnimeGrid.jsx';
import { OptionPicker } from '../components/OptionPicker.jsx';
import { Empty, PosterSkeleton, Spinner } from '../components/Status.jsx';
import { Icon } from '../components/Icon.jsx';
import { FORMATS } from '../lib/format.js';
import { useCatalog } from './useCatalog.js';

const PRESETS = [
  { value: 'all', label: '全部動畫' },
  { value: 'season', label: '當季新番' },
  { value: 'airing', label: '連載中' },
  { value: 'complete', label: '已完結' },
  { value: 'movie', label: '劇場版' },
  { value: 'ranking', label: '排行榜' },
];
const SEASONS = ['冬', '春', '夏', '秋'];
const EMPTY = { year: '', season: '', format: '', genre: '' };

function presetQuery(preset) {
  const q = { state: '', sort: '', year: '', season: '', format: '', genre: '' };
  if (preset === 'airing' || preset === 'complete') q.state = preset;
  if (preset === 'ranking') q.sort = 'rank';
  if (preset === 'movie') q.format = 'movie';
  if (preset === 'season') {
    const now = new Date();
    q.year = String(now.getFullYear());
    q.season = SEASONS[Math.floor(now.getMonth() / 3)];
  }
  return q;
}

export function Browse() {
  const router = useRouter();
  const [preset, setPreset] = useState('all');
  const [query, setQuery] = useState(() => presetQuery('all'));
  const [picker, setPicker] = useState(null);
  const catalog = useCatalog(query);
  const { state } = catalog;

  function choosePreset(next) {
    setPreset(next);
    setQuery(presetQuery(next));
  }
  function setFilter(key, value) {
    const next = Object.assign({}, query, { [key]: value });
    setQuery(next);
    setPreset(next.sort === 'rank' ? 'ranking' : next.state || (Object.keys(EMPTY).some(k => next[k]) ? '' : 'all'));
    setPicker(null);
  }

  const options = {
    year: { title: '年份', all: '全部年份', items: state.years.map(y => ({ value: y, label: y })) },
    season: { title: '季度', all: '全部季度', items: SEASONS.map(s => ({ value: s, label: s + '季' })) },
    format: { title: '類型', all: '全部類型', items: ['tv', 'movie', 'web', 'ova', 'unknown'].map(f => ({ value: f, label: f === 'unknown' ? '未分類' : FORMATS[f] })) },
    genre: { title: '題材', all: '全部題材', items: state.genres.map(g => ({ value: g, label: g })) },
  };
  const label = key => {
    const v = query[key];
    if (!v) return options[key].all;
    const hit = options[key].items.filter(x => x.value === v)[0];
    return hit ? hit.label : v;
  };
  const filtered = Object.keys(EMPTY).some(k => query[k]) || query.state || query.sort;

  // Yellow key: reset filters, like the website's 重設篩選.
  useKeys(action => {
    if (action !== 'yellow') return false;
    choosePreset('all');
    return true;
  });

  return (
    <div class="page" data-scroll="y" data-scroll-pad="160">
      <header class="page-header page-header-row">
        <div>
          <span class="eyebrow">動畫目錄 · 片源 Anime1</span>
          <h1 class="page-title">今晚，想睇啲乜？</h1>
        </div>
      </header>
      <TabRow label="快速分類" group="browse-preset" size="lg" autofocus items={PRESETS} value={preset} onChange={choosePreset} />
      <div class="tab-row tab-row-sm" data-scroll="x" data-scroll-pad="120">
        <div class="tab-row-track" data-focus-group="browse-filters">
          {Object.keys(options).map(key => (
            <button key={key} type="button" tabIndex={-1} class={'chip focusable' + (query[key] ? ' is-selected' : '')}
              onClick={() => setPicker(key)}>
              <span class="chip-key">{options[key].title}</span>{label(key)}<Icon name="down" class="chip-caret" />
            </button>
          ))}
          {filtered ? <button type="button" tabIndex={-1} class="chip chip-ghost focusable" onClick={() => choosePreset('all')}><Icon name="refresh" />重設篩選</button> : null}
        </div>
      </div>
      <p class="caption">{state.loading && !state.items.length ? '正在讀取動畫目錄…' : catalog.caption()}{state.notes.length ? <span class="caption-note"> {state.notes.join(' ')}</span> : null}</p>
      <section class="page-body">
        {state.items.length > 0 && (
          <AnimeGrid items={state.items} details={catalog.details} group="browse-grid" onNearEnd={catalog.more}
            onSelect={item => router.push('detail', { item })} />
        )}
        {state.loading && state.items.length === 0 && <PosterSkeleton />}
        {state.loading && state.items.length > 0 && <Spinner label="載入更多…" />}
        {!state.loading && state.error && <Empty title="未能載入目錄" message={state.error} actionLabel="重新載入目錄" onAction={catalog.retry} />}
        {!state.loading && !state.error && state.items.length === 0 && (
          <Empty title="未找到符合條件的動畫" message="試下其他分類，或按黃色鍵重設篩選。" onAction={state.nextPage ? catalog.more : () => choosePreset('all')} actionLabel={state.nextPage ? '更多動畫' : '重設篩選'} />
        )}
        {!state.loading && !state.error && state.items.length > 0 && !state.nextPage && <div class="list-end">已經到底了</div>}
      </section>
      {picker && (
        <OptionPicker title={options[picker].title} value={query[picker]}
          items={[{ value: '', label: options[picker].all }].concat(options[picker].items)}
          onSelect={value => setFilter(picker, value)} onClose={() => setPicker(null)} />
      )}
    </div>
  );
}
