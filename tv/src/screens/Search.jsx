import { useState } from 'preact/hooks';
import { useRouter } from '../router.js';
import { addSearch, clearSearches, getSearches } from '../lib/settings.js';
import { AnimeGrid } from '../components/AnimeGrid.jsx';
import { TextField } from '../components/TextField.jsx';
import { Empty, PosterSkeleton, Spinner } from '../components/Status.jsx';
import { Icon } from '../components/Icon.jsx';
import { focusFirst } from '../lib/focus.js';
import { useCatalog } from './useCatalog.js';

/** Global catalogue search (Chinese or Japanese names), independent of Browse filters. */
export function Search() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [keyword, setKeyword] = useState('');
  const [recent, setRecent] = useState(getSearches);
  const catalog = useCatalog(keyword ? { q: keyword } : null);
  const { state } = catalog;

  function run(value) {
    const q = String(value || '').trim().slice(0, 80);
    if (!q) return;
    addSearch(q);
    setRecent(getSearches());
    setText(q);
    setKeyword(q);
    setTimeout(() => focusFirst('.screen.is-active .poster'), 1200);
  }

  return (
    <div class="page" data-scroll="y" data-scroll-pad="160">
      <header class="page-header"><h1 class="page-title">搜尋動畫</h1></header>
      <div class="search-field">
        <Icon name="search" />
        <TextField value={text} onInput={setText} onSubmit={run} autofocus maxLength={80}
          placeholder="中文、日文名稱都可以 · 按確認鍵開始輸入" label="搜尋動畫" />
        <button type="button" tabIndex={-1} class="btn btn-primary focusable" onClick={() => run(text)}>搜尋</button>
      </div>
      {!keyword && recent.length > 0 && (
        <section class="recent">
          <div class="section-head">
            <h2 class="section-title">最近搜尋</h2>
            <button type="button" tabIndex={-1} class="btn btn-ghost btn-sm focusable" onClick={() => { clearSearches(); setRecent([]); }}>
              <Icon name="trash" />清除
            </button>
          </div>
          <div class="chip-wrap" data-focus-group="search-recent">
            {recent.map(q => <button key={q} type="button" tabIndex={-1} class="chip focusable" onClick={() => run(q)}>{q}</button>)}
          </div>
        </section>
      )}
      {!keyword && recent.length === 0 && <p class="hint">按遙控器確認鍵叫出鍵盤，輸入動畫名稱。搜尋會在整個目錄進行。</p>}
      <section class="page-body">
        {keyword && state.items.length > 0 && <div class="result-head">「{keyword}」的搜尋結果 · {catalog.caption()}</div>}
        {state.items.length > 0 && (
          <AnimeGrid items={state.items} details={catalog.details} group="search-grid" onNearEnd={catalog.more}
            onSelect={item => router.push('detail', { item })} />
        )}
        {state.loading && state.items.length === 0 && <PosterSkeleton count={6} />}
        {state.loading && state.items.length > 0 && <Spinner label="載入更多…" />}
        {!state.loading && state.error && <Empty title="搜尋未成功" message={state.error} onAction={catalog.retry} />}
        {!state.loading && !state.error && keyword && state.items.length === 0 && (
          <Empty title={'未找到「' + keyword + '」'} message="試下別名、日文名或較短的關鍵字。" />
        )}
      </section>
    </div>
  );
}
