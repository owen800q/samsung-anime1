(() => {
  'use strict';
  const $=id=>document.getElementById(id),video=$('video'),canvas=$('danmaku-canvas'),ctx=canvas.getContext('2d'),S=window.TVState;
  let episode=null,setting=null,epoch=0,controller=null,searchEpoch=0,searchController=null,saving=false;
  let segments=new Map(),pending=new Set(),failed=new Set(),layout=[],raf=0,layoutKey='',sourceEpoch=0;
  let enabled=true,density=8,filter='all',matchErrors=[],matching=false;
  const providerName=p=>({bahamut:'動畫瘋',bilibili:'Bilibili',dandanplay:'彈彈play（含關聯來源）'})[p]||p;
  const sources=()=>setting?.sources||(setting?.source?[{...setting.source,offset:setting.offset||0}]:[]);
  const sourceKey=src=>src.provider+':'+src.id;
  const visibleSource=src=>filter==='all'||filter===src.provider;
  try{density=Number(localStorage.getItem('gimy-danmaku-density'))||8;}catch{}
  if(![4,8,12].includes(density))density=8;
  $('danmaku-density').value=String(density);
  const status=text=>{$('danmaku-status').textContent=text;};
  const searchStatus=text=>{$('danmaku-search-status').textContent=text;};
  const currentSegment=src=>src.provider==='bilibili'?Math.max(1,Math.floor(Math.max(0,video.currentTime-(src.offset||0))/360)+1):1;
  const normal=s=>String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  // Bahamut's series/search title can include the currently selected episode.
  // Strip only numeric episode suffixes, not season numbers or special labels.
  const seriesName=s=>normal(String(s).normalize('NFKC').replace(/\s*\[\d+(?:\.\d+)?\]\s*$/,''));
  // Mirrors pickEpisodes in title-match.js: sources that keep counting across seasons (38, 39, …)
  // map catalogue episode n to the n-th of a gap-free run, only when no label matches directly.
  function pickEpisodes(episodes,n){
    // Prefer the main release when a source repeats episode numbers in other groups (dubs).
    if(episodes.some(x=>x.group==='0'))episodes=episodes.filter(x=>x.group===undefined||x.group==='0');
    const numbered=episodes.filter(x=>/^\d+(?:\.\d+)?$/.test(x.label));
    const exact=numbered.filter(x=>Number(x.label)===Number(n));
    if(exact.length||!Number.isInteger(Number(n))||Number(n)<1)return exact;
    const whole=numbered.filter(x=>Number.isInteger(Number(x.label))).sort((a,b)=>a.label-b.label);
    const consecutive=whole.length>0&&Number(whole[0].label)>1&&whole.every((x,i)=>Number(x.label)===Number(whole[0].label)+i);
    return consecutive&&whole[Number(n)-1]?[whole[Number(n)-1]]:[];
  }
  async function json(path,signal,timeout=15000){const r=await fetch(path,{signal:AbortSignal.any([signal,AbortSignal.timeout(timeout)])});const d=await r.json();if(!r.ok)throw new Error(d.error||'彈幕暫時無法讀取。');return d;}
  function settingsUI(){
    const list=sources(),src=list[0];
    $('danmaku-current').textContent=list.length?list.map(x=>providerName(x.provider)+' · '+x.title).join(' ／ '):'本集未配對彈幕';
    $('danmaku-source-link').hidden=true;if(src)$('danmaku-source-link').href=src.url;
    $('danmaku-source-list').replaceChildren();
    for(const x of list){const link=document.createElement('a');link.textContent=providerName(x.provider)+' · '+x.title+' ↗';link.href=x.provider==='dandanplay'?'https://www.dandanplay.com/':x.url;link.target='_blank';link.rel='noreferrer';link.className='source-link';$('danmaku-source-list').append(link);}
    $('danmaku-offset-source').replaceChildren();
    for(const x of list){const option=document.createElement('option');option.value=x.provider;option.textContent=providerName(x.provider);$('danmaku-offset-source').append(option);}
    $('danmaku-offset-source').value=src?.provider||'';$('danmaku-offset').value=String(src?.offset||0);
    for(const p of ['bahamut','bilibili','dandanplay'])$('danmaku-filter-'+p).hidden=!list.some(x=>x.provider===p);
    if(filter!=='all'&&!list.some(x=>x.provider===filter))filter='all';filterUI();
  }
  function filterUI(){for(const p of ['all','bahamut','bilibili','dandanplay'])$('danmaku-filter-'+p).setAttribute('aria-pressed',String(filter===p));}
  function clearCanvas(){if(ctx)ctx.clearRect(0,0,canvas.width,canvas.height);}
  function resetSource(){sourceEpoch++;segments.clear();pending.clear();failed.clear();layout=[];layoutKey='';clearCanvas();$('danmaku-retry').hidden=true;}
  function stop(){epoch++;episode=null;setting=null;controller?.abort();searchController?.abort();searchEpoch++;saving=false;matchErrors=[];matching=false;resetSource();cancelAnimationFrame(raf);raf=0;}
  async function loadSegment(src,index){
    const key=sourceKey(src)+':'+index;
    if(!enabled||pending.has(key)||segments.has(key)||failed.has(key)||index>240)return;
    pending.add(key);const e=epoch,g=sourceEpoch,signal=controller.signal;
    try{
      const data=await json('/api/danmaku/comments?provider='+src.provider+'&id='+encodeURIComponent(src.id)+'&segment='+index,signal);
      if(e!==epoch||g!==sourceEpoch)return;
      if(!Array.isArray(data.comments))throw new Error('彈幕資料不完整。');
      segments.set(key,{src,index,comments:data.comments});layoutKey='';
      for(const [k,v] of segments)if(v.src.provider==='bilibili'&&Math.abs(v.index-currentSegment(v.src))>1)segments.delete(k);
      loadedStatus();draw();
    }catch(error){if(e===epoch&&g===sourceEpoch&&!signal.aborted){failed.add(key);matchErrors=matchErrors.filter(x=>x.key!==key);matchErrors.push({key,text:providerName(src.provider)+'：'+(error.message||'讀取失敗')});loadedStatus();}}
    finally{if(e===epoch&&g===sourceEpoch){pending.delete(key);loadedStatus();}}
  }
  function ensureSegments(){
    if(!enabled||!episode)return;
    for(const src of sources()){
      const index=currentSegment(src);void loadSegment(src,index);
      if(src.provider==='bilibili'){
        const time=Math.max(0,video.currentTime-(src.offset||0));
        if(time%360<15&&index>1)void loadSegment(src,index-1);
        if(time%360>330&&(!Number.isFinite(video.duration)||video.currentTime+30<video.duration))void loadSegment(src,index+1);
      }
    }
  }
  function mergedComments(){
    const seen=new Set(),out=[];
    for(const {src,comments} of segments.values()){
      if(!visibleSource(src))continue;
      for(const c of comments){
        const time=c.time+(src.offset||0);
        const key=time.toFixed(2)+':'+c.mode+':'+c.text;
        if(seen.has(key))continue;seen.add(key);out.push({...c,time});
      }
    }
    return out.sort((a,b)=>a.time-b.time);
  }
  function loadedStatus(){
    if(!enabled){status('彈幕已關閉');return;}
    const count=mergedComments().length;
    const detail=sources().filter(visibleSource).map(src=>{
      const count=[...segments.values()].filter(x=>sourceKey(x.src)===sourceKey(src)).reduce((n,x)=>n+x.comments.length,0);
      return providerName(src.provider)+' '+count;
    }).join(' · ');
    status((count?'已載入 '+count+' 條彈幕':pending.size?'正在讀取本集彈幕…':sources().length?'本時段暫時未有彈幕':matching?'正在自動配對本集彈幕來源…':'本集未配對彈幕，未找到能確定對應本集的來源')+(detail?' · '+detail:'')+(matching&&sources().length?' · 正在配對其他來源…':'')+(matchErrors.length?'；'+matchErrors.map(x=>x.text).join('；'):''));
    $('danmaku-retry').hidden=!matchErrors.length&&!failed.size;
  }
  function startSource(){matchErrors=matchErrors.filter(x=>x.key.startsWith('match'));resetSource();settingsUI();if(!sources().length){status('本集未配對彈幕，會自動尋找對應來源。');return;}ensureSegments();loadedStatus();}
  async function refreshSetting(){
    if(!episode||saving)return;const e=epoch,revision=setting?.revision;
    try{
      const r=await S.danmakuSettings(episode.episodeId,null,AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]));const data=await r.json();
      if(e!==epoch||saving||setting?.revision!==revision)return;if(!r.ok)throw new Error(data.error||'彈幕設定同步失敗。');
      if(!setting||data.entry.revision!==setting.revision){setting=data.entry;startSource();}
    }catch(error){if(e===epoch&&!controller.signal.aborted){status(error.message||'彈幕設定同步失敗，請重試。');$('danmaku-retry').hidden=false;}}
  }
  async function saveSource(source,offset=0,complete=null){
    const list=complete||(!source?[]:[...sources().filter(x=>x.provider!==source.provider),{...source,offset}]);
    searchEpoch++;
    if(!episode||saving)return false;const e=epoch;const id=episode.episodeId;saving=true;status('正在儲存本集彈幕設定…');
    try{
      const r=await S.danmakuSettings(id,{episodeId:id,source:list[0]||null,sources:list,offset:list[0]?.offset||0,revision:setting?.revision||0},AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]));const data=await r.json();
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
    searchStatus('正在搜尋彈幕來源…');$('danmaku-results').replaceChildren();
    try{
      const availability=await json('/api/danmaku/providers',signal);
      const providers=['bahamut',...(availability.dandanplay?['dandanplay']:[])];
      const results=await Promise.allSettled(providers.map(provider=>json('/api/danmaku/search?q='+encodeURIComponent(q)+'&provider='+provider,signal)));
      if(e!==epoch||g!==searchEpoch)return;
      const items=results.flatMap(r=>r.status==='fulfilled'?r.value.results:[]);
      const errors=results.flatMap((r,i)=>r.status==='rejected'?[providerName(providers[i])+': '+r.reason.message]:[]);
      searchStatus((items.length?'選擇動畫，再加入對應集數':'未找到來源，試下別名或貼完整來源網址。')+(errors.length?'；'+errors.join('；'):''));
      for(const item of items)resultButton(providerName(item.provider)+' · '+item.title,()=>showEpisodes(item.url));
      $('danmaku-results').querySelector('button')?.focus();
    }catch(error){if(e===epoch&&g===searchEpoch&&!signal.aborted)searchStatus(error.message||'搜尋失敗。');}
  }
  // Gimy does not expose the Anime1/Bangumi catalogue identity. Auto-match only
  // an unambiguous exact series name and explicit episode number, preserving manual mappings.
  async function autoMatch(info,e,g){
    const n=info.title.match(/\[(\d+(?:\.\d+)?)\]\s*$/)?.[1]||info.title.match(/第\s*(\d+)\s*集/)?.[1];
    if(!n||!info.seriesTitle||matching||sources().length)return;
    const signal=controller.signal;matching=true;
    try{
      const availability=await json('/api/danmaku/providers',signal);
      const providers=availability.dandanplay?['bahamut','dandanplay']:['bahamut'];
      const results=await Promise.allSettled(providers.map(async provider=>{
        const found=await json('/api/danmaku/search?q='+encodeURIComponent(info.seriesTitle)+'&provider='+provider,signal);
        const exact=found.results.filter(x=>seriesName(x.title)===seriesName(info.seriesTitle));
        if(exact.length!==1)return null;
        const detail=await json('/api/danmaku/resolve?url='+encodeURIComponent(exact[0].url),signal);
        if(seriesName(detail.title)!==seriesName(info.seriesTitle))return null;
        const eps=pickEpisodes(detail.episodes,n);return eps.length===1?{...eps[0],offset:0}:null;
      }));
      if(e!==epoch||g!==searchEpoch||signal.aborted||sources().length)return;
      const matches=results.flatMap(r=>r.status==='fulfilled'&&r.value?[r.value]:[]);
      if(matches.length)await saveSource(null,0,matches);
      else status('未找到能確定對應本集的彈幕來源；可手動搜尋，影片仍可播放。');
    }catch(error){if(e===epoch&&!signal.aborted)status('彈幕自動配對暫時未能使用；可手動選擇來源。');}
    finally{if(e===epoch)matching=false;}
  }
  async function open(info){
    stop();filter='all';enabled=true;toggleUI();episode=info;controller=new AbortController();const e=epoch;
    $('danmaku-settings').hidden=true;$('danmaku-config').setAttribute('aria-expanded','false');$('danmaku-results').replaceChildren();searchStatus('');
    $('danmaku-query').value=info.seriesTitle||info.title;status('正在讀取本集彈幕設定…');settingsUI();
    await refreshSetting();if(e!==epoch)return;
    if(setting)void autoMatch(info,e,searchEpoch);
  }

  function buildLayout(w,h){
    const font=Math.max(16,Math.min(32,w/36)),rows=Math.max(3,Math.min(density,Math.floor(h/(font*1.45)))),speed=w/7;
    ctx.font='600 '+font+'px Arial, sans-serif';
    const laneEnds=Array(rows).fill(-Infinity),fixedEnds=Array(rows).fill(-Infinity);layout=[];
    const all=mergedComments();
    for(const c of all){
      const width=Math.min(w,ctx.measureText(c.text).width);let lane=-1;
      if(c.mode===1){for(let i=1;i<rows-1;i++)if(laneEnds[i]<=c.time){lane=i;break;}if(lane<0)continue;laneEnds[lane]=c.time+(width+24)/speed;}
      else{lane=c.mode===5?0:rows-1;if(fixedEnds[lane]>c.time)continue;fixedEnds[lane]=c.time+4;}
      layout.push({...c,width,y:font+(h-font*1.2)*lane/rows,duration:c.mode===1?(w+width)/speed:4});
    }
    return {font,speed};
  }
  let metrics={font:20,speed:100},sprites=new Map(),spriteKey='';
  // TV browsers report video.currentTime in coarse steps (often every 100-250ms), so reading it
  // directly makes scrolling comments jump. Advance a wall clock between reports and ease it
  // toward each new report, and never let it run backwards while playing.
  const now=()=>typeof performance!=='undefined'?performance.now():Date.now();
  let clockMedia=0,clockWall=0,reported=-1,shown=0;
  function syncClock(){clockMedia=reported=shown=video.currentTime;clockWall=now();}
  function playhead(){
    const current=video.currentTime;
    if(video.paused||video.ended||video.seeking||video.readyState<3){syncClock();return current;}
    const t=now(),rate=video.playbackRate||1,predicted=clockMedia+(t-clockWall)/1000*rate;
    if(current!==reported){
      reported=current;const drift=current-predicted;
      if(Math.abs(drift)>.5){clockMedia=shown=current;clockWall=t;return current;}
      clockMedia+=drift*.1;
    }
    return shown=Math.max(shown,clockMedia+(t-clockWall)/1000*rate);
  }
  // Rasterise each comment once; blitting a bitmap per frame is far cheaper than strokeText+fillText on TV CPUs.
  function sprite(c,dpr){
    const key=c.color+'|'+c.text;let s=sprites.get(key);if(s)return s;
    if(sprites.size>2000)sprites.clear();
    const font=metrics.font,pad=4,el=document.createElement('canvas'),g=el.getContext?.('2d');
    if(!g?.fillText)return null;
    const width=c.width+pad*2,height=Math.ceil(font*1.35)+pad*2;
    el.width=Math.ceil(width*dpr);el.height=Math.ceil(height*dpr);g.setTransform(dpr,0,0,dpr,0,0);
    g.font='600 '+font+'px Arial, sans-serif';g.lineWidth=3;g.lineJoin='round';g.strokeStyle='#000000';g.fillStyle=c.color;
    g.strokeText(c.text,pad,pad+font,c.width);g.fillText(c.text,pad,pad+font,c.width);
    s={el,pad,font,width,height};sprites.set(key,s);return s;
  }
  function draw(){
    if(!ctx)return;
    const w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(2,window.devicePixelRatio||1);
    if(!w||!h)return;
    const key=[w,h,dpr,density,filter,[...segments.entries()].map(([k,v])=>k+':'+v.comments.length).join(',')].join('|');
    if(key!==layoutKey){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);metrics=buildLayout(w,h);layoutKey=key;}
    if(spriteKey!==metrics.font+'|'+dpr){sprites.clear();spriteKey=metrics.font+'|'+dpr;}
    ctx.clearRect(0,0,w,h);if(!enabled||!episode||!sources().length)return;
    const time=playhead();
    let lo=0,hi=layout.length;while(lo<hi){const mid=(lo+hi)>>1;if(layout[mid].time<time-15)lo=mid+1;else hi=mid;}
    ctx.globalAlpha=.85;
    for(let i=lo;i<layout.length;i++){
      const c=layout[i],age=time-c.time;if(age<0)break;if(age>c.duration)continue;
      // Keep sub-pixel positions: rounding to whole pixels makes per-frame steps alternate (e.g. 2px/3px) and judder.
      const x=c.mode===1?w-age*metrics.speed:(w-c.width)/2,s=sprite(c,dpr);
      if(s)ctx.drawImage(s.el,x-s.pad,c.y-s.font-s.pad,s.width,s.height);
      else{ctx.font='600 '+metrics.font+'px Arial, sans-serif';ctx.lineWidth=3;ctx.strokeStyle='#000000';ctx.fillStyle=c.color;ctx.strokeText(c.text,x,c.y,w);ctx.fillText(c.text,x,c.y,w);}
    }
    ctx.globalAlpha=1;
  }
  function animate(){raf=0;draw();if(enabled&&episode&&!video.paused&&!video.ended&&!document.hidden)raf=requestAnimationFrame(animate);}
  function kick(){syncClock();if(!raf&&enabled&&episode&&!video.paused&&!document.hidden)raf=requestAnimationFrame(animate);else draw();}
  function toggleUI(){$('danmaku-toggle').textContent=enabled?'彈幕：開':'彈幕：關';$('danmaku-toggle').setAttribute('aria-pressed',String(enabled));}
  $('danmaku-toggle').addEventListener('click',()=>{enabled=!enabled;toggleUI();if(enabled){loadedStatus();ensureSegments();kick();}else{cancelAnimationFrame(raf);raf=0;clearCanvas();status('彈幕已關閉');}});
  $('danmaku-density').addEventListener('change',()=>{density=Number($('danmaku-density').value);try{localStorage.setItem('gimy-danmaku-density',String(density));}catch{}layoutKey='';draw();});
  $('danmaku-config').addEventListener('click',()=>{$('danmaku-settings').hidden=!$('danmaku-settings').hidden;$('danmaku-config').setAttribute('aria-expanded',String(!$('danmaku-settings').hidden));if(!$('danmaku-settings').hidden)$('danmaku-query').focus();});
  $('danmaku-search-form').addEventListener('submit',e=>{e.preventDefault();void search();});
  $('danmaku-offset-form').addEventListener('submit',e=>{e.preventDefault();const offset=Number($('danmaku-offset').value);if(Number.isFinite(offset)&&Math.abs(offset)<=300)void saveSource(null,0,sources().map(x=>x.provider===$('danmaku-offset-source').value?{...x,offset}:x));});
  $('danmaku-clear').addEventListener('click',()=>void saveSource(null,0));
  for(const provider of ['all','bahamut','bilibili','dandanplay'])$('danmaku-filter-'+provider).addEventListener('click',()=>{filter=provider;filterUI();layoutKey='';loadedStatus();draw();});
  $('danmaku-offset-source').addEventListener('change',()=>{$('danmaku-offset').value=String(sources().find(x=>x.provider===$('danmaku-offset-source').value)?.offset||0);});
  $('danmaku-retry').addEventListener('click',async()=>{failed.clear();matchErrors=[];$('danmaku-retry').hidden=true;const e=epoch;await refreshSetting();if(e!==epoch)return;ensureSegments();if(setting)void autoMatch(episode,e,searchEpoch);});
  video.addEventListener('playing',()=>{ensureSegments();kick();});
  video.addEventListener('timeupdate',()=>{ensureSegments();if(!raf)draw();});
  for(const event of ['pause','seeked','loadedmetadata','ratechange','waiting'])video.addEventListener(event,()=>{ensureSegments();kick();});
  window.addEventListener('resize',()=>{layoutKey='';draw();});
  window.addEventListener('focus',()=>void refreshSetting());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){void refreshSetting();kick();}});
  setInterval(()=>{if(!document.hidden)void refreshSetting();},30000);
  toggleUI();window.TVDanmaku={open,stop};
})();


