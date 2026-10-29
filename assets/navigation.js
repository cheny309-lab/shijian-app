/* 页面导航与手势：不触碰数据；各页各自记住阅读位置。 */
(function(root){'use strict';const order=['timeline','bills','mine'],ids={timeline:'timelineContainer',bills:'billsPage',mine:'minePage'};
 root.ShijianNavigation={create({getPage,setPage,blocked}){
  const positions={};let start=null;
  function capture(){for(const [p,id]of Object.entries(ids)){const e=document.getElementById(id);if(e&&!e.hidden)positions[p]=e.scrollTop;}}
  function restore(page){const e=document.getElementById(ids[page]);if(e)e.scrollTop=positions[page]||0;}
  function go(page){if(!order.includes(page)||page===getPage()||blocked())return;capture();setPage(page);restore(page);}
  function skip(e){return !!e.target.closest('img,button,a,input,textarea,select,summary,[contenteditable="true"],.trajectory-photo')||!!window.getSelection()?.toString();}
  function begin(e){start=null;if(blocked()||e.touches.length!==1||skip(e))return;const t=e.touches[0];if(t.clientX<24||t.clientX>innerWidth-24)return;start={x:t.clientX,y:t.clientY,at:Date.now(),page:getPage(),id:t.identifier};}
  function move(e){if(!start)return;if(e.touches.length!==1){start=null;return;}const t=e.touches[0];if(Math.abs(t.clientY-start.y)>45)start=null;}
  function end(e){const s=start;start=null;if(!s||blocked()||s.page!==getPage()||skip(e)||Date.now()-s.at>650)return;const t=Array.from(e.changedTouches).find(t=>t.identifier===s.id);if(!t)return;const dx=t.clientX-s.x,dy=t.clientY-s.y;if(Math.abs(dx)<72||Math.abs(dy)>45||Math.abs(dx)<1.8*Math.abs(dy))return;go(order[order.indexOf(s.page)+(dx<0?1:-1)]);}
  function mount(){for(const id of Object.values(ids)){const e=document.getElementById(id);e.addEventListener('scroll',capture,{passive:true});e.addEventListener('touchstart',begin,{passive:true});e.addEventListener('touchmove',move,{passive:true});e.addEventListener('touchend',end,{passive:true});e.addEventListener('touchcancel',()=>{start=null;},{passive:true});}}
  return {capture,restore,go,mount};
 }};
})(typeof globalThis!=='undefined'?globalThis:this);
