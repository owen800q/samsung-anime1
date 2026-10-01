(() => {
  'use strict';
  // Phone remote: browse on the phone, play on a TV/computer that shares this browser's sync profile.
  const $ = id => document.getElementById(id), S = window.TVState;
  const PROTOCOL = 'gimy-remote.v1', hexId = /^[a-f0-9]{32}$/;
  const store = {
    get: key => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (key, value) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {} }
  };
  const agent = navigator.userAgent;
  const kind = /Tizen|SMART-TV|SmartTV|Web0S|NetCast|HbbTV|BRAVIA/i.test(agent) ? 'tv' : matchMedia('(pointer:coarse)').matches && Math.min(screen.width, screen.height) < 700 ? 'phone' : 'computer';
  const icons = {tv: '📺', computer: '💻', phone: '📱'};
  const fallbackName = {tv: /Tizen|Samsung/i.test(agent) ? 'Samsung 電視' : '電視', computer: '電腦', phone: '手機'}[kind];
  let device = store.get('gimy-device');
  if (!hexId.test(device || '')) { device = [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join(''); store.set('gimy-device', device); }
  let name = store.get('gimy-device-name') || fallbackName;
  let target = hexId.test(store.get('gimy-remote-target') || '') ? store.get('gimy-remote-target') : null;
  let devices = [], seq = null, socket = null, mode = 'off', timer = null, failures = 0, retrySocketAt = 0, available = true, polling = false;
  let playing = undefined, published = null, stateTimer = null, toastTimer = null, restoreFocus = null, message = '';
  const received = new Map();
  const panel = $('remote-panel');

  async function request(action, data) {
    const response = await fetch('/api/remote/' + action, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + S.profile()}, body: JSON.stringify(data), signal: AbortSignal.timeout(8000)});
    let result = {}; try { result = await response.json(); } catch {}
    if (!response.ok) throw Object.assign(new Error(result.error || '遙控服務暫時未能回應，請重試。'), {status: response.status});
    return result;
  }
  const identity = () => ({device, name, kind});

  // Transport: a hibernating WebSocket when available, otherwise short polling.
  function disconnect() {
    clearTimeout(timer); timer = null; mode = 'off';
    if (socket) { const old = socket; socket = null; old.onopen = old.onclose = old.onmessage = null; try { old.close(); } catch {} }
  }
  function connect() {
    disconnect();
    if (!available) return;
    if (typeof WebSocket !== 'function' || Date.now() < retrySocketAt) { void poll(); return; }
    const url = new URL('/api/remote/socket', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    for (const [key, value] of Object.entries(identity())) url.searchParams.set(key, value);
    if (seq != null) url.searchParams.set('since', seq);
    let ws, opened = false;
    try { ws = new WebSocket(url, [PROTOCOL, S.profile()]); } catch { retrySocketAt = Date.now() + 300000; void poll(); return; }
    socket = ws; mode = 'connecting';
    ws.onopen = () => { opened = true; failures = 0; mode = 'socket'; heartbeat(); };
    ws.onmessage = event => { if (event.data !== 'pong') try { receive(JSON.parse(event.data)); } catch {} };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null; clearTimeout(timer);
      if (!opened) { retrySocketAt = Date.now() + 300000; void poll(); return; }
      mode = 'off'; failures++; timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** failures));
    };
  }
  function heartbeat() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (socket?.readyState === 1) { socket.send('ping'); heartbeat(); } }, 30000);
  }
  async function poll() {
    clearTimeout(timer); mode = 'poll';
    if (polling) return;
    polling = true;
    try {
      const result = await request('poll', {...identity(), since: seq});
      if (mode !== 'poll') return;
      run(result.commands); seq = Math.max(seq ?? 0, result.seq); setDevices(result.devices);
    } catch (error) {
      if ([404, 501, 503].includes(error.status)) { available = false; mode = 'off'; setDevices([]); return; }
    } finally { polling = false; }
    if (mode !== 'poll') return;
    if (typeof WebSocket === 'function' && retrySocketAt && Date.now() >= retrySocketAt) { retrySocketAt = 0; connect(); return; }
    const active = kind !== 'phone' || target || !panel.hidden;
    timer = setTimeout(() => void poll(), document.hidden ? 15000 : active ? 2000 : 10000);
  }
  function receive(data) {
    if (data.type === 'hello') { run(data.commands); seq = Math.max(seq ?? 0, data.seq); setDevices(data.devices); }
    else if (data.type === 'command') run([data]);
    else if (data.type === 'devices') setDevices(data.devices);
  }

  // Receiving side: hand commands to the player.
  function run(commands) {
    for (const item of commands || []) {
      if (seq != null && item.seq <= seq) continue;
      seq = item.seq;
      const command = item.command, from = item.from?.name || '另一部裝置';
      if (command.type === 'play') {
        toast('📱 ' + from + '：播放 ' + (command.title || command.seriesTitle || '影片'));
        document.dispatchEvent(new CustomEvent('gimy:remote-play', {detail: command}));
      } else {
        toast('📱 ' + from + '：' + describe(command));
        document.dispatchEvent(new CustomEvent('gimy:remote-control', {detail: command}));
      }
    }
  }
  function describe(command) {
    if (command.type === 'seek') return (command.delta > 0 ? '快進 ' : '倒後 ') + Math.abs(command.delta) + ' 秒';
    return {toggle: '播放／暫停', next: '下一集', previous: '上一集'}[command.type] || '遙控';
  }
  function toast(text) {
    const el = $('remote-toast'); el.textContent = text; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }
  // Tell phones what this screen plays: immediately on changes, otherwise every 10 seconds.
  document.addEventListener('gimy:playback-state', event => {
    playing = event.detail;
    const drift = published && playing ? Math.abs(playing.position - published.position - (published.paused ? 0 : (Date.now() - published.sentAt) / 1000)) : 0;
    const urgent = !published !== !playing || (playing && (playing.episodeId !== published.episodeId || playing.paused !== published.paused || drift > 3));
    schedule(urgent ? 0 : 10000);
  });
  function schedule(delay) {
    if (!available || playing === undefined || !devices.some(d => d.id !== device)) return;
    if (stateTimer && delay) return;
    clearTimeout(stateTimer); stateTimer = setTimeout(() => void publish(), delay);
  }
  async function publish() {
    stateTimer = null;
    published = playing ? {...playing, sentAt: Date.now()} : null;
    try { setDevices((await request('state', {...identity(), state: playing})).devices); } catch {}
  }

  // Controlling side.
  const screens = () => devices.filter(d => d.id !== device && d.kind !== 'phone');
  const chosen = () => devices.find(d => d.id === target && d.id !== device);
  function setDevices(list) {
    const before = new Set(devices.map(d => d.id));
    devices = Array.isArray(list) ? list : [];
    for (const d of devices) {
      const key = JSON.stringify(d.state);
      if (received.get(d.id)?.key !== key) received.set(d.id, {key, at: Date.now()});
    }
    if (devices.some(d => d.id !== device && !before.has(d.id))) schedule(0);
    render();
  }
  function position(d) {
    const state = d?.state; if (!state) return 0;
    const value = state.position + (state.paused ? 0 : (Date.now() - (received.get(d.id)?.at || Date.now())) / 1000);
    return state.duration ? Math.min(value, state.duration) : value;
  }
  let messageTimer = null;
  function setMessage(text) {
    message = text; render(); clearTimeout(messageTimer);
    if (text) messageTimer = setTimeout(() => { message = ''; render(); }, 5000);
  }
  async function send(command) {
    const screen = chosen();
    if (!screen) { setMessage('電視未連線：請確認電視已開啟本網站。'); return false; }
    try { await request('send', {...identity(), target: screen.id, command}); return true; }
    catch (error) { setMessage(error.message); return false; }
  }
  function cast(entry) {
    if (!target || !available) return false;
    const screen = chosen(), title = entry.title || entry.seriesTitle || '影片';
    if (!screen) { setMessage('電視未連線：請確認電視已開啟本網站。按 ✕ 可改回在此裝置播放。'); return true; }
    setMessage('正在傳送到 ' + screen.name + '…');
    void send({type: 'play', episodeId: String(entry.episodeId), seriesId: entry.seriesId ?? null, title, seriesTitle: entry.seriesTitle || ''})
      .then(ok => { if (ok) setMessage('已在 ' + screen.name + ' 播放：' + title); });
    return true;
  }
  function choose(id) {
    target = id; store.set('gimy-remote-target', id);
    const screen = chosen(); setMessage(screen ? '已選擇 ' + screen.name + '。在此手機揀集，便會在' + screen.name + '播放。' : '');
    if (mode === 'poll') void poll();
  }
  function release() { target = null; store.set('gimy-remote-target', null); setMessage('已停止遙控，揀集會在此裝置播放。'); }
  function render() {
    const others = screens(), screen = chosen(), state = screen?.state;
    $('remote-toggle').hidden = !available || (!others.length && !target);
    $('remote-empty').hidden = others.length > 0;
    const buttons = others.map(d => {
      const button = document.createElement('button');
      button.className = 'remote-device'; button.type = 'button'; button.dataset.device = d.id;
      button.setAttribute('aria-pressed', String(d.id === target));
      const label = document.createElement('strong'); label.textContent = icons[d.kind] + ' ' + d.name;
      const detail = document.createElement('small'); detail.textContent = d.state ? (d.state.paused ? '已暫停：' : '正在播放：') + d.state.title : '在線 · 未播放';
      button.append(label, detail); button.addEventListener('click', () => choose(d.id));
      return button;
    });
    const focusedDevice = document.activeElement?.dataset?.device;
    $('remote-devices').replaceChildren(...buttons);
    if (focusedDevice) $('remote-devices').querySelector('[data-device="' + focusedDevice + '"]')?.focus();
    $('remote-now').hidden = !state; $('remote-controls').hidden = !screen;
    if (state) {
      $('remote-now-status').textContent = (state.paused ? '已暫停 · ' : '正在播放 · ') + screen.name;
      $('remote-now-title').textContent = state.title;
      const at = position(screen);
      $('remote-now-progress').max = state.duration || 1; $('remote-now-progress').value = state.duration ? at : 0;
      $('remote-now-time').textContent = S.time(at) + (state.duration ? ' / ' + S.time(state.duration) : '');
    }
    for (const button of document.querySelectorAll('[data-remote="toggle"]')) { button.textContent = state && !state.paused ? '❚❚' : '▶'; button.setAttribute('aria-label', state && !state.paused ? '暫停' : '播放'); }
    $('remote-previous').disabled = !state?.hasPrevious; $('remote-next').disabled = !state?.hasNext;
    $('remote-status').textContent = message;
    const bar = !!target && available && panel.hidden;
    $('remote-bar').hidden = !bar; document.body.classList.toggle('remote-casting', bar);
    $('remote-bar-target').textContent = screen ? icons[screen.kind] + ' ' + screen.name : '📺 電視未連線';
    $('remote-bar-title').textContent = message || (state ? state.title + ' · ' + S.time(position(screen)) : '在此手機揀集，便會在電視播放');
  }
  setInterval(() => { if (chosen()?.state && !chosen().state.paused && (!panel.hidden || target)) render(); }, 1000);

  function open() {
    if (panel.hidden) restoreFocus = document.activeElement;
    panel.hidden = false; $('remote-toggle').setAttribute('aria-expanded', 'true');
    $('remote-name-input').value = name; message = ''; render();
    if (mode === 'socket') socket.send(JSON.stringify({type: 'devices'})); else if (mode === 'poll') void poll();
    $('remote-title').focus({preventScroll: true});
  }
  function close() {
    panel.hidden = true; $('remote-toggle').setAttribute('aria-expanded', 'false'); render();
    const back = restoreFocus?.isConnected && !restoreFocus.closest('[hidden]') ? restoreFocus : $('remote-toggle').hidden ? null : $('remote-toggle');
    back?.focus({preventScroll: true});
  }
  $('remote-toggle').addEventListener('click', () => panel.hidden ? open() : close());
  $('remote-close').addEventListener('click', close);
  $('remote-bar-open').addEventListener('click', open);
  $('remote-bar-stop').addEventListener('click', release);
  $('remote-browse').addEventListener('click', () => {
    close();
    if (!$('home-browser').hidden) $('home-browser').scrollIntoView({block: 'start'});
    else if (!$('home-back').hidden) $('home-back').click();
  });
  for (const button of document.querySelectorAll('[data-remote]')) button.addEventListener('click', () => {
    const type = button.dataset.remote;
    void send(type === 'seek' ? {type, delta: Number(button.dataset.delta)} : {type}).then(ok => { if (ok) setMessage(''); });
  });
  $('remote-name-form').addEventListener('submit', event => {
    event.preventDefault();
    name = $('remote-name-input').value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || fallbackName;
    store.set('gimy-device-name', name); $('remote-name-input').value = name; setMessage('已儲存裝置名稱。'); connect();
  });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape' || event.keyCode === 10009) { event.preventDefault(); event.stopPropagation(); close(); } });
  document.addEventListener('gimy:profile-changed', () => { seq = null; devices = []; available = true; connect(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && (mode === 'off' || mode === 'poll')) connect(); });
  window.addEventListener('online', () => { if (mode !== 'socket') connect(); });
  window.TVRemote = {cast, device: () => device};
  render(); connect();
})();

