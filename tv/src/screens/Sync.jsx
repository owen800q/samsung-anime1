import { useEffect, useRef, useState } from 'preact/hooks';
import { useKeys } from '../router.js';
import { SITE, randomHex } from '../lib/http.js';
import * as store from '../lib/store.js';
import * as remote from '../lib/remote.js';
import { focusFirst } from '../lib/focus.js';
import { QRCode } from '../components/QRCode.jsx';
import { Keypad } from '../components/Keypad.jsx';
import { TextField } from '../components/TextField.jsx';
import { Icon } from '../components/Icon.jsx';
import { toast } from '../components/Toast.jsx';

const format = value => value.slice(0, 3) + ' ' + value.slice(3);
const host = SITE.replace(/^https?:\/\//, '');
const ICONS = { tv: '📺', computer: '💻', phone: '📱' };

async function callPairing(action, data, owner) {
  const r = await store.pairing(action, data, owner);
  if (!r.json) throw new Error('配對服務未能回應，請重試。');
  if (!r.ok) throw Object.assign(new Error(r.data.error || '配對失敗，請重試。'), { status: r.status });
  return r.data;
}

function rememberConnection() {
  try { localStorage.setItem('anime1-paired-at', String(Date.now())); } catch (_) {}
}
function linkedBefore() {
  try { return !!localStorage.getItem('anime1-paired-at'); } catch (_) { return false; }
}

/**
 * 裝置同步: show a QR code / six-digit code for a phone (TV side of the website's pairing),
 * or enter another screen's code; recovery code; phone-remote device name and online devices.
 */
export function Sync() {
  const [view, setView] = useState('home'); // home | wait | accept | input | confirm | done
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState(null);
  const [remaining, setRemaining] = useState(0);
  const [waitText, setWaitText] = useState('等待手機確認…');
  const [verify, setVerify] = useState(null);
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [agreed, setAgreed] = useState(false);
  const [done, setDone] = useState({ text: '', verify: '' });
  const [linked, setLinked] = useState(linkedBefore);
  const [sync, setSync] = useState(store.syncStatus);
  const [profile, setProfile] = useState(store.profile);
  const [recovery, setRecovery] = useState('');
  const [recoveryAgreed, setRecoveryAgreed] = useState(false);
  const [name, setName] = useState(remote.deviceName);
  const [devices, setDevices] = useState(remote.others);
  const revision = useRef(0);
  const sessionRef = useRef(null);
  const pollTimer = useRef(0);
  const ref = useRef(null);
  sessionRef.current = session;

  useEffect(() => {
    remote.refreshDevices();
    const offStore = store.subscribe(kind => {
      if (kind === 'sync') setSync(store.syncStatus());
      if (kind === 'profile-changed') setProfile(store.profile());
    });
    const offDevices = remote.onDevices(() => setDevices(remote.others()));
    return () => {
      offStore(); offDevices();
      revision.current++;
      clearTimeout(pollTimer.current);
      const current = sessionRef.current;
      if (current) callPairing('cancel', { sessionId: current.sessionId, secret: current.secret }, current.owner).catch(() => {});
      store.resumeAfterPairing();
    };
  }, []);

  useEffect(() => {
    if (!session) return undefined;
    const tick = () => setRemaining(Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [session]);

  useEffect(() => { setTimeout(() => focusFirst('[data-autofocus]', ref.current), 30); }, [view]);

  function show(next) { setView(next); setError(''); }

  async function cancelSession() {
    const current = sessionRef.current;
    revision.current++;
    clearTimeout(pollTimer.current);
    setSession(null);
    if (current) {
      try { await callPairing('cancel', { sessionId: current.sessionId, secret: current.secret }, current.owner); }
      catch (e) { if (e.status === 409) { setError(e.message); return false; } }
    }
    store.resumeAfterPairing();
    return true;
  }

  // ---------- this TV shows the code ----------
  async function create() {
    if (busy) return;
    const generation = ++revision.current;
    clearTimeout(pollTimer.current);
    setBusy(true); setError('');
    try {
      const old = sessionRef.current;
      if (old) { await callPairing('cancel', { sessionId: old.sessionId, secret: old.secret }, old.owner); setSession(null); }
      store.pauseForPairing();
      if (!await store.flush()) throw new Error('此裝置仍有未儲存的觀看進度。請恢復網絡後再連接，避免遺失紀錄。');
      const secret = randomHex(32), owner = store.profile();
      const result = await callPairing('create', { secret });
      if (generation !== revision.current) return;
      const current = Object.assign({}, result, { secret, owner });
      setSession(current);
      setWaitText('等待手機確認…');
      show('wait');
      poll(current, generation);
    } catch (e) {
      show('home'); setError(e.message || '未能建立配對，請重試。');
    } finally { setBusy(false); }
  }
  async function poll(current, generation) {
    if (generation !== revision.current) return;
    try {
      const result = await callPairing('status', { sessionId: current.sessionId, secret: current.secret }, current.owner);
      if (generation !== revision.current) return;
      if (result.status === 'accepted') { await finish(current, generation); return; }
      if (result.status === 'approved') {
        setVerify({ number: result.verify, text: result.alreadyLinked ? '兩部裝置已經使用相同的觀看紀錄。' : '手機現有 ' + result.destinationCount + ' 集紀錄。' });
        show('accept');
        return;
      }
      if (result.status !== 'pending') throw Object.assign(new Error('配對已取消或已使用，請產生新碼。'), { status: 410 });
      setError(''); setWaitText('等待手機確認…');
      pollTimer.current = setTimeout(() => poll(current, generation), 2000);
    } catch (e) {
      if (generation !== revision.current) return;
      if (e.status === 410 || e.status === 403) { setSession(null); setError(e.message); }
      else { setError('連線暫時中斷，正在重試；觀看紀錄未有刪除。'); pollTimer.current = setTimeout(() => poll(current, generation), 5000); }
    }
  }
  async function finish(current, generation) {
    clearTimeout(pollTimer.current);
    setBusy(true); setWaitText('正在合併並載入觀看紀錄…');
    try {
      const result = await callPairing('accept', { sessionId: current.sessionId, secret: current.secret }, current.owner);
      if (generation !== revision.current) return;
      const synced = await store.changeProfile(result.profile);
      try { await callPairing('ack', { sessionId: current.sessionId, secret: current.secret }, current.owner); } catch (_) {}
      if (generation !== revision.current) return;
      setSession(null); rememberConnection(); setLinked(true);
      const text = synced ? '已連接，觀看進度已同步。' : '已連接；網絡恢復後會自動載入觀看進度。';
      setDone({ text, verify: '' }); show('done'); toast(text);
    } catch (e) {
      if (generation !== revision.current) return;
      show('wait');
      if (e.status === 410 || e.status === 403) { setSession(null); setError(e.message); }
      else { setError(e.message || '連接未完成，請重試。'); poll(current, generation); }
    } finally { setBusy(false); }
  }
  async function reject() {
    const current = sessionRef.current;
    if (busy || !current) return;
    setBusy(true);
    try { await callPairing('cancel', { sessionId: current.sessionId, secret: current.secret }, current.owner); }
    catch (e) { if (e.status !== 410) { setError(e.message); setBusy(false); return; } }
    revision.current++; setSession(null); setBusy(false); store.resumeAfterPairing();
    show('home'); toast('已拒絕連接。如需要，請產生新配對碼再試。');
  }

  // ---------- this TV enters another screen's code ----------
  async function preview() {
    if (busy) return;
    if (!/^\d{6}$/.test(code)) { setError('請輸入另一部裝置顯示的六位數字。'); return; }
    const generation = ++revision.current;
    setBusy(true); setError(''); setConfirmation(null);
    try {
      if (!await store.flush()) throw new Error('此裝置仍有未儲存的進度，請恢復網絡後重試。');
      const result = await callPairing('preview', { code });
      if (generation !== revision.current) return;
      setConfirmation(result); setAgreed(false); show('confirm');
    } catch (e) { setError(e.message || '未能讀取配對碼，請重試。'); }
    finally { setBusy(false); }
  }
  async function approve() {
    if (busy || !confirmation || !agreed) return;
    setBusy(true); setError('');
    try {
      if (!await store.flush()) throw new Error('仍有未儲存的進度，請連線後重試。');
      const result = await callPairing('approve', { sessionId: confirmation.sessionId, confirmation: confirmation.confirmation });
      setConfirmation(null); rememberConnection(); setLinked(true);
      setDone({ text: '請在另一部電視／電腦核對這個數字並選擇連接。連接後觀看紀錄會合併，之後便可在不同時間接續觀看。', verify: result.verify });
      show('done');
    } catch (e) { setError(e.message || '連接未完成，請重試。'); }
    finally { setBusy(false); }
  }

  // ---------- recovery code ----------
  async function restore() {
    const next = recovery.replace(/[-\s]/g, '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(next)) { setError('請輸入完整的 32 位私人復原碼。'); return; }
    if (!recoveryAgreed) { setError('請先確認切換此電視的紀錄。'); return; }
    setBusy(true); setError('');
    try {
      const synced = await store.changeProfile(next);
      setRecovery(''); setRecoveryAgreed(false);
      toast(synced ? '紀錄已復原。' : '復原碼已保存，網絡恢復後會載入紀錄。');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  useKeys(action => {
    if (view !== 'input' || action.indexOf('digit') !== 0) return false;
    setCode(c => (c + action.slice(5)).slice(0, 6));
    return true;
  });

  const err = error ? <p class="sync-error" role="alert">{error}</p> : null;

  return (
    <div class="page" data-scroll="y" data-scroll-pad="160" ref={ref}>
      <header class="page-header page-header-row">
        <h1 class="page-title">裝置同步</h1>
        <span class="hint-inline">{sync}</span>
      </header>
      <p class="sync-lead">{linked ? '此電視已設定跨裝置同步；觀看紀錄會自動更新。' : '首次連接一次，之後自動同步；不需要同時開機或使用相同 Wi-Fi。'}</p>

      {view === 'home' && (
        <section class="sync-card">
          <h2 class="sync-title">換個螢幕，接住睇。</h2>
          <p class="sync-text">用手機掃描電視的 QR Code，手機、電腦與電視便共用同一份觀看紀錄。配對後可以用手機遙控這部電視揀集、暫停、快進。</p>
          <div class="panel-row">
            <button type="button" tabIndex={-1} class="btn btn-primary btn-lg focusable" data-autofocus disabled={busy} onClick={create}><Icon name="phone" />顯示 QR Code，讓手機連接</button>
            <button type="button" tabIndex={-1} class="btn btn-lg focusable" disabled={busy} onClick={() => { setCode(''); show('input'); }}>輸入另一部裝置的配對碼</button>
          </div>
          {err}
        </section>
      )}

      {view === 'wait' && (
        <section class="sync-card sync-pair">
          {session && remaining > 0 ? <QRCode text={SITE + '/#pair=' + session.ticket} onError={() => setError('QR Code 未能顯示，請改用右邊的六位配對碼。')} /> : <div class="qr qr-expired">配對碼已過期</div>}
          <div class="sync-pair-info">
            <h2 class="sync-title">用手機掃描，同步觀看進度</h2>
            <p class="sync-text">無法掃描？在手機開啟 <strong>{host}</strong>，選「裝置同步 → 連接電視／電腦」，輸入：</p>
            {session && <div class="pair-code">{format(session.code)}</div>}
            <p class="sync-text">{session && remaining ? '配對碼有效時間 ' + Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0') : '配對碼已過期，請產生新碼。'}</p>
            <p class="sync-status">{waitText}</p>
            {err}
            <div class="panel-row">
              {(!session || !remaining) && <button type="button" tabIndex={-1} class="btn btn-primary focusable" data-autofocus disabled={busy} onClick={create}>產生新配對碼</button>}
              <button type="button" tabIndex={-1} class="btn focusable" data-autofocus={session && remaining ? '' : undefined} disabled={busy} onClick={async () => { if (await cancelSession()) show('home'); }}>取消</button>
            </div>
          </div>
        </section>
      )}

      {view === 'accept' && verify && (
        <section class="sync-card">
          <h2 class="sync-title">手機已確認，請核對數字</h2>
          <p class="sync-text">只在手機畫面顯示相同數字時才連接。如你未有用手機確認，請按「不是我的手機」。</p>
          <div class="pair-code">{verify.number}</div>
          <p class="sync-text">{verify.text}</p>
          <p class="panel-hint">連接後，此電視的觀看紀錄會合併至該手機的紀錄，並改用手機的紀錄繼續同步。</p>
          {err}
          <div class="panel-row">
            <button type="button" tabIndex={-1} class="btn btn-primary btn-lg focusable" data-autofocus disabled={busy} onClick={() => finish(sessionRef.current, revision.current)}>數字相同，連接</button>
            <button type="button" tabIndex={-1} class="btn btn-lg focusable" disabled={busy} onClick={reject}>不是我的手機</button>
          </div>
        </section>
      )}

      {view === 'input' && (
        <section class="sync-card sync-pair">
          <Keypad onDigit={d => setCode(c => (c + d).slice(0, 6))} onDelete={() => setCode(c => c.slice(0, -1))} />
          <div class="sync-pair-info">
            <h2 class="sync-title">連接另一部電視／電腦</h2>
            <p class="sync-text">在另一部裝置開啟「裝置同步 → 顯示 QR Code」，再用數字鍵輸入畫面上的六位配對碼。</p>
            <div class="pair-code pair-code-input">{(code + '______').slice(0, 6).replace(/^(...)/, '$1 ')}</div>
            {err}
            <div class="panel-row">
              <button type="button" tabIndex={-1} class="btn btn-primary focusable" disabled={busy || code.length !== 6} onClick={preview}>下一步</button>
              <button type="button" tabIndex={-1} class="btn focusable" onClick={() => show('home')}>返回</button>
            </div>
          </div>
        </section>
      )}

      {view === 'confirm' && confirmation && (
        <section class="sync-card">
          <h2 class="sync-title">確認連接這部裝置？</h2>
          <div class="pair-code">{format(confirmation.code)}</div>
          <p class="sync-text">{confirmation.alreadyLinked ? '兩部裝置已經使用相同的觀看紀錄。' : '另一部裝置：' + confirmation.sourceCount + ' 集紀錄 · 此電視：' + confirmation.destinationCount + ' 集紀錄'}</p>
          {confirmation.destinationCount === 0 && <p class="panel-hint">此電視未有觀看紀錄；另一部裝置的紀錄會保留。</p>}
          <p class="panel-hint">合併兩邊最近的觀看紀錄（最多 500 集）；同一集使用較新儲存的進度，而非最遠播放位置。彈幕設定亦會合併。另一部裝置會加入此電視的紀錄。</p>
          <div class="panel-row">
            <button type="button" tabIndex={-1} class={'btn check focusable' + (agreed ? ' is-on' : '')} data-autofocus onClick={() => setAgreed(!agreed)}>
              <span class="checkbox">{agreed ? '✓' : ''}</span>我確認配對碼與眼前的裝置相同，並同意合併紀錄
            </button>
          </div>
          {err}
          <div class="panel-row">
            <button type="button" tabIndex={-1} class="btn btn-primary focusable" disabled={busy || !agreed} onClick={approve}>連接並保留兩邊紀錄</button>
            <button type="button" tabIndex={-1} class="btn focusable" disabled={busy} onClick={() => { setConfirmation(null); show('input'); }}>取消確認</button>
          </div>
        </section>
      )}

      {view === 'done' && (
        <section class="sync-card">
          <h2 class="sync-title">確認完成</h2>
          <p class="sync-text">{done.text}</p>
          {done.verify ? <div class="pair-code">{done.verify}</div> : null}
          <div class="panel-row"><button type="button" tabIndex={-1} class="btn btn-primary focusable" data-autofocus onClick={() => show('home')}>完成</button></div>
        </section>
      )}

      <h2 class="section-title"><Icon name="phone" /> 手機遙控</h2>
      <section class="sync-card">
        <p class="sync-text">配對後，在手機開啟 {host}，按「📺 遙控」並選擇這部電視，便可用手機揀集、暫停、快進及跳過片頭。</p>
        <div class="panel-row">
          <span class="field-label">此裝置名稱</span>
          <TextField value={name} onInput={setName} onSubmit={value => { setName(remote.rename(value)); toast('已儲存裝置名稱。'); }} maxLength={40} label="此裝置名稱" placeholder="例如：客廳電視" />
          <button type="button" tabIndex={-1} class="btn focusable" onClick={() => { setName(remote.rename(name)); toast('已儲存裝置名稱。'); }}>儲存</button>
        </div>
        <p class="sync-text">{remote.isAvailable() ? (devices.length ? '在線裝置：' + devices.map(d => (ICONS[d.kind] || '') + ' ' + d.name).join('、') : '暫時未有其他在線裝置。') : '遙控服務暫時未能使用。'}</p>
      </section>

      <h2 class="section-title"><Icon name="lock" /> 進階：私人復原碼</h2>
      <section class="sync-card">
        <p class="panel-hint">只供備份或取回舊紀錄。持有復原碼的人可讀取及更改紀錄，請勿公開分享。</p>
        <p class="sync-text">此電視的私人復原碼：<span class="recovery">{profile.match(/.{1,4}/g).join('-')}</span></p>
        <div class="panel-row">
          <TextField value={recovery} onInput={setRecovery} onSubmit={setRecovery} maxLength={64} mono label="取回另一份紀錄" placeholder="輸入私人復原碼或舊同步碼" />
        </div>
        <div class="panel-row">
          <button type="button" tabIndex={-1} class={'btn check focusable' + (recoveryAgreed ? ' is-on' : '')} onClick={() => setRecoveryAgreed(!recoveryAgreed)}>
            <span class="checkbox">{recoveryAgreed ? '✓' : ''}</span>切換此電視的紀錄；原有雲端紀錄不會刪除，但不會合併
          </button>
          <button type="button" tabIndex={-1} class="btn focusable" disabled={busy || !recovery} onClick={restore}>復原紀錄</button>
        </div>
      </section>
    </div>
  );
}
