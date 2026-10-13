import { useEffect, useMemo, useRef, useState, useCallback } from 'preact/hooks';
import { RouterContext, ScreenContext } from './router.js';
import { actionOf, isTyping } from './platform/keys.js';
import { exitApp } from './platform/tv.js';
import { current, focusFirst, focusElement, move } from './lib/focus.js';
import * as remote from './lib/remote.js';
import { Sidebar } from './components/Sidebar.jsx';
import { Toasts, toast } from './components/Toast.jsx';
import { Dialog } from './components/Dialog.jsx';
import { Browse } from './screens/Browse.jsx';
import { Search } from './screens/Search.jsx';
import { History } from './screens/History.jsx';
import { Sync } from './screens/Sync.jsx';
import { Settings } from './screens/Settings.jsx';
import { Detail } from './screens/Detail.jsx';
import { Player, playerBus } from './screens/Player.jsx';

const SCREENS = { browse: Browse, search: Search, history: History, sync: Sync, settings: Settings, detail: Detail, player: Player };
const TABS = ['browse', 'search', 'history', 'sync', 'settings'];
let nextId = 1;

function Screen({ entry, active, children }) {
  const ref = useRef(null);
  const saved = useRef(null);
  const ctx = useMemo(() => ({ active, id: entry.id }), [active, entry.id]);
  useEffect(() => {
    if (!active) return undefined;
    // Returning to a screen restores the element that had focus when it was covered.
    // Deferred one tick: until the screen's visibility:hidden is gone, focus() is a no-op.
    const el = saved.current;
    const timer = setTimeout(() => {
      if (el && ref.current && ref.current.contains(el) && document.body.contains(el)) focusElement(el);
    }, 0);
    return () => clearTimeout(timer);
  }, [active]);
  // Remember focus as it moves: once covered (visibility:hidden) the element has already lost it.
  return (
    <ScreenContext.Provider value={ctx}>
      <div ref={ref} class={'screen screen-' + entry.name + (active ? ' is-active' : ' is-covered')}
        onFocusIn={e => { if (active) saved.current = e.target; }}>{children}</div>
    </ScreenContext.Provider>
  );
}

function describe(command) {
  if (command.type === 'play') return '播放 ' + (command.title || command.seriesTitle || '影片');
  if (command.type === 'seek') return (command.delta > 0 ? '快進 ' : '倒後 ') + Math.abs(command.delta) + ' 秒';
  return { toggle: '播放／暫停', next: '下一集', previous: '上一集' }[command.type] || '遙控';
}

export function App() {
  const [tab, setTab] = useState('browse');
  // One stack per visit: [root tab screen, ...pushed detail/player screens]
  const [stack, setStack] = useState([{ id: nextId++, name: 'browse', props: {} }]);
  const [exitAsk, setExitAsk] = useState(false);
  const handlers = useRef([]);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const top = stack[stack.length - 1];
  const fullscreen = top.name === 'detail' || top.name === 'player';

  const router = useMemo(() => ({
    push(name, props) {
      setStack(s => s.concat([{ id: nextId++, name, props: props || {} }]));
    },
    replace(name, props) {
      setStack(s => s.slice(0, -1).concat([{ id: nextId++, name, props: props || {} }]));
    },
    back() {
      const s = stackRef.current;
      if (s.length > 1) setStack(s.slice(0, -1));
      else if (s[0].name !== 'browse') router.tab('browse');
      else setExitAsk(true);
    },
    tab(name) {
      if (TABS.indexOf(name) < 0) return;
      setTab(name);
      setStack(s => (s.length === 1 && s[0].name === name ? s : [{ id: nextId++, name, props: {} }]));
    },
    /** Open the player for an episode; replaces a player already on top. */
    watch(props) {
      setExitAsk(false);
      setStack(s => {
        const entry = { id: nextId++, name: 'player', props };
        return s[s.length - 1].name === 'player' ? s.slice(0, -1).concat([entry]) : s.concat([entry]);
      });
    },
    addKeyHandler(screenId, fn) {
      const item = { screenId, fn };
      handlers.current.push(item);
      return () => { handlers.current = handlers.current.filter(x => x !== item); };
    },
  }), []);

  // Phone remote: a "play" opens the episode on this TV; transport commands go to the player.
  useEffect(() => {
    remote.connect();
    return remote.onCommand((command, from) => {
      toast('📱 ' + from + '：' + describe(command));
      if (command.type === 'play') {
        if (!/^\d{1,10}$/.test(String(command.episodeId || ''))) return;
        router.watch({ episodeId: String(command.episodeId), seriesId: command.seriesId != null ? String(command.seriesId) : null, seriesTitle: command.seriesTitle || '', title: command.title || '', autoplay: true });
      } else if (stackRef.current[stackRef.current.length - 1].name === 'player') {
        playerBus.emit(command);
      }
    });
  }, []);

  const onKey = useCallback(e => {
    const action = actionOf(e);
    if (!action) return;
    const topId = stackRef.current[stackRef.current.length - 1].id;
    const chain = handlers.current.filter(h => h.screenId === topId || h.screenId === 'global');
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].fn(action, e)) { e.preventDefault(); return; }
    }
    if (isTyping(e) && (action === 'left' || action === 'right' || action === 'enter')) return;
    if (!current() && ['left', 'right', 'up', 'down', 'enter'].indexOf(action) >= 0 && !document.querySelector('[data-focus-scope]')) {
      // Focus was lost (its element re-rendered away): land back inside the active screen.
      e.preventDefault();
      const stage = document.querySelector('.screen.is-active') || undefined;
      focusFirst('[data-autofocus]', stage) || focusFirst(null, stage);
      return;
    }
    if (action === 'left' || action === 'right' || action === 'up' || action === 'down') {
      e.preventDefault();
      move(action);
    } else if (action === 'enter') {
      const el = current();
      if (el) { e.preventDefault(); el.click(); }
    } else if (action === 'back') {
      e.preventDefault();
      if (isTyping(e)) { e.target.blur(); return; }
      router.back();
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // A newly opened screen takes focus at its [data-autofocus] element; a screen
  // revealed by Back restores its own focus (see Screen).
  const seen = useRef(new Set());
  useEffect(() => {
    const fresh = !seen.current.has(top.id);
    seen.current.add(top.id);
    const t = setTimeout(() => {
      const stage = document.querySelector('.screen.is-active');
      if (fresh || !current()) focusFirst('[data-autofocus]', stage || undefined) || focusFirst();
    }, 60);
    return () => clearTimeout(t);
  }, [top.id]);

  return (
    <RouterContext.Provider value={router}>
      <div class={'app' + (fullscreen ? ' is-fullscreen' : '')}>
        {!fullscreen && <Sidebar tab={tab} />}
        <main class="stage">
          {stack.map((entry, i) => {
            const C = SCREENS[entry.name];
            return (
              <Screen key={entry.id} entry={entry} active={i === stack.length - 1 && !exitAsk}>
                <C {...entry.props} />
              </Screen>
            );
          })}
        </main>
        {exitAsk && (
          <Dialog title="退出 Anime1 TV？" message="觀看紀錄已同步至雲端，下次打開會繼續。"
            actions={[{ label: '退出', onSelect: exitApp, danger: true }, { label: '繼續觀看', onSelect: () => setExitAsk(false), autofocus: true }]}
            onClose={() => setExitAsk(false)} />
        )}
        <Toasts />
      </div>
    </RouterContext.Provider>
  );
}

export { toast };
