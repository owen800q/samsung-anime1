(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const S=window.TVState;
  let selectedSeries=null,selectedTitle='',watchArmed=false,pendingResume=null,lastSavedAt=0,lastRecorded='';
  const video = $('video'); let playback = null; let request = null; let generation = 0; let requestedUrl = '';
  let busy = false; let catalog = null; let listRequest = null; let listGeneration = 0; let listInput = ''; let retryPage = 1;
  const status = text => { $('status').textContent = text; };
  const error = text => { $('error').textContent = text; $('error').hidden = !text; };
  const episodeId=url=>String(url||'').match(/\/(\d+)\/?$/)?.[1];
  function saveProgress(){
    if(!playback||!watchArmed||pendingResume||!Number.isFinite(video.duration)||video.duration<=0)return;
    lastSavedAt=Date.now();
    const fingerprint=[episodeId(playback.url),Math.floor(video.currentTime*10),video.ended].join(':');
    if(fingerprint===lastRecorded)return;lastRecorded=fingerprint;
    S.save({episodeId:episodeId(playback.url),seriesId:playback.seriesId||selectedSeries,title:playback.title,seriesTitle:selectedTitle||playback.title.replace(/\s*\[[^\]]+\]\s*$/,''),position:video.currentTime,duration:video.duration,completed:video.ended});
  }
  function restorePosition(){
    if(!pendingResume||!Number.isFinite(video.duration)||video.duration<=0)return;
    const saved=pendingResume;pendingResume=null;
    video.currentTime=saved.completed?0:Math.min(saved.position,Math.max(0,video.duration-0.25));
    $('resume-status').hidden=false;$('resume-status').textContent=saved.completed?'本集已看完，從頭播放。':'已接續上次進度 '+S.time(video.currentTime);
  }
  function stop(){window.TVDanmaku?.stop();saveProgress();watchArmed=false;pendingResume=null;generation++;request?.abort();video.pause();controls(false);}
  function controls(loading) {
    busy = loading;
    ['play','fullscreen'].forEach(id => { $(id).disabled = busy || !playback; });
    $('reload').disabled = busy || !requestedUrl;
    $('previous').disabled = busy || !playback?.previous;
    $('next').disabled = busy || !playback?.next;
    document.querySelectorAll('.episode-button').forEach(button => { button.disabled = busy; });
  }
  function markEpisode() {
    document.querySelectorAll('.episode-button').forEach(button => {
      const current = button.dataset.url === playback?.url;
      if (current) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
      const saved=S.get(episodeId(button.dataset.url));
      button.lastElementChild.textContent=[current?'正在觀看':'',saved?(saved.completed?'已看完':'看到 '+S.time(saved.position)):''].filter(Boolean).join(' · ');
      let bar=button.querySelector('progress');if(saved){if(!bar){bar=document.createElement('progress');button.insertBefore(bar,button.lastElementChild);}bar.max=saved.duration;bar.value=saved.position;bar.setAttribute('aria-label','觀看進度');}
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
    $('episode-picker').hidden = false;
    listInput = url; retryPage = page;
    const focused = document.activeElement;
    const focusedUrl = focused?.classList.contains('episode-button') ? focused.dataset.url : null;
    const restoreListFocus = focusedUrl || focused === $('episodes-more') || focused === $('episodes-retry');
    const id = ++listGeneration; listRequest?.abort(); listRequest = new AbortController();
    const signal = listRequest.signal;
    if (page === 1) { catalog = null; $('episodes').replaceChildren(); $('series-title').textContent = '正在讀取動畫集數…'; }
    $('episodes-status').textContent = '正在讀取集數…'; $('episodes-error').hidden = true; $('episodes-retry').hidden = true; $('episodes-more').hidden = true;
    try {
      const endpoint = url.startsWith('series:') ? '/api/series?id=' + url.slice(7) : '/api/episodes?url=' + encodeURIComponent(url);
      const response = await fetch(endpoint + '&page=' + page, { signal });
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
      if (restoreListFocus && (document.activeElement === focused || document.activeElement === document.body)) {
        const buttons = [...document.querySelectorAll('.episode-button:not(:disabled)')];
        const target = buttons.find(button => button.dataset.url === focusedUrl) || buttons[0];
        target?.focus();target?.scrollIntoView({block:'nearest',inline:'nearest'});
      }
      document.dispatchEvent(new CustomEvent('anime1:episodes-ready'));
    } catch (e) {
      if (signal.aborted || id !== listGeneration) return;
      if (!catalog) $('series-title').textContent = '動畫集數';
      $('episodes-status').textContent = '';
      $('episodes-error').textContent = e.message || '讀取集數失敗。'; $('episodes-error').hidden = false; $('episodes-retry').hidden = false;
    }
  }
  async function prepare(url, refresh = false, opts = {}) {
    window.TVDanmaku?.stop();saveProgress();watchArmed=false;pendingResume=null;requestedUrl=url;
    $('watch-player').after($('episode-picker'));
    $('episode-picker').hidden=false;
    if(opts.seriesId!==undefined){selectedSeries=opts.seriesId;selectedTitle=opts.seriesTitle||S.get(episodeId(url))?.seriesTitle||'';}
    else if(!catalog?.episodes.some(item=>item.url===url)){selectedSeries=null;selectedTitle='';}
    if(opts.route!==false){const p=S.route();p.set('view','watch');p.set('episode',episodeId(url)||'');if(selectedSeries)p.set('series',selectedSeries);else p.delete('series');S.navigate(p);}
    $('resume-status').hidden=true;

    $('home-browser').hidden = true; $('home-detail').hidden = true; $('watch-player').hidden = false; $('home-back').hidden = false;
    const id = ++generation; request?.abort(); request = new AbortController();
    const signal = request.signal;
    video.pause(); video.removeAttribute('src'); video.load(); playback = null;
    $('play').textContent = '▶ 播放'; controls(true); error(''); $('empty').hidden = false;
    $('empty-title').textContent = '正在準備你的影片'; $('empty-description').textContent = '取得播放資料';
    $('title').textContent = '準備影片中'; $('source').hidden = true; $('episode-nav').hidden = true;
    status('正在準備影片…');
    const sync=S.refresh();
    const slow=setTimeout(()=>{if(id===generation)status('原站回應較慢，仍在取得播放資料…');},12000);
    const timeout=setTimeout(()=>request?.signal===signal&&request.abort('timeout'),65000);
    markEpisode(); void loadEpisodes(url);
    try {
      const response = await fetch('/api/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, refresh }), signal });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('播放服務未能回應，請稍後重試。');
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '未能準備影片。');
      if (!/^\/api\/media\?id=\d{1,10}$/.test(data.media) || typeof data.title !== 'string') throw new Error('播放資料不完整。');
      await sync;if (id !== generation) return;
      selectedSeries=data.seriesId||selectedSeries;
      const p=S.route();if(selectedSeries&&p.get('view')==='watch'){p.set('series',selectedSeries);S.navigate(p,true);}
      pendingResume=S.get(episodeId(data.url))||null;
      playback = data; video.src = data.media; video.load(); $('empty').hidden = true;
      markEpisode();
      window.TVDanmaku?.open({episodeId:episodeId(data.url),title:data.title,seriesTitle:selectedTitle||data.title.replace(/\s*\[[^\]]+\]\s*$/,''),seriesId:selectedSeries});
      $('title').textContent = data.title; $('source').href = data.url; $('source').hidden = false;
      $('episode-nav').hidden = !(data.previous || data.next); status('影片已準備好，請按播放');
      $('play').disabled = false; $('play').focus();
      return { state: 'ready', title: data.title, url: data.url };
    } catch (e) {
      if (signal.aborted&&signal.reason!=='timeout') return;
      if(signal.reason==='timeout')e=new Error('取得播放資料逾時，請按「重新載入」重試。');
      error(e.message || '連線失敗，請重試。'); status('未能載入'); $('empty-title').textContent = '暫時未能載入'; $('empty-description').textContent = '請查看下方的錯誤提示';
      return { state: 'error', message: e.message };
    } finally { clearTimeout(slow);clearTimeout(timeout);if (id === generation) {controls(false);if (!playback) $('reload').focus();} }
  }
  async function toggle() {
    if (!playback||$('watch-player').hidden) return;
    if (!video.paused) { video.pause(); return; }
    try { await video.play(); } catch (e) { error(e.name === 'NotAllowedError' ? '請再按一次播放鍵，允許電視開始播放。' : '電視未能開始播放，可按「重新載入」更新影片連線。'); }
  }
  $('episodes-retry').addEventListener('click', () => void loadEpisodes(listInput, retryPage, true));
  $('episodes-more').addEventListener('click', () => { if (catalog?.nextPage) void loadEpisodes(listInput, catalog.nextPage); });
  $('play').addEventListener('click', () => void toggle());
  $('reload').addEventListener('click', () => { if (requestedUrl) void prepare(requestedUrl, true, {seriesId:selectedSeries,seriesTitle:selectedTitle}); });
  $('previous').addEventListener('click', () => { if (playback?.previous) void prepare(playback.previous.url); });
  $('next').addEventListener('click', () => { if (playback?.next) void prepare(playback.next.url); });
  $('fullscreen').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('screen').requestFullscreen) await $('screen').requestFullscreen(); else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); else error('請使用影片內建的全螢幕按鈕。'); }
    catch { error('請使用影片內建的全螢幕按鈕。'); }
  });
  video.addEventListener('playing', () => { restorePosition();watchArmed=true;lastSavedAt=Date.now();status('播放中'); $('play').textContent = '❚❚ 暫停'; error(''); });
  video.addEventListener('pause', () => { saveProgress();if (playback) status('已暫停'); $('play').textContent = '▶ 播放'; });
  video.addEventListener('waiting', () => { if (playback) status('緩衝中…'); });
  video.addEventListener('canplay', () => { if (playback) status(video.paused ? '可以播放' : '播放中'); });
  video.addEventListener('ended', () => { saveProgress();status('本集播放完畢'); $('play').textContent = '▶ 播放'; });
  video.addEventListener('error', () => { if (playback) { status('播放失敗'); error('影片未能播放（' + (video.error?.code || '未知') + '），可按「重新載入」更新播放連線。'); } });
  video.addEventListener('loadedmetadata',restorePosition);
  video.addEventListener('durationchange',restorePosition);
  video.addEventListener('timeupdate',()=>{if(Date.now()-lastSavedAt>=15000)saveProgress();});
  video.addEventListener('seeked',saveProgress);
  window.addEventListener('pagehide',saveProgress);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)saveProgress();else void S.refresh();});
  document.addEventListener('anime1:history-updated',markEpisode);
  document.addEventListener('anime1:profile-changing',()=>{stop();lastRecorded='';});
  document.addEventListener('anime1:profile-changed',()=>{if(playback&&!$('watch-player').hidden)void prepare(playback.url,false,{seriesId:playback.seriesId,route:false});});
  document.addEventListener('keydown', e => {
    const current = document.activeElement;
    if (current?.matches('input,textarea,select')) return;
    if (e.keyCode === 10252 || e.key === 'MediaPlayPause' || e.code === 'Space' && !current?.matches('button')) { e.preventDefault(); void toggle(); return; }
    if (e.keyCode === 415) { e.preventDefault(); if (video.paused) void toggle(); return; }
    if (e.keyCode === 19) { e.preventDefault(); video.pause(); return; }
    if (current === video && ['ArrowLeft','ArrowRight'].includes(e.key) && Number.isFinite(video.duration)) { e.preventDefault(); video.currentTime = Math.max(0,Math.min(video.duration,video.currentTime+(e.key === 'ArrowRight' ? 10 : -10))); return; }
    const directions = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }; const direction = directions[e.key];
    if (!direction || !current || current === document.body) return;
    const rect = current.getBoundingClientRect(); const x = rect.x + rect.width/2; const y = rect.y + rect.height/2;
    let best = null; let bestScore = Infinity;
    document.querySelectorAll('button:not(:disabled),input,select,a[href],video').forEach(candidate => {
      if (candidate === current || candidate.closest('[hidden]')) return;
      const r = candidate.getBoundingClientRect(); if (!r.width || !r.height) return;
      const dx=r.x+r.width/2-x, dy=r.y+r.height/2-y; const forward=dx*direction[0]+dy*direction[1];
      if (forward <= 1) return; const score=forward+Math.abs(dx*direction[1]-dy*direction[0])*3;
      if(score<bestScore) {best=candidate;bestScore=score;}
    });
    if(best) {e.preventDefault();best.focus();best.scrollIntoView({block:'nearest',inline:'nearest'});}
  });
  document.addEventListener('anime1:open-series', e => {
    $('detail-comments').before($('episode-picker'));
    stop();requestedUrl='';selectedSeries=String(e.detail.id);selectedTitle=e.detail.title||'';video.removeAttribute('src');video.load();playback=null;controls(false);
    void loadEpisodes('series:' + e.detail.id, 1, true);
  });
  document.addEventListener('anime1:home',()=>{stop();listGeneration++;listRequest?.abort();$('episode-picker').hidden=true;});
  document.addEventListener('anime1:watch',e=>void prepare('https://anime1.me/'+e.detail.episodeId,false,{seriesId:e.detail.seriesId,seriesTitle:e.detail.seriesTitle}));
  document.addEventListener('anime1:route',()=>{
    const p=S.route();
    if(p.get('view')==='watch'&&/^\d{1,10}$/.test(p.get('episode')||''))void prepare('https://anime1.me/'+p.get('episode'),false,{route:false,seriesId:p.get('series')});
  });
  // Optional browser-standard agent action; there is no ChatGPT network dependency.
  if (document.modelContext?.registerTool) {
    try { Promise.resolve(document.modelContext.registerTool({ name: 'prepare_anime1_episode', title: '準備動畫影片', description: 'Prepare an episode in the visible player without starting playback.', inputSchema: {type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}, annotations: {readOnlyHint:false,untrustedContentHint:true}, execute: async input => {if(typeof input?.url !== 'string' || !/^https:\/\/anime1\.me\/\d+\/?$/.test(input.url)) throw new Error('請提供 Anime1 單集網址。');return await prepare(input.url);} })).catch(() => {}); } catch {}
  }
})();
