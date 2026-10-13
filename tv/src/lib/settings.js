// TV-only preferences (playback); kept on this device.
const KEY = 'anime1-tv-settings';
const DEFAULTS = { autoNext: true, seekStep: 10 };

export function getSettings() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (_) { return Object.assign({}, DEFAULTS); }
}

export function saveSettings(patch) {
  const next = Object.assign(getSettings(), patch);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (_) {}
  return next;
}

const SEARCHES = 'anime1-tv-searches';
export function getSearches() {
  try { return JSON.parse(localStorage.getItem(SEARCHES)) || []; } catch (_) { return []; }
}
export function addSearch(q) {
  const list = [q].concat(getSearches().filter(x => x !== q)).slice(0, 12);
  try { localStorage.setItem(SEARCHES, JSON.stringify(list)); } catch (_) {}
}
export function clearSearches() {
  try { localStorage.removeItem(SEARCHES); } catch (_) {}
}
