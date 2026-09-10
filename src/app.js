(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const video = $('video'); let playback = null; let request = null; let generation = 0; let searchGeneration = 0;
  let busy = false; let catalog = null; let listRequest = null; let listGeneration = 0; let listInput = $('episode-url').value; let retryPage = 1;
  const status = text => { $('status').textContent = text; };
  const error = text => { $('error').textContent = text; $('error').hidden = !text; };
  function controls(loading) {
    busy = loading;
    $('load').disabled = busy;
    ['play','reload','fullscreen'].forEach(id => { $(id).disabled = busy || !playback; });
    $('previous').disabled = busy || !playback?.previous;
    $('next').disabled = busy || !playback?.next;
    document.querySelectorAll('.result').forEach(button => { button.disabled = busy; });
    document.querySelectorAll('.episode-button').forEach(button => { button.disabled = busy; });
  }
  function markEpisode() {
    document.querySelectorAll('.episode-button').forEach(button => {
      const current = button.dataset.url === playback?.url;
      if (current) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
      button.lastElementChild.textContent = current ? '正在觀看' : '';
    });
    if (!playback || !catalog) return;
    const at = catalog.episodes.findIndex(item => item.url === playback.url);
    if (at < 0) return;
    playback.previous = catalog.episodes[at - 1] || playback.previous;
    playback.next = catalog.episodes[at + 1] || playback.next;
    $('episode-nav').hidden = !(playback.previous || playback.next);
    controls(busy);
  }
  async function loadEpisodes(url, page = 1, force = false) {
    if (page === 1 && !force && catalog?.episodes.some(item => item.url === url)) { markEpisode(); return; }
    listInput = url; retryPage = page;
    const id = ++listGeneration; listRequest?.abort(); listRequest = new AbortController();
    const signal = listRequest.signal;
    if (page === 1) { catalog = null; $('episodes').replaceChildren(); $('series-title').textContent = '正在讀取動畫集數…'; }
    $('episodes-status').textContent = '正在讀取集數…'; $('episodes-error').hidden = true; $('episodes-retry').hidden = true; $('episodes-more').hidden = true;
    try {
      const response = await fetch('/api/episodes?url=' + encodeURIComponent(url) + '&page=' + page, { signal });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('集數列表暫時無法使用。');
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '讀取集數失敗。');
      if (!Array.isArray(data.episodes) || !data.episodes.length) throw new Error('暫時未有集數資料。');
      if (id !== listGeneration) return;
      const merged = new Map((catalog?.episodes || []).map(item => [item.url,item]));
      data.episodes.forEach(item => { if (/^https:\/\/anime1\.me\/\d{1,10}$/.test(item.url)) merged.set(item.url,item); });
      catalog = { ...data, episodes: [...merged.values()].sort((a,b) => a.title.localeCompare(b.title, 'zh-Hant', {numeric:true})) };
      $('series-title').textContent = catalog.title;
      $('episodes-status').textContent = '已載入 ' + catalog.episodes.length + ' 集 · 選好後按播放';
      $('episodes').replaceChildren();
      catalog.episodes.forEach(item => {
        const button = document.createElement('button'); button.className = 'episode-button'; button.dataset.url = item.url; button.title = item.title; button.disabled = busy;
        const label = document.createElement('span'); label.textContent = item.label;
        const current = document.createElement('small'); button.append(label,current);
        button.addEventListener('click', () => void prepare(item.url)); $('episodes').append(button);
      });
      $('episodes-more').hidden = !catalog.nextPage;
      markEpisode();
    } catch (e) {
      if (signal.aborted || id !== listGeneration) return;
      if (!catalog) $('series-title').textContent = '動畫集數';
      $('episodes-status').textContent = '';
      $('episodes-error').textContent = e.message || '讀取集數失敗。'; $('episodes-error').hidden = false; $('episodes-retry').hidden = false;
    }
  }
  async function prepare(url, refresh = false) {
    const id = ++generation; request?.abort(); request = new AbortController();
    const signal = request.signal;
    video.pause(); video.removeAttribute('src'); video.load(); playback = null;
    $('play').textContent = '▶ 播放'; controls(true); error(''); $('empty').hidden = false;
    $('empty-title').textContent = '正在準備你的影片'; $('empty-description').textContent = '取得播放資料並確認影片連線';
    $('title').textContent = '準備影片中'; $('source').hidden = true; $('episode-nav').hidden = true;
    status('正在準備影片…'); $('episode-url').value = url;
    markEpisode(); void loadEpisodes(url);
    try {
      const response = await fetch('/api/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, refresh }), signal });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('播放服務未能回應，請稍後重試。');
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '未能準備影片。');
      if (!/^\/api\/media\?id=\d{1,10}$/.test(data.media) || typeof data.title !== 'string') throw new Error('播放資料不完整。');
      if (id !== generation) return;
      playback = data; video.src = data.media; video.load(); $('empty').hidden = true;
      markEpisode();
      $('title').textContent = data.title; $('source').href = data.url; $('source').hidden = false;
      $('episode-nav').hidden = !(data.previous || data.next); status('影片已準備好，請按播放');
      $('play').disabled = false; $('play').focus();
      return { state: 'ready', title: data.title, url: data.url };
    } catch (e) {
      if (signal.aborted) return;
      error(e.message || '連線失敗，請重試。'); status('未能載入'); $('empty-title').textContent = '暫時未能載入'; $('empty-description').textContent = '請查看下方的錯誤提示';
      return { state: 'error', message: e.message };
    } finally { if (id === generation) controls(false); }
  }
  async function toggle() {
    if (!playback) return;
    if (!video.paused) { video.pause(); return; }
    try { await video.play(); } catch (e) { error(e.name === 'NotAllowedError' ? '請再按一次播放鍵，允許電視開始播放。' : '電視未能開始播放，可按「重新載入」更新影片連線。'); }
  }
  $('load-form').addEventListener('submit', e => { e.preventDefault(); void prepare($('episode-url').value.trim()); });
  $('episodes-retry').addEventListener('click', () => void loadEpisodes(listInput, retryPage, true));
  $('episodes-more').addEventListener('click', () => { if (catalog?.nextPage) void loadEpisodes(listInput, catalog.nextPage); });
  $('play').addEventListener('click', () => void toggle());
  $('reload').addEventListener('click', () => { if (playback) void prepare(playback.url, true); });
  $('previous').addEventListener('click', () => { if (playback?.previous) void prepare(playback.previous.url); });
  $('next').addEventListener('click', () => { if (playback?.next) void prepare(playback.next.url); });
  $('fullscreen').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('screen').requestFullscreen) await $('screen').requestFullscreen(); else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); else error('請使用影片內建的全螢幕按鈕。'); }
    catch { error('請使用影片內建的全螢幕按鈕。'); }
  });
  video.addEventListener('playing', () => { status('播放中'); $('play').textContent = '❚❚ 暫停'; error(''); });
  video.addEventListener('pause', () => { if (playback) status('已暫停'); $('play').textContent = '▶ 播放'; });
  video.addEventListener('waiting', () => { if (playback) status('緩衝中…'); });
  video.addEventListener('canplay', () => { if (playback) status(video.paused ? '可以播放' : '播放中'); });
  video.addEventListener('ended', () => { status('本集播放完畢'); $('play').textContent = '▶ 播放'; });
  video.addEventListener('error', () => { if (playback) { status('播放失敗'); error('影片未能播放（' + (video.error?.code || '未知') + '），可按「重新載入」更新播放連線。'); } });
  function tab(name, focus = false) {
    ['link','search'].forEach(key => { const button = $('tab-' + key); const active = key === name; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; $('panel-' + key).hidden = !active; });
    if (focus) $('tab-' + name).focus();
  }
  ['link','search'].forEach(name => $('tab-' + name).addEventListener('click', () => tab(name)));
  $('search-form').addEventListener('submit', async e => {
    e.preventDefault(); const q = $('search-query').value.trim(); if (!q) return;
    const id = ++searchGeneration; $('search').disabled = true; $('search-status').textContent = '搜尋中…'; $('search-error').hidden = true; $('results').replaceChildren();
    try {
      const response = await fetch('/api/search?q=' + encodeURIComponent(q));
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('搜尋服務暫時無法使用。');
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '搜尋失敗');
      if (!Array.isArray(data.episodes)) throw new Error('搜尋資料不完整。'); if (id !== searchGeneration) return;
      $('search-status').textContent = data.episodes.length ? '找到 ' + data.episodes.length + ' 集' : '未找到單集，試下縮短動畫名稱。';
      data.episodes.forEach(item => { const button = document.createElement('button'); button.className = 'result'; button.textContent = '▶  ' + item.title; button.addEventListener('click', () => void prepare(item.url)); $('results').append(button); });
    } catch (e) { if (id === searchGeneration) { $('search-status').textContent = ''; $('search-error').textContent = e.message; $('search-error').hidden = false; } }
    finally { if (id === searchGeneration) $('search').disabled = false; }
  });
  document.addEventListener('keydown', e => {
    const current = document.activeElement;
    if (current?.matches('input,textarea')) return;
    if (current?.getAttribute('role') === 'tab' && ['ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); tab(current.id === 'tab-link' ? 'search' : 'link', true); return; }
    if (e.keyCode === 10252 || e.key === 'MediaPlayPause' || e.code === 'Space' && !current?.matches('button')) { e.preventDefault(); void toggle(); return; }
    if (e.keyCode === 415) { e.preventDefault(); if (video.paused) void toggle(); return; }
    if (e.keyCode === 19) { e.preventDefault(); video.pause(); return; }
    if (current === video && ['ArrowLeft','ArrowRight'].includes(e.key) && Number.isFinite(video.duration)) { e.preventDefault(); video.currentTime = Math.max(0,Math.min(video.duration,video.currentTime+(e.key === 'ArrowRight' ? 10 : -10))); return; }
    const directions = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }; const direction = directions[e.key];
    if (!direction || !current || current === document.body) return;
    const rect = current.getBoundingClientRect(); const x = rect.x + rect.width/2; const y = rect.y + rect.height/2;
    let best = null; let bestScore = Infinity;
    document.querySelectorAll('button:not(:disabled),input,a[href],video').forEach(candidate => {
      if (candidate === current || candidate.closest('[hidden]')) return;
      const r = candidate.getBoundingClientRect(); if (!r.width || !r.height) return;
      const dx=r.x+r.width/2-x, dy=r.y+r.height/2-y; const forward=dx*direction[0]+dy*direction[1];
      if (forward <= 1) return; const score=forward+Math.abs(dx*direction[1]-dy*direction[0])*3;
      if(score<bestScore) {best=candidate;bestScore=score;}
    });
    if(best) {e.preventDefault();best.focus();}
  });
  void loadEpisodes(listInput);
  // Optional browser-standard agent action; there is no ChatGPT network dependency.
  if (document.modelContext?.registerTool) {
    try { Promise.resolve(document.modelContext.registerTool({ name: 'prepare_anime1_episode', title: '準備動畫影片', description: 'Prepare an episode in the visible player without starting playback.', inputSchema: {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, annotations: {readOnlyHint:false,untrustedContentHint:true}, execute: async input => {if(typeof input?.url !== 'string' || !/^https:\/\/anime1\.me\/\d+\/?$/.test(input.url)) throw new Error('請提供 Anime1 單集網址。');return await prepare(input.url);} })).catch(() => {}); } catch {}
  }
})();
