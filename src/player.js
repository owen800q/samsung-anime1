(() => {
  'use strict';
  const screen=document.getElementById('screen');
  const canvas=document.getElementById('danmaku-canvas'),empty=document.getElementById('empty');
  // Keep source matching, offsets, deduplication and filtering in TVDanmaku.
  // DPlayer owns playback controls; the existing canvas lives in its container.
  const player=new DPlayer({container:screen,video:{url:'',type:'normal'},autoplay:false,
    theme:'#98f2d1',lang:'zh-tw',hotkey:false,volume:1,mutex:false,preload:'metadata'});
  const video=player.video;
  video.id='video';video.tabIndex=0;video.setAttribute('aria-label','動畫播放器');
  video.setAttribute('playsinline','');video.setAttribute('webkit-playsinline','');
  video.removeAttribute('src');
  screen.append(canvas,empty);
  const button=document.getElementById('fullscreen');
  const exit=document.createElement('button');exit.className='player-exit';
  exit.textContent='退出全螢幕';exit.hidden=true;screen.append(exit);
  let expanded=false,pending=false,version=0,returnFocus=null,scroll=null;
  const nativeElement=()=>document.fullscreenElement||document.webkitFullscreenElement;
  const redraw=()=>{player.resize();window.dispatchEvent(new Event('resize'));};
  function update(){
    const active=expanded||nativeElement()===screen;
    exit.hidden=!active;button.textContent=active?'退出全螢幕':'全螢幕';
    button.setAttribute('aria-pressed',String(active));redraw();
  }
  function restore(){
    if(scroll){window.scrollTo(scroll.x,scroll.y);scroll=null;}
    if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
    returnFocus=null;
  }
  function web(){
    expanded=true;screen.classList.add('dplayer-fulled');
    document.body.classList.add('dplayer-web-fullscreen-fix');update();exit.focus({preventScroll:true});
  }
  async function leave(){
    version++;pending=false;expanded=false;screen.classList.remove('dplayer-fulled');
    document.body.classList.remove('dplayer-web-fullscreen-fix');
    if(nativeElement()===screen){
      const cancel=document.exitFullscreen||document.webkitExitFullscreen;
      try{await cancel?.call(document);}catch{/* Keep the exit control available if the browser refuses. */}
    }
    update();if(nativeElement()!==screen)restore();
  }
  async function enter(type='browser'){
    if(expanded||nativeElement()===screen||pending)return;
    returnFocus=document.activeElement;scroll={x:window.scrollX,y:window.scrollY};
    const id=++version;pending=true;
    const request=screen.requestFullscreen||screen.webkitRequestFullscreen;
    if(type==='web'||!request){pending=false;web();return;}
    try{
      await request.call(screen);
      if(id!==version){if(nativeElement()===screen)await leave();return;}
      pending=false;
      if(nativeElement()===screen){update();exit.focus({preventScroll:true});}
      else web();
    }catch{if(id===version){pending=false;web();}}
  }
  function toggle(type){return expanded||nativeElement()===screen||pending?leave():enter(type);}
  // Override both DPlayer icons, including its iOS video-only fullscreen fallback.
  player.fullScreen.request=enter;player.fullScreen.cancel=leave;player.fullScreen.toggle=toggle;
  button.addEventListener('click',()=>void toggle());exit.addEventListener('click',()=>void leave());
  function changed(){update();if(!nativeElement()&&!expanded&&!pending)restore();}
  document.addEventListener('fullscreenchange',changed);
  document.addEventListener('webkitfullscreenchange',changed);
  document.addEventListener('keydown',e=>{
    if((expanded||nativeElement()===screen||pending)&&(e.key==='Escape'||e.key==='BrowserBack'||e.keyCode===10009)){
      e.preventDefault();e.stopImmediatePropagation();void leave();
    }
  },true);
  screen.addEventListener('focusin',()=>player.controller.show());
  const labels={'.dplayer-play-icon':'播放／暫停','.dplayer-mobile-play':'播放／暫停',
    '.dplayer-volume-icon':'靜音／開啟聲音','.dplayer-setting-icon':'播放設定',
    '.dplayer-full-icon':'播放器全螢幕','.dplayer-full-in-icon':'網頁全螢幕'};
  for(const [selector,label] of Object.entries(labels))screen.querySelector(selector)?.setAttribute('aria-label',label);
  window.TVPlayer={leave,contains:element=>screen.contains(element),isExpanded:()=>expanded||nativeElement()===screen};
})();
