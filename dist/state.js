(() => {
  const $=id=>document.getElementById(id);
  const emit=(name,detail)=>document.dispatchEvent(new CustomEvent(name,{detail}));
  const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
  const write=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}};
  let token=read('anime1-profile',null);if(!/^[a-f0-9]{32}$/.test(token||'')){token=crypto.randomUUID().replaceAll('-','');write('anime1-profile',token);}
  let entries=read('anime1-history:'+token,{}),pulling=null,sending=null;
  const announce=()=>{write('anime1-history:'+token,entries);emit('anime1:history-updated');};
  const syncStatus=text=>{$('sync-status').textContent=text;};
  function send(){
    if(sending)return sending;const profile=token;
    sending=(async()=>{
      try{
        for(;;){
          const local=Object.values(entries).find(x=>x.dirty);if(!local||profile!==token)break;
          const stamp=local.localStamp;
          const response=await fetch('/api/history',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+profile},body:JSON.stringify(local),keepalive:true,signal:AbortSignal.timeout(8000)});
          const data=await response.json();if(profile!==token)return;
          if(!response.ok&&response.status!==409)throw new Error(data.error||'同步暫時無法使用');
          if(!data.entry)throw new Error('Missing progress');
          const current=entries[local.episodeId];
          if(response.status===409||current?.localStamp===stamp)entries[local.episodeId]={...data.entry,dirty:false};
          else if(current)current.revision=data.entry.revision;
          announce();
        }
        syncStatus('已同步至雲端');
      }catch{syncStatus('暫存於此裝置，連線恢復後再同步');}
    })().finally(()=>{sending=null;});return sending;
  }
  async function refresh(){
    if(pulling)return pulling;
    const profile=token;
    pulling=(async()=>{
      try{
        await send();
        const response=await fetch('/api/history',{headers:{Authorization:'Bearer '+profile},signal:AbortSignal.timeout(8000)});
        if(!response.ok)throw new Error('History unavailable');const data=await response.json();if(profile!==token)return;
        for(const remote of data.entries||[]){const local=entries[remote.episodeId];if(!local?.dirty&&(remote.revision>=(local?.revision||0)))entries[remote.episodeId]={...remote,dirty:false};}
        announce();syncStatus('已同步至雲端');
      }catch{syncStatus('暫存於此裝置，連線恢復後再同步');}
    })().finally(()=>{pulling=null;});return pulling;
  }
  function save(value){
    const id=String(value.episodeId);const previous=entries[id];
    entries[id]={...value,episodeId:id,revision:previous?.revision||0,updatedAt:Date.now(),localStamp:crypto.randomUUID(),dirty:true};
    const sorted=Object.values(entries).sort((a,b)=>b.updatedAt-a.updatedAt);entries=Object.fromEntries(sorted.slice(0,500).map(x=>[x.episodeId,x]));announce();void send();
  }
  function navigate(values,replace=false){const params=new URLSearchParams(values);const hash='#'+params;const same=location.hash===hash;if(!same)history[replace?'replaceState':'pushState'](null,'',hash);}
  const route=()=>new URLSearchParams(location.hash.slice(1));
  const time=value=>{const s=Math.max(0,Math.floor(value||0));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
  window.TVState={danmakuSettings:(id,data,signal)=>fetch('/api/danmaku/settings?episode='+encodeURIComponent(id),{method:data?'PUT':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined,signal}),route,navigate,time,save,refresh,all:()=>Object.values(entries).sort((a,b)=>b.updatedAt-a.updatedAt),get:id=>entries[String(id)],latest:seriesId=>Object.values(entries).filter(x=>String(x.seriesId)===String(seriesId)).sort((a,b)=>b.updatedAt-a.updatedAt)[0]};
  $('sync-code').value=token.match(/.{1,4}/g).join('-');
  $('sync-toggle').addEventListener('click',()=>{$('sync-panel').hidden=!$('sync-panel').hidden;if(!$('sync-panel').hidden)$('sync-code').focus();});
  $('sync-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('sync-code').value);syncStatus('同步碼已複製');}catch{$('sync-code').select();syncStatus('請複製上方同步碼');}});
  $('sync-form').addEventListener('submit',async e=>{
    e.preventDefault();const next=$('sync-input').value.replace(/[-\s]/g,'').toLowerCase();
    if(!/^[a-f0-9]{32}$/.test(next)){syncStatus('請輸入完整的 32 位同步碼');return;}
    emit('anime1:profile-changing');await send();token=next;write('anime1-profile',token);entries=read('anime1-history:'+token,{});pulling=null;$('sync-code').value=token.match(/.{1,4}/g).join('-');$('sync-input').value='';announce();await refresh();emit('anime1:profile-changed');
  });
  setInterval(()=>{if(!document.hidden)void refresh();},30000);
  window.addEventListener('online',()=>void refresh());
  window.addEventListener('focus',()=>void refresh());
  window.addEventListener('hashchange',()=>emit('anime1:route'));
  window.addEventListener('storage',e=>{if(e.key==='anime1-history:'+token){entries=read(e.key,{});emit('anime1:history-updated');}});
  void refresh();
})();
