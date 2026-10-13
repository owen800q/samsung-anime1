import test from 'node:test';
import assert from 'node:assert/strict';

// Modules read the Vite-defined API base at load time; the sync store expects a browser.
globalThis.__API_BASE__ = 'https://anime1.test';
const memory = {};
globalThis.localStorage = { getItem: k => (k in memory ? memory[k] : null), setItem: (k, v) => { memory[k] = String(v); }, removeItem: k => { delete memory[k]; } };
globalThis.window = { addEventListener() {} };
globalThis.document = { hidden: true, addEventListener() {} };
globalThis.fetch = () => Promise.reject(new Error('offline'));
globalThis.setInterval = () => 0;
const { pickEpisodes, seriesName } = await import('../src/lib/danmaku.js');
const { shortLabel, seriesTitleOf, episodeIdOf, clock, facts } = await import('../src/lib/format.js');

// The website compares titles with Unicode property escapes, which Chromium 56 lacks.
const website = s => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

test('series names normalise like the website without \\p{…} escapes', () => {
  for (const title of ['無職轉生III～到了異世界就拿出真本事～ (第三季)', '【我推的孩子】 第二季', 'Re:ゼロから始める異世界生活 3rd season',
    'ぼっち・ざ・ろっく！', '86―エイティシックス―', 'Fate/stay night [UBW]', 'かぐや様は告らせたい？', 'ワンパンマン♪☆★×', 'SPY×FAMILY 第2季'])
    assert.equal(seriesName(title), website(title), title);
  assert.equal(seriesName('藥師少女的獨語 [12]'), website('藥師少女的獨語'));
});

test('episode picking mirrors title-match.js', () => {
  const eps = labels => labels.map(label => ({ label }));
  assert.deepEqual(pickEpisodes(eps(['1', '2', '3']), '2'), [{ label: '2' }]);
  // Sources that keep counting across seasons map catalogue episode n to the n-th of a gap-free run.
  assert.deepEqual(pickEpisodes(eps(['25', '26', '27']), '2'), [{ label: '26' }]);
  assert.deepEqual(pickEpisodes(eps(['25', '27']), '2'), []);
  assert.deepEqual(pickEpisodes([{ label: '1', group: '1' }, { label: '1', group: '0' }], '1'), [{ label: '1', group: '0' }]);
});

test('format helpers', () => {
  assert.equal(shortLabel('第 12 集'), '12');
  assert.equal(shortLabel('特別篇'), '特別篇');
  assert.equal(seriesTitleOf('藥師少女的獨語 [01]'), '藥師少女的獨語');
  assert.equal(episodeIdOf('https://anime1.me/21417'), '21417');
  assert.equal(clock(83.9), '1:23');
  assert.equal(facts({ year: '2023', season: '秋', format: 'tv', episodes: '1-24' }), '2023 · 秋季 · TV 動畫 · 1-24');
});
