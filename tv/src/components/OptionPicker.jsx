import { useEffect, useRef } from 'preact/hooks';
import { useRouter } from '../router.js';
import { focusFirst } from '../lib/focus.js';

/** Side panel listing choices (filters, danmaku sources…). Back closes it. */
export function OptionPicker({ title, items, value, onSelect, onClose }) {
  const router = useRouter();
  const ref = useRef(null);
  const previous = useRef(document.activeElement);
  useEffect(() => {
    setTimeout(() => focusFirst('.is-selected', ref.current), 0);
    const off = router.addKeyHandler('global', action => {
      if (action === 'back') { onClose(); return true; }
      return ['left', 'right', 'up', 'down', 'enter'].indexOf(action) < 0;
    });
    return () => {
      off();
      const el = previous.current;
      if (el && document.body.contains(el)) setTimeout(() => el.focus(), 0);
    };
  }, []);
  return (
    <div class="side-panel-backdrop" data-focus-scope ref={ref}>
      <div class="side-panel" role="dialog" aria-label={title}>
        <h2 class="side-panel-title">{title}</h2>
        <div class="side-panel-body" data-scroll="y" data-scroll-pad="100">
          {items.map(item => (
            <button key={String(item.value)} type="button" tabIndex={-1}
              class={'option-item focusable' + (item.value === value ? ' is-selected' : '')}
              onClick={() => onSelect(item.value)}>
              <span>{item.label}</span>{item.hint ? <small>{item.hint}</small> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
