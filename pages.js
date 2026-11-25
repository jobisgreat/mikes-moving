/* Small helpers for the static pages (menu, dropdown, copy email, quick-action bar). */
(function(){
  var $=function(s){return document.querySelector(s)};
  var menu=$('#menuBtn'), nav=$('#mainNav');
  if(menu&&nav) menu.addEventListener('click',function(){var o=nav.classList.toggle('open');menu.setAttribute('aria-expanded',o)});
  var dd=$('#resDD'), btn=$('#resBtn');
  if(dd&&btn){
    var set=function(o){dd.classList.toggle('open',o);btn.setAttribute('aria-expanded',o?'true':'false')};
    btn.addEventListener('click',function(e){e.stopPropagation();set(!dd.classList.contains('open'))});
    document.addEventListener('click',function(e){if(!dd.contains(e.target))set(false)});
    dd.addEventListener('keydown',function(e){if(e.key==='Escape'){set(false);btn.focus()}});
  }
  var path=location.pathname.replace(/\/$/,'')||'/';
  document.querySelectorAll('#mainNav [data-nav]').forEach(function(a){
    var h=a.getAttribute('href'); if(h&&h!=='/'&&(path===h||path.indexOf(h+'/')===0)) a.classList.add('on');
  });
  var yr=$('#yr'); if(yr) yr.textContent=new Date().getFullYear();
  var copy=$('#copyEmail');
  if(copy) copy.addEventListener('click',function(){
    navigator.clipboard.writeText('mike@mjmovingco.com').then(function(){copy.textContent='Copied'},function(){copy.textContent='Select the address above'});
  });
  var mbar=$('#mbar');
  if(mbar){
    var onScroll=function(){mbar.classList.toggle('show',window.scrollY>240)};
    window.addEventListener('scroll',onScroll,{passive:true});onScroll();
  }
})();
