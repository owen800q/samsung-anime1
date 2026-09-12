(() => {
  'use strict';
  const $=id=>document.getElementById(id),video=$('video'),canvas=$('danmaku-canvas'),ctx=canvas.getContext('2d'),S=window.TVState;
  let episode=null,setting=null,epoch=0,controller=null,searchEpoch=0,searchController=null,saving=false;
  let segments=new Map(),pending=new Set(),failed=new Set(),layout=[],raf=0,layoutKey='',sourceEpoch=0;
  let enabled=true,density=8;
  try{enabled=localStorage.getItem('anime1-danmaku-enabled')!=='false';density=Number(localStorage.getItem('anime1-danmaku-density'))||8;}catch{}
  if(![4,8,12].includes(density))density=8;
  $('danmaku-density').value=String(density);
  const status=text=>{$('danmaku-status').textContent=text;};
  const searchStatus=text=>{$('danmaku-search-status').textContent=text;};
  const currentSegment=()=>setting?.source?.provider==='bilibili'?Math.max(1,Math.floor(Math.max(0,video.currentTime-(setting?.offset||0))/360)+1):1;
  const normal=s=>String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  async function json(path,signal){const r=await fetch(path,{signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});const d=await r.json();if(!r.ok)throw new Error(d.error||'彈幕暫時無法讀取。');return d;}
  function settingsUI(){
    const src=setting?.source;
    $('danmaku-current').textContent=src?(src.provider==='bahamut'?'動畫瘋':'Bilibili')+' · '+src.title:'本集未配對彈幕';
    $('danmaku-source-link').hidden=!src;if(src)$('danmaku-source-link').href=src.url;
    $('danmaku-offset').value=String(setting?.offset||0);
  }
  function clearCanvas(){if(ctx)ctx.clearRect(0,0,canvas.width,canvas.height);}
  function resetSource(){sourceEpoch++;segments.clear();pending.clear();failed.clear();layout=[];layoutKey='';clearCanvas();$('danmaku-retry').hidden=true;}
  function stop(){epoch++;episode=null;setting=null;controller?.abort();searchController?.abort();searchEpoch++;saving=false;resetSource();cancelAnimationFrame(raf);raf=0;}
  async function loadSegment(index){
    if(!enabled||!setting?.source||pending.has(index)||segments.has(index)||failed.has(index)||index>240)return;
    pending.add(index);const e=epoch,g=sourceEpoch,src=setting.source,signal=controller.signal;
    try{
      const data=await json('/api/danmaku/comments?provider='+src.provider+'&id='+encodeURIComponent(src.id)+'&segment='+index,signal);
      if(e!==epoch||g!==sourceEpoch)return;
      if(!Array.isArray(data.comments))throw new Error('彈幕資料不完整。');
      segments.set(index,data.comments);layoutKey='';
      for(const k of segments.keys())if(Math.abs(k-currentSegment())>1)segments.delete(k);
      const count=[...segments.values()].reduce((n,a)=>n+a.length,0);
      status(count?'已載入 '+count+' 條彈幕 · '+(src.provider==='bahamut'?'動畫瘋':'Bilibili'):'本時段暫時未有彈幕');draw();
    }catch(e2){if(e===epoch&&g===sourceEpoch&&!signal.aborted){failed.add(index);status(e2.message||'彈幕讀取失敗，影片仍可播放。');$('danmaku-retry').hidden=false;}}
    finally{if(e===epoch&&g===sourceEpoch)pending.delete(index);}
  }
  function ensureSegments(){
    if(!enabled||!episode||!setting?.source)return;
    const index=currentSegment();void loadSegment(index);
    if(setting.source.provider==='bilibili'){
      const time=Math.max(0,video.currentTime-setting.offset);
      if(time%360<15&&index>1)void loadSegment(index-1);
      if(time%360>330&&(!Number.isFinite(video.duration)||video.currentTime+30<video.duration))void loadSegment(index+1);
    }
  }
  function startSource(){resetSource();settingsUI();if(!setting?.source){status('本集未配對彈幕，請選擇來源。');return;}status(enabled?'正在讀取本集彈幕…':'彈幕已關閉');ensureSegments();}
  async function refreshSetting(){
    if(!episode||saving)return;const e=epoch,revision=setting?.revision;
    try{
      const r=await S.danmakuSettings(episode.episodeId,null,AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]));const data=await r.json();
      if(e!==epoch||saving||setting?.revision!==revision)return;if(!r.ok)throw new Error(data.error||'彈幕設定同步失敗。');
      if(!setting||data.entry.revision!==setting.revision){setting=data.entry;startSource();}
    }catch(error){if(e===epoch&&!controller.signal.aborted){status(error.message||'彈幕設定同步失敗，請重試。');$('danmaku-retry').hidden=false;}}
  }
  async function saveSource(source,offset=0){
    if(!episode||saving)return false;const e=epoch;const id=episode.episodeId;saving=true;status('正在儲存本集彈幕設定…');
    try{
      const r=await S.danmakuSettings(id,{episodeId:id,source,offset,revision:setting?.revision||0},AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]));const data=await r.json();
      if(e!==epoch)return false;
      if(r.status===409){setting=data.entry;startSource();throw new Error('另一裝置已更新配對，已載入最新設定，請重新選擇。');}
      if(!r.ok)throw new Error(data.error||'未能儲存彈幕設定。');setting=data.entry;startSource();return true;
    }catch(error){if(e===epoch){status(error.message||'未能儲存，請重試。');$('danmaku-retry').hidden=false;}return false;}
    finally{if(e===epoch)saving=false;}
  }
  function resultButton(label,action){const b=document.createElement('button');b.type='button';b.className='tv-button outline';b.textContent=label;b.addEventListener('click',()=>void action());$('danmaku-results').append(b);}
  async function showEpisodes(url){
    const e=epoch,g=++searchEpoch;searchController?.abort();searchController=new AbortController();const signal=searchController.signal;
    searchStatus('讀取來源集數…');
    try{const d=await json('/api/danmaku/resolve?url='+encodeURIComponent(url),signal);if(e!==epoch||g!==searchEpoch)return;
      $('danmaku-results').replaceChildren();searchStatus(d.title+' · 請選擇對應本集');
      for(const ep of d.episodes)resultButton(ep.label+' · '+ep.title,async()=>{if(await saveSource({provider:ep.provider,id:ep.id,url:ep.url,title:ep.title})){searchStatus('已儲存本集配對');$('danmaku-config').focus();}});
      $('danmaku-results').querySelector('button')?.focus();
    }catch(error){if(e===epoch&&g===searchEpoch&&!signal.aborted)searchStatus(error.message||'讀取來源失敗。');}
  }
  async function search(){
    if(!episode)return;const q=$('danmaku-query').value.trim();if(!q)return;
    if(/^https?:\/\/|^BV[0-9A-Za-z]{10}$/.test(q)){await showEpisodes(q);return;}
    const e=epoch,g=++searchEpoch;searchController?.abort();searchController=new AbortController();const signal=searchController.signal;
    searchStatus('正在搜尋動畫瘋…');$('danmaku-results').replaceChildren();
    try{const d=await json('/api/danmaku/search?q='+encodeURIComponent(q),signal);if(e!==epoch||g!==searchEpoch)return;
      searchStatus(d.results.length?'選擇動畫，再選對應集數':'未找到來源，試下別名或貼完整來源網址。');
      for(const item of d.results)resultButton('動畫瘋 · '+item.title,()=>showEpisodes(item.url));
      $('danmaku-results').querySelector('button')?.focus();
    }catch(error){if(e===epoch&&g===searchEpoch&&!signal.aborted)searchStatus(error.message||'搜尋失敗。');}
  }
  // Conservative automatic pairing: exact catalogue title/alias AND year AND episode.
  async function autoMatch(info,e,g){
    if(!enabled||!info.seriesId)return;
    const n=info.title.match(/\[(\d+(?:\.\d+)?)\]\s*$/)?.[1];if(!n)return;
    const signal=controller.signal;
    try{
      const {item}=await json('/api/catalog-item?id='+encodeURIComponent(info.seriesId),signal);
      const title=item.title;const names=[title,...(item.aliases||[])].map(normal);
      const found=await json('/api/danmaku/search?q='+encodeURIComponent(title),signal);
      const exact=found.results.filter(x=>names.includes(normal(x.title)));if(exact.length!==1)return;
      const d=await json('/api/danmaku/resolve?url='+encodeURIComponent(exact[0].url),signal);
      if(!names.includes(normal(d.title))||!/^\d{4}$/.test(d.year)||d.year!==String(item.year))return;
      const eps=d.episodes.filter(x=>/^\d+(?:\.\d+)?$/.test(x.label)&&Number(x.label)===Number(n));
      if(e!==epoch||g!==searchEpoch||setting?.revision||eps.length!==1)return;
      const ep=eps[0];await saveSource({provider:ep.provider,id:ep.id,url:ep.url,title:ep.title});
    }catch{ /* Automatic matching is optional; manual source selection remains available. */ }
  }
  async function open(info){
    stop();episode=info;controller=new AbortController();const e=epoch;
    $('danmaku-settings').hidden=true;$('danmaku-config').setAttribute('aria-expanded','false');$('danmaku-results').replaceChildren();searchStatus('');
    $('danmaku-query').value=info.seriesTitle||info.title;status('正在讀取本集彈幕設定…');settingsUI();
    await refreshSetting();if(e!==epoch)return;
    if(setting&&!setting.source&&!setting.revision)void autoMatch(info,e,searchEpoch);
  }

  function buildLayout(w,h){
    const font=Math.max(16,Math.min(32,w/36)),rows=Math.max(3,Math.min(density,Math.floor(h/(font*1.45)))),speed=w/7;
    ctx.font='600 '+font+'px Arial, sans-serif';
    const laneEnds=Array(rows).fill(-Infinity),fixedEnds=Array(rows).fill(-Infinity);layout=[];
    const all=[...segments.values()].flat().sort((a,b)=>a.time-b.time);
    for(const c of all){
      const width=Math.min(w,ctx.measureText(c.text).width);let lane=-1;
      if(c.mode===1){for(let i=1;i<rows-1;i++)if(laneEnds[i]<=c.time){lane=i;break;}if(lane<0)continue;laneEnds[lane]=c.time+(width+24)/speed;}
      else{lane=c.mode===5?0:rows-1;if(fixedEnds[lane]>c.time)continue;fixedEnds[lane]=c.time+4;}
      layout.push({...c,width,y:font+(h-font*1.2)*lane/rows,duration:c.mode===1?(w+width)/speed:4});
    }
    return {font,speed};
  }
  let metrics={font:20,speed:100};
  function draw(){
    if(!ctx)return;
    const w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(2,window.devicePixelRatio||1);
    if(!w||!h)return;
    const key=[w,h,dpr,density,[...segments.entries()].map(([k,v])=>k+':'+v.length).join(',')].join('|');
    if(key!==layoutKey){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);metrics=buildLayout(w,h);layoutKey=key;}
    ctx.clearRect(0,0,w,h);if(!enabled||!episode||!setting?.source)return;
    const time=video.currentTime-setting.offset;
    let lo=0,hi=layout.length;while(lo<hi){const mid=(lo+hi)>>1;if(layout[mid].time<time-15)lo=mid+1;else hi=mid;}
    ctx.font='600 '+metrics.font+'px Arial, sans-serif';ctx.lineWidth=3;ctx.strokeStyle='#000000';ctx.globalAlpha=.85;
    for(let i=lo;i<layout.length;i++){const c=layout[i],age=time-c.time;if(age<0)break;if(age>c.duration)continue;const x=c.mode===1?w-age*metrics.speed:(w-c.width)/2;ctx.fillStyle=c.color;ctx.strokeText(c.text,x,c.y,w);ctx.fillText(c.text,x,c.y,w);}
    ctx.globalAlpha=1;
  }
  function animate(){raf=0;draw();if(enabled&&episode&&!video.paused&&!video.ended&&!document.hidden)raf=requestAnimationFrame(animate);}
  function kick(){if(!raf&&enabled&&episode&&!video.paused&&!document.hidden)raf=requestAnimationFrame(animate);else draw();}
  function toggleUI(){$('danmaku-toggle').textContent=enabled?'彈幕：開':'彈幕：關';$('danmaku-toggle').setAttribute('aria-pressed',String(enabled));}
  $('danmaku-toggle').addEventListener('click',()=>{enabled=!enabled;try{localStorage.setItem('anime1-danmaku-enabled',String(enabled));}catch{}toggleUI();if(enabled){ensureSegments();kick();}else{cancelAnimationFrame(raf);raf=0;clearCanvas();status('彈幕已關閉');}});
  $('danmaku-density').addEventListener('change',()=>{density=Number($('danmaku-density').value);try{localStorage.setItem('anime1-danmaku-density',String(density));}catch{}layoutKey='';draw();});
  $('danmaku-config').addEventListener('click',()=>{searchEpoch++;$('danmaku-settings').hidden=!$('danmaku-settings').hidden;$('danmaku-config').setAttribute('aria-expanded',String(!$('danmaku-settings').hidden));if(!$('danmaku-settings').hidden)$('danmaku-query').focus();});
  $('danmaku-search-form').addEventListener('submit',e=>{e.preventDefault();void search();});
  $('danmaku-offset-form').addEventListener('submit',e=>{e.preventDefault();const offset=Number($('danmaku-offset').value);if(Number.isFinite(offset)&&Math.abs(offset)<=300)void saveSource(setting?.source||null,offset);});
  $('danmaku-clear').addEventListener('click',()=>void saveSource(null,0));
  $('danmaku-retry').addEventListener('click',()=>{failed.clear();$('danmaku-retry').hidden=true;if(setting?.source)ensureSegments();else void refreshSetting();});
  video.addEventListener('playing',()=>{ensureSegments();kick();});
  video.addEventListener('timeupdate',()=>{ensureSegments();if(!raf)draw();});
  for(const event of ['pause','seeked','loadedmetadata','ratechange'])video.addEventListener(event,()=>{ensureSegments();kick();});
  window.addEventListener('resize',()=>{layoutKey='';draw();});
  window.addEventListener('focus',()=>void refreshSetting());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){void refreshSetting();kick();}});
  setInterval(()=>{if(!document.hidden)void refreshSetting();},30000);
  toggleUI();window.TVDanmaku={open,stop};
})();
