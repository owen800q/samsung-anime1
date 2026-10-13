/** On-screen digits for pairing codes; the remote's number keys work too. */
export function Keypad({ onDigit, onDelete, group }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  return (
    <div class="keypad" data-focus-group={group || 'keypad'}>
      {keys.map((k, i) => (k === '' ? <span key={i} class="keypad-gap" /> : (
        <button key={i} type="button" tabIndex={-1} class="keypad-key focusable" data-autofocus={k === '1' ? '' : undefined}
          onClick={() => (k === 'del' ? onDelete() : onDigit(k))}>{k === 'del' ? '⌫' : k}</button>
      )))}
    </div>
  );
}
