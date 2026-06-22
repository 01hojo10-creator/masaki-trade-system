(function(){
  'use strict';

  function normalizeCode(value){
    var text=String(value==null?'':value).toUpperCase().replace(/^TSE:/,'').replace(/\.T$/,'').trim();
    var exact=text.match(/^[0-9A-Z]{4}$/);
    if(exact&&/\d/.test(exact[0]))return exact[0];
    var token=text.match(/(?:^|[^0-9A-Z])([0-9A-Z]{4})(?:\.T)?(?:$|[^0-9A-Z])/);
    return token&&/\d/.test(token[1])?token[1]:'';
  }

  function tradingViewUrl(code){
    return 'https://jp.tradingview.com/chart/?symbol='+encodeURIComponent('TSE:'+code)+'&interval=60';
  }

  function findChartTarget(start){
    var node=start;
    while(node&&node!==document){
      if(node.getAttribute&&node.getAttribute('data-chart-code'))return node;
      node=node.parentNode;
    }
    return null;
  }

  function removeEmbeddedCharts(){
    var ids=['chartCard','exactChartCard'];
    for(var i=0;i<ids.length;i++){
      var item=document.getElementById(ids[i]);
      if(item&&item.parentNode)item.parentNode.removeChild(item);
    }
    var legacy=document.getElementById('tvChartContainer');
    if(legacy){
      var card=legacy.closest?legacy.closest('.card'):legacy.parentNode;
      if(card&&card.parentNode)card.parentNode.removeChild(card);
    }
  }

  function updateLabels(){
    var headings=document.querySelectorAll('#content h2');
    for(var i=0;i<headings.length;i++){
      if(headings[i].textContent.indexOf('銘柄一覧')!==-1){
        headings[i].textContent='銘柄一覧（タップでTradingViewを開く）';
      }
    }
    var status=document.getElementById('status');
    if(status&&status.textContent.indexOf('TradingView直結')===-1){
      var badges=status.querySelector('.badges');
      if(badges){
        var badge=document.createElement('span');
        badge.className='badge good';
        badge.textContent='TradingView直結 v6';
        badges.appendChild(badge);
      }
    }
  }

  function openTradingView(target,event){
    var code=normalizeCode(target.getAttribute('data-chart-code'));
    if(!code)return;
    if(event){
      if(event.preventDefault)event.preventDefault();
      if(event.stopPropagation)event.stopPropagation();
      if(event.stopImmediatePropagation)event.stopImmediatePropagation();
    }
    var url=tradingViewUrl(code);
    var opened=window.open(url,'_blank','noopener,noreferrer');
    if(opened){
      try{opened.opener=null;}catch(error){}
    }else{
      window.location.href=url;
    }
  }

  document.addEventListener('click',function(event){
    var target=findChartTarget(event.target);
    if(target)openTradingView(target,event);
  },true);

  document.addEventListener('keydown',function(event){
    var key=event.key||event.keyCode;
    if(!(key==='Enter'||key===' '||key===13||key===32))return;
    var target=findChartTarget(event.target);
    if(target)openTradingView(target,event);
  },true);

  var observer=new MutationObserver(function(){
    removeEmbeddedCharts();
    updateLabels();
  });

  function start(){
    var content=document.getElementById('content');
    if(!content){setTimeout(start,100);return;}
    observer.observe(content,{childList:true,subtree:true});
    var status=document.getElementById('status');
    if(status)observer.observe(status,{childList:true,subtree:true});
    removeEmbeddedCharts();
    updateLabels();
  }

  start();
})();
