import { useState } from 'preact/hooks';
import { getSettings, saveSettings, clearSearches } from '../lib/settings.js';
import { SITE } from '../lib/http.js';
import { appVersion } from '../platform/tv.js';
import { toast } from '../components/Toast.jsx';

const STEPS = [5, 10, 15, 30];

function cycle(list, value) {
  const i = list.indexOf(value);
  return list[(i + 1) % list.length];
}

function Row({ label, value, hint, onSelect, autofocus }) {
  return (
    <button type="button" tabIndex={-1} class="setting-row focusable" onClick={onSelect} data-autofocus={autofocus ? '' : undefined}>
      <span class="setting-text"><span class="setting-label">{label}</span>{hint && <span class="setting-hint">{hint}</span>}</span>
      {value != null && <span class="setting-value">{value}</span>}
    </button>
  );
}

export function Settings() {
  const [s, setS] = useState(getSettings);
  const set = patch => setS(saveSettings(patch));
  return (
    <div class="page" data-scroll="y" data-scroll-pad="160">
      <header class="page-header"><h1 class="page-title">設定</h1></header>
      <section class="settings">
        <h2 class="section-title">播放</h2>
        <div class="settings-group" data-focus-group="settings">
          <Row label="自動播放下一集" hint="一集完結後接住播下一集" value={s.autoNext ? '開' : '關'} autofocus onSelect={() => set({ autoNext: !s.autoNext })} />
          <Row label="快進／快退步長" hint="播放時遙控器左右鍵每次跳過的秒數；快進鍵為三倍" value={s.seekStep + ' 秒'} onSelect={() => set({ seekStep: cycle(STEPS, s.seekStep) })} />
          <Row label="清除搜尋紀錄" onSelect={() => { clearSearches(); toast('搜尋紀錄已清除'); }} />
        </div>
        <h2 class="section-title">遙控器</h2>
        <div class="about">
          <p>方向鍵移動，確認鍵選擇，返回鍵後退；在首頁按返回會詢問是否退出。</p>
          <p>播放時：左右鍵快退／快進，上鍵叫出控制列，下鍵選集；頻道 ▲▼ 或上一曲／下一曲切換集數；紅色鍵開關彈幕，綠色鍵選集，黃色鍵倍速，藍色鍵彈幕設定。</p>
          <p>動畫目錄按黃色鍵重設篩選；觀看紀錄按藍色鍵查看動畫詳情。</p>
        </div>
        <h2 class="section-title">關於</h2>
        <div class="about">
          <p><b>Anime1 TV · Samsung 電視版</b> {appVersion()}</p>
          <p>伺服器：{SITE}</p>
          <p>獨立相容介面，並非 Anime1 官方網站。片源：Anime1 · 動畫資料：Bangumi、bangumi-data（CC BY 4.0）· 彈幕：彈彈play、動畫瘋、Bilibili。封面版權屬各權利人所有。</p>
        </div>
      </section>
    </div>
  );
}
