import { useRef, useState } from 'preact/hooks';
import { useKeys } from '../router.js';
import { focusElement } from '../lib/focus.js';

/**
 * Text input for the remote. Tizen shows the on-screen keyboard whenever an editable input
 * gains focus, so the field stays read-only while the user navigates past it and unlocks on OK.
 */
export function TextField({ value, onInput, onSubmit, placeholder, label, maxLength, autofocus, mono }) {
  const input = useRef(null);
  const [editing, setEditing] = useState(false);

  function start() {
    const el = input.current;
    if (!el) return;
    setEditing(true);
    el.readOnly = false;
    el.blur();
    setTimeout(() => { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {} }, 0);
  }
  function stop(submit) {
    const el = input.current;
    setEditing(false);
    if (el) el.readOnly = true;
    if (submit && onSubmit) onSubmit(el ? el.value : value);
    if (el) focusElement(el);
  }

  useKeys((action, e) => {
    if (e.target !== input.current) return false;
    if (!editing) {
      if (action === 'enter') { start(); return true; }
      return false;
    }
    if (action === 'enter' || action === 'imedone') { stop(true); return true; }
    if (action === 'back' || action === 'imecancel') { stop(false); return true; }
    if (action === 'up' || action === 'down') { stop(false); return false; }
    return false;
  });

  return (
    <input ref={input} type="text" class={'text-input focusable' + (editing ? ' is-editing' : '') + (mono ? ' is-mono' : '')} tabIndex={-1} readOnly
      data-autofocus={autofocus ? '' : undefined} placeholder={placeholder} value={value} maxLength={maxLength}
      onInput={e => onInput(e.target.value)} onClick={() => !editing && start()}
      onBlur={() => { if (editing) { setEditing(false); if (input.current) input.current.readOnly = true; } }}
      autocomplete="off" autocorrect="off" spellcheck={false} aria-label={label} />
  );
}
