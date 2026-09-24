(() => {
  'use strict';
  const $ = id => document.getElementById(id), S = window.TVState;
  const panel = $('sync-panel');
  const read = key => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } };
  const persist = value => { try { if (value) sessionStorage.setItem('anime1-pairing', JSON.stringify(value)); else sessionStorage.removeItem('anime1-pairing'); } catch {} };
  const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
  const format = value => value.slice(0, 3) + ' ' + value.slice(3);
  let session = null, confirmation = null, timer = null, clock = null, revision = 0, busy = false, restoreFocus = null, closeTimer = null, paused = false;
  const notice = text => { $('pair-notice').textContent = text; $('pair-notice').hidden = !text; };
  const error = text => { $('pair-error').textContent = text; $('pair-error').hidden = !text; };
  async function call(action, data, profile) {
    const response = await S.pairing(action, data, profile);
    let result;
    try { result = await response.json(); } catch { throw new Error('配對服務未能回應，請重試。'); }
    if (!response.ok) throw Object.assign(new Error(result.error || '配對失敗，請重試。'), {status: response.status});
    return result;
  }
  function show(view) {
    for (const name of ['home', 'wait', 'accept', 'input', 'confirm', 'done']) $('pair-' + name).hidden = name !== view;
    $('sync-advanced').hidden = view !== 'home'; error('');
  }
  function controls(disabled) {
    busy = disabled;
    for (const id of ['pair-create', 'pair-enter', 'pair-submit', 'pair-approve', 'pair-renew', 'sync-restore', 'pair-confirm-back', 'pair-input-back', 'pair-options', 'pair-accept-yes', 'pair-accept-no']) $(id).disabled = disabled;
    $('pair-approve').disabled = disabled || !$('pair-match').checked;
    panel.setAttribute('aria-busy', String(disabled));
  }
  // Playback stops only while this device is offering itself for pairing, and resumes if nothing changed.
  function pause() { if (!paused) { paused = true; S.pauseForPairing(); } }
  function resume() { if (paused) { paused = false; S.resumeAfterPairing(); } }
  function clearTimers() { clearTimeout(timer); clearInterval(clock); timer = clock = null; }
  function rememberConnection() {
    try { localStorage.setItem('anime1-paired-at', String(Date.now())); } catch {}
    $('pair-linked').textContent = '已設定跨裝置同步；之後開啟網站便會自動取得雲端進度。';
  }
  function open() {
    clearTimeout(closeTimer);
    if (panel.hidden) restoreFocus = document.activeElement;
    panel.hidden = false; document.body.classList.add('pairing-open');
    $('sync-toggle').setAttribute('aria-expanded', 'true');
    $('sync-code').value = S.profile().match(/.{1,4}/g).join('-');
    $('pair-title').focus({preventScroll: true});
  }
  async function close() {
    if (busy) { error('正在處理連接，請稍候。'); return; }
    if (session) {
      const current = session;
      try { await call('cancel', {sessionId: current.sessionId, secret: current.secret}, current.owner); }
      catch (e) { if (e.status === 409) { error(e.message); return; } }
    }
    revision++; clearTimers(); session = null; confirmation = null; persist(null);
    panel.hidden = true; document.body.classList.remove('pairing-open');
    $('sync-toggle').setAttribute('aria-expanded', 'false'); resume();
    if (restoreFocus?.isConnected && !restoreFocus.closest('[hidden]')) restoreFocus.focus({preventScroll: true});
    else $('sync-toggle').focus({preventScroll: true});
  }
  function countdown(current) {
    const seconds = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000));
    $('pair-expiry').textContent = seconds ? '配對碼有效時間 ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') : '配對碼已過期，請產生新碼。';
    if (!seconds) { $('pair-renew').hidden = false; $('pair-qr').hidden = true; }
  }
  async function poll(current, generation) {
    if (generation !== revision || current !== session || panel.hidden) return;
    try {
      const result = await call('status', {sessionId: current.sessionId, secret: current.secret}, current.owner);
      if (generation !== revision || current !== session) return;
      if (result.status === 'accepted') { await finish(current, generation); return; }
      if (result.status === 'approved') {
        clearTimers(); show('accept'); $('pair-verify').textContent = result.verify;
        $('pair-accept-counts').textContent = result.alreadyLinked ? '兩部裝置已經使用相同的觀看紀錄。' : '手機現有 ' + result.destinationCount + ' 集紀錄。';
        $('pair-accept-yes').focus({preventScroll: true}); return;
      }
      if (result.status !== 'pending') throw Object.assign(new Error('配對已取消或已使用，請產生新碼。'), {status: 410});
      error(''); $('pair-wait-status').textContent = '等待手機確認…';
      timer = setTimeout(() => void poll(current, generation), 2000);
    } catch (e) {
      if (generation !== revision || current !== session) return;
      controls(false);
      if (e.status === 410 || e.status === 403) {
        clearTimers(); persist(null); session = null;
        error(e.message); $('pair-qr').hidden = true; $('pair-renew').hidden = false; $('pair-renew').focus();
      } else { error('連線暫時中斷，正在重試；觀看紀錄未有刪除。'); timer = setTimeout(() => void poll(current, generation), 5000); }
    }
  }
  async function finish(current, generation) {
    clearTimers(); controls(true); $('pair-wait-status').textContent = '正在合併並載入觀看紀錄…';
    const result = await call('accept', {sessionId: current.sessionId, secret: current.secret}, current.owner);
    if (generation !== revision || current !== session) { controls(false); return; }
    const synced = await S.changeProfile(result.profile); paused = false;
    try { await call('ack', {sessionId: current.sessionId, secret: current.secret}, current.owner); } catch {}
    if (generation !== revision) return;
    persist(null); session = null; rememberConnection(); controls(false);
    const message = synced ? '已連接，觀看進度已同步。' : '已連接；網絡恢復後會自動載入觀看進度。';
    show('done'); $('pair-done-verify').hidden = true; $('pair-done-text').textContent = message; notice(message);
    closeTimer = setTimeout(() => void close(), 1400);
  }
  async function accept() {
    const current = session, generation = revision;
    if (busy || !current) return;
    try { await finish(current, generation); }
    catch (e) {
      if (generation !== revision || current !== session) return;
      controls(false); show('wait');
      if (e.status === 410 || e.status === 403) { clearTimers(); persist(null); session = null; error(e.message); $('pair-qr').hidden = true; $('pair-renew').hidden = false; $('pair-renew').focus(); }
      else { error(e.message || '連接未完成，請重試。'); void poll(current, generation); }
    }
  }
  async function reject() {
    if (busy || !session) return;
    const current = session; controls(true);
    try { await call('cancel', {sessionId: current.sessionId, secret: current.secret}, current.owner); }
    catch (e) { if (e.status !== 410) { error(e.message); controls(false); return; } }
    revision++; clearTimers(); persist(null); session = null; controls(false);
    show('home'); notice('已拒絕連接。如需要，請產生新配對碼再試。'); $('pair-create').focus();
  }
  function displaySession(current) {
    session = current; persist(current); show('wait'); $('pair-qr').hidden = false; $('pair-renew').hidden = true;
    $('pair-digits').textContent = format(current.code); $('pair-site').textContent = location.host;
    $('pair-wait-status').textContent = '等待手機確認…';
    const link = new URL('/', location.origin); link.hash = 'pair=' + current.ticket;
    try { window.TVQRCode($('pair-qr'), link.href); }
    catch { $('pair-qr').hidden = true; error('QR Code 未能顯示，請改用下方六位配對碼。'); }
    countdown(current); clock = setInterval(() => countdown(current), 1000);
    $('pair-cancel').focus({preventScroll: true}); void poll(current, revision);
  }
  async function create() {
    if (busy) return;
    const generation = ++revision; clearTimers(); controls(true); error('');
    try {
      if (session) { await call('cancel', {sessionId: session.sessionId, secret: session.secret}, session.owner); session = null; persist(null); }
      pause();
      if (!await S.flush()) throw new Error('此裝置仍有未儲存的觀看進度。請恢復網絡後再連接，避免遺失紀錄。');
      const secret = random(), owner = S.profile(), result = await call('create', {secret});
      if (generation !== revision) return;
      displaySession({...result, secret, owner});
    } catch (e) { show('home'); error(e.message || '未能建立配對，請重試。'); }
    finally { controls(false); }
  }
  async function preview(data) {
    if (busy) return;
    const generation = ++revision; controls(true); error(''); confirmation = null;
    try {
      if (!await S.flush()) throw new Error('手機仍有未儲存的進度，請恢復網絡後重試。');
      const result = await call('preview', data);
      if (generation !== revision) return;
      confirmation = result; show('confirm'); $('pair-confirm-code').textContent = format(result.code);
      $('pair-counts').textContent = result.alreadyLinked ? '兩部裝置已經使用相同的觀看紀錄。' : '電視／電腦：' + result.sourceCount + ' 集紀錄 · 本手機：' + result.destinationCount + ' 集紀錄';
      $('pair-empty-warning').hidden = result.destinationCount !== 0;
      $('pair-match').checked = false; $('pair-match').focus();
    } catch (e) { show('input'); error(e.message || '未能讀取配對碼，請重試。'); }
    finally { controls(false); }
  }
  async function approve() {
    if (busy || !confirmation || !$('pair-match').checked) return;
    controls(true); error('');
    try {
      if (!await S.flush()) throw new Error('仍有未儲存的進度，請連線後重試。');
      const result = await call('approve', {sessionId: confirmation.sessionId, confirmation: confirmation.confirmation});
      show('done'); $('pair-done-verify').textContent = result.verify; $('pair-done-verify').hidden = false;
      $('pair-done-text').textContent = '請在電視／電腦核對這個數字並選擇連接。連接後觀看紀錄會合併，之後便可在不同時間接續觀看。';
      $('pair-done').querySelector('button').focus(); confirmation = null;
    } catch (e) { error(e.message || '連接未完成，請重試。'); }
    finally { controls(false); }
  }
  $('sync-toggle').addEventListener('click', () => {
    if (!panel.hidden) { void close(); return; }
    open(); show('home'); if (matchMedia('(min-width:1051px)').matches) $('pair-create').focus({preventScroll: true});
  });
  for (const id of ['pair-close', 'pair-cancel', 'pair-finish']) $(id).addEventListener('click', () => void close());
  $('pair-create').addEventListener('click', () => void create());
  $('pair-options').addEventListener('click', async () => {
    if (busy) return; controls(true);
    try { if (session) await call('cancel', {sessionId: session.sessionId, secret: session.secret}, session.owner); revision++; clearTimers(); persist(null); session = null; show('home'); $('pair-enter').focus(); }
    catch (e) { error(e.message); } finally { controls(false); }
  });
  $('pair-renew').addEventListener('click', () => void create());
  $('pair-accept-yes').addEventListener('click', () => void accept());
  $('pair-accept-no').addEventListener('click', () => void reject());
  $('pair-enter').addEventListener('click', () => { show('input'); $('pair-code-input').focus(); });
  $('pair-input-back').addEventListener('click', () => { show('home'); $('pair-enter').focus(); });
  $('pair-confirm-back').addEventListener('click', () => { confirmation = null; show('input'); $('pair-code-input').focus(); });
  $('pair-code-form').addEventListener('submit', e => {
    e.preventDefault();
    const code = $('pair-code-input').value.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 65248)).replace(/[\s-]/g, '');
    if (!/^\d{6}$/.test(code)) { error('請輸入電視／電腦顯示的六位數字。'); return; }
    void preview({code});
  });
  $('pair-match').addEventListener('change', () => { $('pair-approve').disabled = busy || !$('pair-match').checked; });
  $('pair-approve').addEventListener('click', () => void approve());
  $('sync-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('sync-code').value); error(''); notice('私人復原碼已複製，請勿公開分享。'); }
    catch { $('sync-code').focus(); $('sync-code').select(); error('請複製上方私人復原碼。'); }
  });
  $('sync-form').addEventListener('submit', async e => {
    e.preventDefault(); if (busy || !$('sync-restore-confirm').checked) return;
    const next = $('sync-input').value.replace(/[-\s]/g, '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(next)) { error('請輸入完整的 32 位私人復原碼。'); return; }
    controls(true);
    try { const synced = await S.changeProfile(next); $('sync-code').value = next.match(/.{1,4}/g).join('-'); $('sync-input').value = ''; $('sync-restore-confirm').checked = false; notice(synced ? '紀錄已復原。' : '復原碼已保存，網絡恢復後會載入紀錄。'); }
    catch (e) { error(e.message); } finally { controls(false); }
  });
  function consumeLink() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (!params.has('pair')) return false;
    const ticket = params.get('pair'); params.delete('pair');
    history.replaceState(null, '', location.pathname + location.search + (params.size ? '#' + params : ''));
    open(); show('input');
    if (/^[a-f0-9]{48}$/.test(ticket || '')) void preview({ticket});
    else error('配對連結無效，請重新掃描電視的 QR Code。');
    return true;
  }
  window.addEventListener('hashchange', consumeLink);
  document.addEventListener('keydown', e => {
    if (panel.hidden) return;
    if (e.key === 'Escape' || e.keyCode === 10009) { e.preventDefault(); e.stopImmediatePropagation(); void close(); return; }
    const focusable = [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),summary')].filter(el => !el.closest('[hidden]') && el.getClientRects().length);
    const at = focusable.indexOf(document.activeElement);
    if (e.key === 'Tab') {
      e.preventDefault(); e.stopImmediatePropagation();
      focusable[(at + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus(); return;
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !document.activeElement?.matches('input')) {
      e.preventDefault(); e.stopImmediatePropagation();
      focusable[(at + (['ArrowUp', 'ArrowLeft'].includes(e.key) ? -1 : 1) + focusable.length) % focusable.length]?.focus(); return;
    }
    e.stopImmediatePropagation();
  }, true);
  document.addEventListener('focusin', e => { if (!panel.hidden && !panel.contains(e.target)) $('pair-title').focus({preventScroll: true}); });
  $('pair-site').textContent = location.host; $('sync-code').value = S.profile().match(/.{1,4}/g).join('-');
  try { if (localStorage.getItem('anime1-paired-at')) $('pair-linked').textContent = '此瀏覽器已設定跨裝置同步；觀看紀錄會自動更新。'; } catch {}
  const pending = read('anime1-pairing');
  if (!consumeLink() && pending?.owner === S.profile() && pending.expiresAt > Date.now() && /^[a-f0-9]{64}$/.test(pending.secret || '')) {
    open(); displaySession(pending);
  } else if (!session) persist(null);
})();
