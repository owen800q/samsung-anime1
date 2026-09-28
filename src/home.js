(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const S=window.TVState;
  const formats={tv:'TV 動畫',movie:'劇場版',web:'網絡動畫',ova:'OVA / 特別篇',unknown:'動畫'};
  let generation=0,request=null,nextPage=null,state='',sort='',activePreset='all',selected=null,returnFocus=null;
  const items=new Map(),details=new Map(),cards=new Map();
  let commentsRequest=null,commentsGeneration=0,commentsPage=1,commentsNext=null;
  function resetComments(){
    commentsGeneration++;commentsRequest?.abort();commentsRequest=null;commentsPage=1;commentsNext=null;
    $('comments-list').replaceChildren();$('comments-status').textContent='';$('comments-page').textContent='';
    $('comments-prev').disabled=true;$('comments-next').disabled=true;$('comments-retry').hidden=true;
    $('comments-source').hidden=true;$('comments-source').removeAttribute('href');
    $('comments-pagination').hidden=true;$('detail-comments').setAttribute('aria-busy','false');
  }
  async function loadComments(page=1){
    if(selected==null)return;
    commentsRequest?.abort();const controller=new AbortController();commentsRequest=controller;
    const id=++commentsGeneration,animeId=selected;
    const focused=document.activeElement,moveFocus=$('detail-comments').contains(focused);
    $('detail-comments').setAttribute('aria-busy','true');$('comments-status').textContent='正在讀取 Bangumi 評論…';
    $('comments-retry').hidden=true;$('comments-prev').disabled=true;$('comments-next').disabled=true;
    try{
      const data=await json('/api/comments?id='+animeId+'&page='+page,controller.signal);
      if(id!==commentsGeneration||selected!==animeId)return;
      const rows=data.comments.map(comment=>{
        const row=document.createElement('article');row.className='bangumi-comment';
        const meta=document.createElement('div');meta.className='comment-meta';
        const author=document.createElement('strong');author.textContent=comment.author;meta.append(author);
        if(comment.rating!=null){const rating=document.createElement('span');rating.className='comment-rating';rating.textContent='★ '+comment.rating+' / 10';meta.append(rating);}
        if(comment.updatedAt){const date=new Date(comment.updatedAt*1000),time=document.createElement('time');time.dateTime=date.toISOString();time.textContent=date.toLocaleDateString('zh-HK');meta.append(time);}
        const body=document.createElement('p');body.textContent=comment.text;row.append(meta,body);return row;
      });
      $('comments-list').replaceChildren(...rows);commentsPage=page;commentsNext=data.nextPage;
      $('comments-status').textContent=!data.matched?'這套動畫尚未配對 Bangumi，暫未能顯示評論。':data.total===0?'暫時未有 Bangumi 短評。':rows.length?'共 '+data.total+' 則短評 · 最新在前':'這一頁暫未有可顯示的短評。';
      $('comments-page').textContent='第 '+page+' 頁';$('comments-pagination').hidden=page===1&&!commentsNext;
      $('comments-prev').disabled=page<=1;$('comments-next').disabled=!commentsNext;
      if(moveFocus&&(document.activeElement===focused||document.activeElement===document.body)){$('comments-status').focus();$('comments-status').scrollIntoView({block:'nearest'});}
    }catch(e){
      if(controller.signal.aborted||id!==commentsGeneration)return;
      $('comments-status').textContent='Bangumi 評論暫時無法讀取。'+($('comments-list').children.length?' 仍顯示第 '+commentsPage+' 頁。':'');
      $('comments-retry').hidden=false;$('comments-retry').dataset.page=String(page);
      $('comments-prev').disabled=commentsPage<=1;$('comments-next').disabled=!commentsNext;
      if(moveFocus&&(document.activeElement===focused||document.activeElement===document.body))$('comments-retry').focus();
    }finally{if(id===commentsGeneration)$('detail-comments').setAttribute('aria-busy','false');}
  }
  async function json(url,signal){const r=await fetch(url,{signal});if(!r.headers.get('content-type')?.includes('application/json'))throw new Error('動畫資料暫時無法讀取。');const data=await r.json();if(!r.ok)throw new Error(data.error||'動畫資料暫時無法讀取。');return data;}
  function filters(page){const p=new URLSearchParams({page,state,sort});for(const key of ['q','year','season','format','genre']){const value=$('catalog-'+key).value;if(value)p.set(key,value);}return p;}
  function options(id,values){const el=$(id),value=el.value;const first=el.firstElementChild.cloneNode(true);el.replaceChildren(first);values.forEach(v=>{const option=document.createElement('option');option.value=v;option.textContent=v;el.append(option);});el.value=value;}
  function applyDetail(item,data){
    if(selected!==item.id)return;
    $('detail-summary').textContent=data?.summary||'暫未有簡介，仍然可以從下方選集播放。';
    $('detail-rating').textContent=data?.score?'Bangumi '+Number(data.score).toFixed(1)+' / 10 · '+data.ratingCount+' 人評分'+(data.rank?' · 排名 #'+data.rank:''):'';
    $('detail-tags').replaceChildren();(data?.tags||[]).forEach(tag=>{const chip=document.createElement('span');chip.textContent=tag;$('detail-tags').append(chip);});
    $('detail-bangumi').hidden=!data?.bangumiUrl;if(data?.bangumiUrl)$('detail-bangumi').href=data.bangumiUrl;
  }
  function updateCard(item,data){details.set(item.id,data);const card=cards.get(item.id);if(card)card.querySelector('.card-score').textContent=data?.score?'★ '+Number(data.score).toFixed(1)+(data.rank?' · #'+data.rank:''):'';applyDetail(item,data);}
  function openAnime(item,updateRoute=true){
    if(updateRoute){const p=S.route();p.set('view','anime');p.set('id',item.id);p.delete('episode');S.navigate(p);}

    selected=item.id;returnFocus=cards.get(item.id);
    resetComments();
    if(item.bgmId){$('comments-source').href='https://bgm.tv/subject/'+item.bgmId+'/comments';$('comments-source').hidden=false;void loadComments();}
    else $('comments-status').textContent='這套動畫尚未配對 Bangumi，暫未能顯示評論。';
    $('home-browser').hidden=true;$('watch-player').hidden=true;$('home-detail').hidden=false;$('home-back').hidden=false;
    $('detail-title').textContent=item.title;$('detail-facts').textContent=[item.year,item.season?item.season+'季':'',formats[item.format]||'動畫',item.episodes].filter(Boolean).join(' · ');
    $('detail-episodes').disabled=true;$('detail-cover').hidden=!item.bgmId;$('detail-cover').removeAttribute('src');if(item.bgmId)$('detail-cover').src='/api/cover?id='+item.id;
    applyDetail(item,details.get(item.id));$('home-back').focus();window.scrollTo(0,0);
    document.dispatchEvent(new CustomEvent('anime1:open-series',{detail:{id:item.id,title:item.title}}));
    reminder();void S.refresh();
    if(!item.bgmId)void json('/api/catalog-item?id='+item.id+'&match=1').then(async data=>{
      if(selected!==item.id||!data.item.bgmId)return;
      Object.assign(item,data.item);
      $('comments-source').href='https://bgm.tv/subject/'+item.bgmId+'/comments';$('comments-source').hidden=false;void loadComments();
      const result=await json('/api/metadata?ids='+item.id);
      if(selected!==item.id)return;
      updateCard(item,result.details[item.id]);
      $('detail-cover').hidden=false;$('detail-cover').src='/api/cover?id='+item.id;
    }).catch(()=>{});

    if(item.bgmId&&!details.has(item.id))void json('/api/metadata?ids='+item.id).then(data=>updateCard(item,data.details[item.id])).catch(()=>{});
  }
  function card(item){
    const button=document.createElement('button');button.className='anime-card';button.setAttribute('aria-label',item.title+'，'+item.episodes);button.dataset.id=item.id;
    const poster=document.createElement('div');poster.className='anime-poster';const placeholder=document.createElement('div');placeholder.className='poster-placeholder';placeholder.setAttribute('aria-hidden','true');
    const small=document.createElement('small');small.textContent='ANIME COLLECTION';const name=document.createElement('strong');name.textContent=item.title;placeholder.append(small,name);poster.append(placeholder);
    if(item.bgmId){const img=document.createElement('img');img.alt='';img.loading='lazy';img.decoding='async';img.src='/api/cover?id='+item.id;img.addEventListener('error',()=>{img.hidden=true;});poster.append(img);}
    const badge=document.createElement('span');badge.className='poster-badge';badge.textContent=item.episodes;poster.append(badge);
    const body=document.createElement('div');body.className='anime-card-body';const title=document.createElement('span');title.className='anime-card-title';title.textContent=item.title;
    const meta=document.createElement('div');meta.className='anime-card-meta';const text=document.createElement('span');text.textContent=[item.year,item.season?item.season+'季':''].filter(Boolean).join(' · ');const rating=document.createElement('span');rating.className='card-score';meta.append(text,rating);body.append(title,meta);button.append(poster,body);
    button.addEventListener('click',()=>openAnime(item));cards.set(item.id,button);items.set(item.id,item);return button;
  }
  async function hydrate(list,id,signal){
    const missing=list.filter(item=>item.bgmId&&!details.has(item.id));
    for(let i=0;i<missing.length;i+=8){if(id!==generation)return;try{const data=await json('/api/metadata?ids='+missing.slice(i,i+8).map(x=>x.id).join(','),signal);if(id!==generation)return;missing.slice(i,i+8).forEach(item=>updateCard(item,data.details[item.id]));}catch{if(signal.aborted)return;}}
  }
  async function load(page=1,updateRoute=true){
    const isHistory=activePreset==='history';
    $('watch-history').hidden=!isHistory;$('catalog-grid').hidden=isHistory;$('catalog-form').hidden=isHistory;
    if(updateRoute){const p=filters(page);p.set('view','home');p.set('preset',activePreset);S.navigate(p);}
    if(isHistory){request?.abort();generation++;$('catalog-more').hidden=true;$('catalog-error').hidden=true;$('catalog-retry').hidden=true;$('catalog-notice').hidden=true;renderHistory();void S.refresh();return;}

    request?.abort();request=new AbortController();const signal=request.signal,id=++generation;
    if(page===1){items.clear();cards.clear();$('catalog-grid').replaceChildren();}
    $('catalog-status').textContent='正在讀取動畫目錄…';$('catalog-error').hidden=true;$('catalog-retry').hidden=true;$('catalog-more').hidden=true;
    try{
      const data=await json('/api/catalog?'+filters(page),signal);if(id!==generation)return;
      options('catalog-year',data.years);options('catalog-genre',data.genres);
      const added=[];data.items.forEach(item=>{if(items.has(item.id))return;$('catalog-grid').append(card(item));added.push(item);if(item.metadata)updateCard(item,item.metadata);else if(details.has(item.id))updateCard(item,details.get(item.id));});
      nextPage=data.nextPage;$('catalog-more').hidden=!nextPage;
      $('catalog-status').textContent=items.size?(data.total==null?'已找到 '+items.size+' 套 · 依 Bangumi '+(data.sort==='rank'?'排名':'熱度')+'排序':'共 '+data.total+' 套 · 已顯示 '+items.size+' 套'):(nextPage?'這頁暫未配對到片源，可以按「更多動畫」繼續搵。':'未找到符合條件的動畫，試下其他分類。');
      const notes=[];if(data.stale)notes.push('Anime1 目錄暫時未能更新，現顯示已儲存的目錄。');if(data.total==null)notes.push((data.genre?'題材分類':'排行榜')+'只顯示已配對 Bangumi 資料、且 Anime1 有收錄的動畫。');
      $('catalog-notice').textContent=notes.join(' ');$('catalog-notice').hidden=!notes.length;
      void hydrate(added,id,signal);
    }catch(e){if(signal.aborted||id!==generation)return;$('catalog-status').textContent='未能載入目錄';$('catalog-error').textContent=e.message;$('catalog-error').hidden=false;$('catalog-retry').hidden=false;nextPage=page;}
  }
  function pressed(){document.querySelectorAll('[data-preset]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.preset===activePreset)));}
  function reset(){for(const key of ['q','year','season','format','genre'])$('catalog-'+key).value='';state='';sort='';activePreset='all';pressed();}
  document.querySelectorAll('[data-preset]').forEach(button=>button.addEventListener('click',()=>{reset();activePreset=button.dataset.preset;if(activePreset==='airing'||activePreset==='complete')state=activePreset;if(activePreset==='ranking')sort='rank';if(activePreset==='movie')$('catalog-format').value='movie';if(activePreset==='season'){const now=new Date();const year=String(now.getFullYear());if(![...$('catalog-year').options].some(o=>o.value===year)){const o=document.createElement('option');o.value=year;o.textContent=year;$('catalog-year').append(o);}$('catalog-year').value=year;$('catalog-season').value=['冬','春','夏','秋'][Math.floor(now.getMonth()/3)];}pressed();void load();}));
  $('catalog-form').addEventListener('submit',e=>{e.preventDefault();const q=$('catalog-q').value.trim();if(q){reset();$('catalog-q').value=q;}void load();});
  for(const key of ['year','season','format','genre'])$('catalog-'+key).addEventListener('change',()=>{activePreset=sort==='rank'?'ranking':state||'all';pressed();void load();});
  $('catalog-clear').addEventListener('click',()=>{reset();void load();});$('catalog-retry').addEventListener('click',()=>void load(nextPage||1));$('catalog-more').addEventListener('click',()=>{if(nextPage)void load(nextPage);});
  $('detail-cover').addEventListener('error',()=>{$('detail-cover').hidden=true;});
  $('comments-prev').addEventListener('click',()=>{if(commentsPage>1)void loadComments(commentsPage-1);});
  $('comments-next').addEventListener('click',()=>{if(commentsNext)void loadComments(commentsNext);});
  $('comments-retry').addEventListener('click',()=>void loadComments(Number($('comments-retry').dataset.page)||1));
  $('detail-episodes').addEventListener('click',()=>document.querySelector('.episode-button:not(:disabled)')?.focus());
  document.addEventListener('anime1:episodes-ready',()=>{$('detail-episodes').disabled=false;});
  function reminder(){
    const last=selected?S.latest(selected):null;
    $('detail-history').textContent=last?'上次觀看：'+last.title+' · '+(last.completed?'已看完':'看到 '+S.time(last.position)):'尚未有觀看紀錄';
  }
  function renderHistory(){
    const rows=S.all();$('watch-history').replaceChildren();$('catalog-status').textContent=rows.length?'共 '+rows.length+' 項觀看紀錄':'未有觀看紀錄。播放動畫後會自動儲存；其他裝置可用「裝置同步」連接。';
    for(const entry of rows){
      const row=document.createElement('article');row.className='history-row';
      const title=document.createElement('h3');title.textContent=entry.title;
      const meta=document.createElement('p');meta.textContent=(entry.completed?'已看完':'看到 '+S.time(entry.position)+' / '+S.time(entry.duration))+' · '+new Date(entry.updatedAt).toLocaleString('zh-HK');
      const bar=document.createElement('progress');bar.max=entry.duration;bar.value=entry.position;bar.setAttribute('aria-label','觀看進度');
      const play=document.createElement('button');play.className='tv-button';play.textContent=entry.completed?'重新觀看':'繼續觀看';play.addEventListener('click',()=>document.dispatchEvent(new CustomEvent('anime1:watch',{detail:entry})));
      row.append(title,meta,bar,play);$('watch-history').append(row);
    }
  }
  document.addEventListener('anime1:history-updated',()=>{reminder();if(activePreset==='history')renderHistory();});
  let routeGeneration=0;
  async function restoreRoute(){
    const id=++routeGeneration,p=S.route();
    if(p.get('view')==='search'){p.set('view','home');p.set('q',p.get('eq')||'');p.delete('eq');p.delete('page');p.set('preset','all');S.navigate(p,true);}
    const view=p.get('view')||'home';
    resetComments();
    if(view==='watch')return;
    document.dispatchEvent(new CustomEvent('anime1:home'));
    $('watch-player').hidden=true;$('home-detail').hidden=true;$('home-browser').hidden=false;$('home-back').hidden=true;selected=null;
    state=p.get('state')||'';sort=p.get('sort')||'';activePreset=p.get('preset')||'all';pressed();
    for(const key of ['q','year','season','format','genre']){
      const el=$('catalog-'+key),value=p.get(key)||'';
      if(el.tagName==='SELECT'&&value&&![...el.options].some(o=>o.value===value)){const o=document.createElement('option');o.value=value;o.textContent=value;el.append(o);}el.value=value;
    }
    if(view==='anime'&&/^\d{1,10}$/.test(p.get('id')||'')){
      $('home-browser').hidden=true;$('home-detail').hidden=false;$('home-back').hidden=false;$('detail-title').textContent='正在讀取動畫…';$('detail-history').textContent='';
      window.scrollTo(0,0);
      try{const data=await json('/api/catalog-item?id='+p.get('id'));if(id!==routeGeneration||S.route().get('view')!=='anime'||S.route().get('id')!==p.get('id'))return;openAnime(data.item,false);}
      catch(e){if(id===routeGeneration)$('detail-title').textContent=e.message;}
      return;
    }
    items.clear();cards.clear();$('catalog-grid').replaceChildren();
    void load(Math.max(1,Math.min(100,Number(p.get('page'))||1)),false);
  }
  $('home-back').addEventListener('click',()=>{const p=S.route();p.set('view','home');for(const key of ['id','episode','series','eq'])p.delete(key);S.navigate(p);void restoreRoute();});
  document.addEventListener('anime1:route',()=>void restoreRoute());
  document.dispatchEvent(new CustomEvent('anime1:route'));
})();

