import { useEffect, useRef, useState } from 'preact/hooks';
import { DENSITIES, providerName } from '../lib/danmaku.js';
import { errorMessage } from '../lib/format.js';
import { focusFirst } from '../lib/focus.js';
import { useKeys } from '../router.js';
import { TextField } from '../components/TextField.jsx';
import { Icon } from '../components/Icon.jsx';

const STEPS = [-5, -0.5, 0.5, 5];

/**
 * Player side panel: on/off, density, source filter, status/retry, per-source offsets, and
 * manual pairing (search Bahamut/彈彈play by name, or a Bahamut/Bilibili/彈彈play URL or BV id).
 */
export function DanmakuPanel({ engine, state, onClose, toast }) {
  const s = state || engine.snapshot();
  const [view, setView] = useState('main'); // main | search
  const [query, setQuery] = useState(s.query);
  const [search, setSearch] = useState({ status: '', items: [], episodes: null, busy: false });
  const [offsets, setOffsets] = useState({});
  const saveTimer = useRef(0);
  const ref = useRef(null);

  useEffect(() => { setTimeout(() => focusFirst('[data-autofocus]', ref.current), 0); }, [view]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  // Back leaves the pairing search first; the player closes the panel from the main view.
  useKeys(action => {
    if (action !== 'back' || view !== 'search') return false;
    setView('main');
    return true;
  });

  function cycleDensity() {
    const i = DENSITIES.findIndex(d => d.value === s.density);
    engine.setDensity(DENSITIES[(i + 1) % DENSITIES.length].value);
  }

  // Offsets save after the user stops pressing, so a few −0.5 presses make one request.
  function nudge(src, delta) {
    const base = src.provider in offsets ? offsets[src.provider] : src.offset || 0;
    const value = Math.max(-300, Math.min(300, Math.round((base + delta) * 2) / 2));
    setOffsets(o => Object.assign({}, o, { [src.provider]: value }));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      engine.setOffset(src.provider, value).then(ok => {
        setOffsets(o => { const n = Object.assign({}, o); delete n[src.provider]; return n; });
        if (ok) toast(providerName(src.provider) + ' 時間調整已儲存：' + (value > 0 ? '+' : '') + value + ' 秒');
      });
    }, 900);
  }

  async function runSearch(value) {
    const q = String(value || query).trim();
    if (!q) return;
    if (/^https?:\/\/|^BV[0-9A-Za-z]{10}$/.test(q)) { showEpisodes(q); return; }
    setSearch({ status: '正在搜尋彈幕來源…', items: [], episodes: null, busy: true });
    try {
      const r = await engine.search(q);
      setSearch({ status: (r.results.length ? '選擇動畫，再選對應本集' : '未找到來源，試下別名或輸入完整來源網址。') + (r.errors.length ? '；' + r.errors.join('；') : ''), items: r.results, episodes: null, busy: false });
      setTimeout(() => focusFirst('.danmaku-results .focusable', ref.current), 0);
    } catch (e) {
      if (!e.cancelled) setSearch({ status: errorMessage(e, '搜尋失敗。'), items: [], episodes: null, busy: false });
    }
  }
  async function showEpisodes(url) {
    setSearch(x => Object.assign({}, x, { status: '讀取來源集數…', busy: true }));
    try {
      const d = await engine.resolve(url);
      setSearch(x => Object.assign({}, x, { status: d.title + ' · 請選擇對應本集', episodes: d.episodes, busy: false }));
      setTimeout(() => focusFirst('.danmaku-results .focusable', ref.current), 0);
    } catch (e) {
      if (!e.cancelled) setSearch(x => Object.assign({}, x, { status: errorMessage(e, '讀取來源失敗。'), busy: false }));
    }
  }
  async function choose(ep) {
    if (await engine.saveSource({ provider: ep.provider, id: ep.id, url: ep.url, title: ep.title })) {
      toast('已儲存本集配對：' + providerName(ep.provider));
      setSearch({ status: '', items: [], episodes: null, busy: false });
      setView('main');
    }
  }

  const filters = [{ value: 'all', label: '全部來源' }].concat(s.sources.map(x => ({ value: x.provider, label: providerName(x.provider) })));

  return (
    <div class="player-panel player-panel-wide" data-focus-scope ref={ref}>
      <h2 class="player-panel-title">{view === 'main' ? '彈幕' : '管理彈幕配對'}</h2>
      <div class="player-panel-body" data-scroll="y" data-scroll-pad="100">
        {view === 'main' ? (
          <div>
            <div class="panel-row">
              <button type="button" tabIndex={-1} class={'btn focusable' + (s.enabled ? ' is-on' : '')} data-autofocus onClick={() => engine.setEnabled(!s.enabled)}>彈幕：{s.enabled ? '開' : '關'}</button>
              <button type="button" tabIndex={-1} class="btn focusable" onClick={cycleDensity}>密度：{(DENSITIES.filter(d => d.value === s.density)[0] || DENSITIES[1]).label}</button>
              {s.retry && <button type="button" tabIndex={-1} class="btn focusable" onClick={() => engine.retry()}><Icon name="refresh" />重試彈幕</button>}
            </div>
            <p class="panel-status">{s.status}</p>
            {s.sources.length > 0 && (
              <div>
                <h3 class="panel-heading">顯示來源</h3>
                <div class="panel-row">
                  {filters.map(f => (
                    <button key={f.value} type="button" tabIndex={-1} class={'chip focusable' + (s.filter === f.value ? ' is-selected' : '')} onClick={() => engine.setFilter(f.value)}>{f.label}</button>
                  ))}
                </div>
                <h3 class="panel-heading">本集配對與時間調整</h3>
                {s.sources.map(src => {
                  const value = src.provider in offsets ? offsets[src.provider] : src.offset || 0;
                  return (
                    <div key={src.provider} class="source-row">
                      <div class="source-name"><strong>{providerName(src.provider)}</strong><span>{src.title}</span></div>
                      <div class="panel-row">
                        {STEPS.map(step => (
                          <button key={step} type="button" tabIndex={-1} class="btn btn-sm focusable" onClick={() => nudge(src, step)}>{step > 0 ? '+' : '−'}{Math.abs(step)}</button>
                        ))}
                        <span class="offset-value">{value > 0 ? '+' : ''}{value} 秒</span>
                      </div>
                    </div>
                  );
                })}
                <p class="panel-hint">正數令彈幕延後，負數令彈幕提早。配對及時間調整會透過裝置同步共用。</p>
              </div>
            )}
            <div class="panel-row">
              <button type="button" tabIndex={-1} class="btn btn-primary focusable" onClick={() => { setQuery(s.query); setView('search'); }}><Icon name="search" />搜尋／更改配對</button>
              {s.sources.length > 0 && <button type="button" tabIndex={-1} class="btn btn-danger focusable" onClick={() => engine.clear()}>清除本集配對</button>}
              <button type="button" tabIndex={-1} class="btn btn-ghost focusable" onClick={onClose}>關閉</button>
            </div>
          </div>
        ) : (
          <div>
            <p class="panel-hint">搜尋動畫名稱（動畫瘋、彈彈play），或輸入動畫瘋／Bilibili／彈彈play 網址、BV 號碼。新增來源只會取代同一來源的配對。</p>
            <div class="search-field search-field-sm">
              <TextField value={query} onInput={setQuery} onSubmit={runSearch} autofocus maxLength={500} label="動畫名稱／來源網址" placeholder="動畫名稱／來源網址" />
              <button type="button" tabIndex={-1} class="btn btn-primary focusable" disabled={search.busy} onClick={() => runSearch()}>搜尋來源</button>
            </div>
            <p class="panel-status">{search.status}</p>
            <div class="danmaku-results" data-focus-group="danmaku-results">
              {search.episodes
                ? search.episodes.map(ep => <button key={ep.provider + ep.id} type="button" tabIndex={-1} class="option-item focusable" onClick={() => choose(ep)}><span>{ep.label} · {ep.title}</span></button>)
                : search.items.map(item => <button key={item.url} type="button" tabIndex={-1} class="option-item focusable" onClick={() => showEpisodes(item.url)}><span>{providerName(item.provider)} · {item.title}</span>{item.year ? <small>{item.year}</small> : null}</button>)}
            </div>
            <div class="panel-row">
              <button type="button" tabIndex={-1} class="btn btn-ghost focusable" onClick={() => setView('main')}>← 返回</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
