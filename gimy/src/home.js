(() => {
  'use strict';
  const $=id=>document.getElementById(id),S=window.TVState;
  let controller=null,generation=0,preset='all';
  const emit=(name,detail)=>document.dispatchEvent(new CustomEvent('gimy:'+name,{detail}));
  const canonical=value=>{const u=new URL(value);if(u.origin!=='https://gimytv.io'||u.username||u.password||u.search||u.hash||!/^\/eps\/\d{1,10}(?:-[a-zA-Z0-9_-]{1,100})?\.html$/.test(u.pathname))throw new Error('請貼上 gimytv.io/eps/ 開頭的單集網址。');return u.href;};
  function hidePlayback(){emit('home');$('watch-player').hidden=true;$('home-detail').hidden=true;$('home-browser').hidden=false;$('home-back').hidden=true;}
  function card(item){
    const button=document.createElement('button');button.className='anime-card';
    const body=document.createElement('div');body.className='anime-card-body';
    const title=document.createElement('strong');title.className='anime-card-title';title.textContent=item.title;
    const meta=document.createElement('span');meta.className='anime-card-meta';meta.textContent='查看集數';body.append(title,meta);button.append(body);
    button.addEventListener('click',()=>openSeries(item));return button;
  }
  function openSeries(item,route=true){
    if(route)S.navigate({view:'series',id:item.id,title:item.title,url:item.url,preset,q:$('catalog-q').value});
    $('home-browser').hidden=true;$('watch-player').hidden=true;$('home-detail').hidden=false;$('home-back').hidden=false;
    $('detail-title').textContent=item.title;$('detail-facts').textContent='';$('detail-cover').hidden=true;$('detail-comments').hidden=true;
    const last=S.latest(item.id);$('detail-history').textContent=last?'上次觀看：'+last.title+' · '+S.time(last.position):'尚未有觀看紀錄';
    $('detail-episodes').hidden=true;window.scrollTo(0,0);emit('open-series',item);
  }
  function historyRows(){
    const rows=S.all();$('watch-history').replaceChildren();$('catalog-status').textContent=rows.length?'共 '+rows.length+' 項觀看紀錄':'播放影片後會自動儲存進度。';
    for(const entry of rows){const row=document.createElement('article');row.className='history-row';const title=document.createElement('h3');title.textContent=entry.title;
      const meta=document.createElement('p');meta.textContent=(entry.completed?'已看完':'看到 '+S.time(entry.position)+' / '+S.time(entry.duration))+' · '+new Date(entry.updatedAt).toLocaleString('zh-HK');
      const progress=document.createElement('progress');progress.max=entry.duration;progress.value=entry.position;progress.setAttribute('aria-label','觀看進度');
      const play=document.createElement('button');play.className='tv-button';play.textContent=entry.completed?'重新觀看':'繼續觀看';play.addEventListener('click',()=>emit('watch',entry));row.append(title,meta,progress,play);$('watch-history').append(row);}
  }
  async function load(updateRoute=true){
    controller?.abort();controller=new AbortController();const signal=controller.signal,id=++generation;
    if(updateRoute)S.navigate({view:'home',preset,q:$('catalog-q').value});
    hidePlayback();const isHistory=preset==='history';$('watch-history').hidden=!isHistory;$('catalog-grid').hidden=isHistory;$('catalog-form').hidden=isHistory;
    document.querySelectorAll('[data-preset]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.preset===preset)));
    $('catalog-error').hidden=true;$('catalog-retry').hidden=true;$('catalog-more').hidden=true;$('catalog-notice').hidden=true;
    if(isHistory){historyRows();void S.refresh();return;}
    $('catalog-grid').replaceChildren();$('catalog-status').textContent='正在讀取 Gimy 目錄…';
    try{const r=await fetch('/api/catalog?q='+encodeURIComponent($('catalog-q').value.trim()),{signal});const data=await r.json();if(!r.ok)throw new Error(data.error||'目錄暫時未能讀取。');if(id!==generation)return;
      for(const item of data.items||[])$('catalog-grid').append(card(item));$('catalog-status').textContent=data.items?.length?'已讀取 '+data.items.length+' 部影片':'未找到影片，亦可貼上單集網址開啟。';
    }catch(e){if(signal.aborted||id!==generation)return;$('catalog-status').textContent='目錄暫時未能讀取';$('catalog-error').textContent=e.message;$('catalog-error').hidden=false;$('catalog-retry').hidden=false;}
  }
  $('open-form').addEventListener('submit',e=>{e.preventDefault();try{const url=canonical($('open-url').value.trim());$('open-error').hidden=true;emit('watch',{episodeId:url.match(/\/eps\/([^/]+)\.html$/)[1],seriesId:url.match(/\/eps\/(\d+)/)[1],seriesTitle:''});}catch(error){$('open-error').textContent=error.message;$('open-error').hidden=false;}});
  $('catalog-form').addEventListener('submit',e=>{e.preventDefault();preset='all';void load();});
  $('catalog-clear').addEventListener('click',()=>{$('catalog-q').value='';void load();});
  $('catalog-retry').addEventListener('click',()=>void load(false));
  document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>{preset=b.dataset.preset;void load();}));
  $('home-back').addEventListener('click',()=>void load());
  document.addEventListener('gimy:history-updated',()=>{if(preset==='history'&&!$('home-browser').hidden)historyRows();});
  function restore(){const p=S.route();if(p.has('pair')||p.get('view')==='watch')return;preset=p.get('preset')==='history'?'history':'all';$('catalog-q').value=p.get('q')||'';
    if(p.get('view')==='series'&&p.get('url')){try{const u=new URL(p.get('url'));if(u.origin!=='https://gimytv.io')throw 0;openSeries({id:p.get('id'),title:p.get('title')||'Gimy 影片',url:u.href},false);return;}catch{}}
    void load(false);
  }
  document.addEventListener('gimy:route',restore);
  if(S.route().get('view')==='watch')emit('route');else restore();
})();
