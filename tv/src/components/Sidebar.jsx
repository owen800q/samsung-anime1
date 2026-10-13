import { useState } from 'preact/hooks';
import { useRouter } from '../router.js';
import { Icon } from './Icon.jsx';

const ITEMS = [
  { tab: 'browse', label: '動畫目錄', icon: 'compass' },
  { tab: 'search', label: '搜尋', icon: 'search' },
  { tab: 'history', label: '觀看紀錄', icon: 'clock' },
  { tab: 'sync', label: '裝置同步', icon: 'phone' },
  { tab: 'settings', label: '設定', icon: 'gear' },
];

/** Collapsed icon rail that expands over the content while it holds focus. */
export function Sidebar({ tab }) {
  const router = useRouter();
  // :focus-within needs Chromium 60; 2018–2019 TVs run 56–63, so track focus here.
  const [open, setOpen] = useState(false);
  return (
    <nav class={'sidebar' + (open ? ' is-open' : '')} data-focus-group="sidebar" aria-label="主選單"
      onFocusIn={() => setOpen(true)} onFocusOut={() => setOpen(false)}>
      <div class="sidebar-brand"><span class="brand-mark"><Icon name="play" /></span><span class="sidebar-label">Anime1 <b>TV</b></span></div>
      <ul class="sidebar-list">
        {ITEMS.map(item => (
          <li key={item.tab}>
            <button type="button" class={'sidebar-item focusable' + (tab === item.tab ? ' is-current' : '')}
              tabIndex={-1} data-nav-left="none" data-sidebar-tab={item.tab}
              onClick={() => router.tab(item.tab)}>
              <Icon name={item.icon} />
              <span class="sidebar-label">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
