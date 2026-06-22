(function(){
  'use strict';
  var SLOT_ORDER=[['morning','朝'],['midday','昼'],['evening','夕'],['night','夜']];
  var AUTO_MS=60000,STALE_MINUTES=180;
  var data=null,activeSlot='morning',currentDate='',autoOn=true,timer=null,loadedAt=null;
  var selectedChart={code:'',name:''};
  var tvScriptLoading=false,tvReadyCallbacks=[];

  function byId(id){return document.getElementById(id);}
  function esc(value){return String(value==null?'':value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
  function arr(value){return Object.prototype.toString.call(value)==='[object Array]'?value:[];}
  function dateObj(value){var d=value?new Date(value):null;return d&&!isNaN(d.getTime())?d:null;}
  function jstKey(date){var d=date||new Date(),j=new Date(d.getTime()+9*60*60*1000);return j.toISOString().slice(0,10);}
  function addDays(key,days){var d=new Date(key+'T00:00:00+09:00');d.setDate(d.getDate()+days);return jstKey(d);}
  function fmt(value){var d=dateObj(value);if(!d)return '---';try{return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(d);}catch(e){return d.toLocaleString();}}
  function age(value){var d=dateObj(value);if(!d)return null;return Math.max(0,Math.floor((Date.now()-d.getTime())/60000));}
  function get(obj,path,def){var cur=obj;for(var i=0;i<path.length;i++){if(cur==null||typeof cur!=='object'||!(path[i] in cur))return def;cur=cur[path[i]];}return cur==null?def:cur;}
  function newestSlot(reports){var best='morning',bestTime=-1;for(var i=0;i<SLOT_ORDER.length;i++){var key=SLOT_ORDER[i][0],item=reports&&reports[key];if(item){var d=dateObj(item.generatedAt),t=d?d.getTime():i;if(t>bestTime){bestTime=t;best=key;}}}return best;}
  function slotLabel(key){for(var i=0;i<SLOT_ORDER.length;i++)if(SLOT_ORDER[i][0]===key)return SLOT_ORDER[i][1];return key;}
  function normalizeCode(value){var m=String(value==null?'':value).match(/\d{4,5}/);return m?m[0]:'';}
  function tradingViewSymbol(code){return 'TSE:'+code;}
  function yahooChartUrl(code){return 'https://finance.yahoo.co.jp/quote/'+code+'.T/chart';}
  function tradingViewPageUrl(code){return 'https://jp.tradingview.com/symbols/TSE-'+code+'/';}

  function status(message,type,path){
    var el=byId('status'),reports=data&&data.reports?data.reports:{},newest=data?reports[newestSlot(reports)]:null,mins=newest?age(newest.generatedAt):null,stale=currentDate===jstKey()&&mins!==null&&mins>STALE_MINUTES,badges=[];
    if(path)badges.push('<span class="badge">読込先: '+esc(path)+'</span>');
    if(loadedAt)badges.push('<span class="badge good">最終確認: '+esc(fmt(loadedAt))+'</span>');
    if(newest&&newest.generatedAt)badges.push('<span class="badge '+(stale?'bad':'good')+'">最新通知: '+esc(fmt(newest.generatedAt))+(mins!==null?'（'+mins+'分前）':'')+'</span>');
    if(data&&data.updatedAt)badges.push('<span class="badge">JSON更新: '+esc(fmt(data.updatedAt))+'</span>');
    if(stale)badges.push('<span class="badge bad">データ鮮度警告</span>');
    el.className='status '+(stale&&type==='ok'?'warning':type);
    el.innerHTML='<div class="status-top"><strong>'+esc(message)+'</strong><span>'+(autoOn?'自動更新ON':'自動更新OFF')+'</span></div>'+(badges.length?'<div class="badges">'+badges.join('')+'</div>':'');
  }

  function chips(items){items=arr(items);if(!items.length)return '<span class="muted">---</span>';var out=[];for(var i=0;i<items.length;i++){var x=items[i],label;if(x&&typeof x==='object'){label=[x.symbol,x.name,x.severity,x.title||x.summary||x.reason].filter(function(v){return !!v;}).join(' | ');if(!label){try{label=JSON.stringify(x);}catch(e){label='---';}}}else label=x;out.push('<span class="chip">'+esc(label)+'</span>');}return '<div class="chips">'+out.join('')+'</div>';}

  function rows(items,empty,clickable){
    items=arr(items);if(!items.length)return '<p class="muted">'+esc(empty)+'</p>';
    var out=[];
    for(var i=0;i<items.length;i++){
      var x=items[i],main='',sub='',code='',name='';
      if(x&&typeof x==='object'){
        code=normalizeCode(x.code||x.symbol||x.ticker||'');
        name=x.name||'';
        main=[x.symbol||x.code,x.name].filter(function(v){return !!v;}).join(' ');
        if(!main){try{main=JSON.stringify(x);}catch(e){main='---';}}
        var missing=arr(x.missingConditions).join(' / ');
        sub=[x.reason,x.signal,x.theme,missing].filter(function(v){return !!v;}).join('｜');
      }else main=x;
      var cls='row'+(clickable&&code?' clickable':'')+((selectedChart.code&&code===selectedChart.code)?' selected':'');
      var attrs=clickable&&code?' data-chart-code="'+esc(code)+'" data-chart-name="'+esc(name||main)+'" tabindex="0" role="button" aria-label="'+esc((name||main)+' のチャートを表示')+'"':'';
      out.push('<div class="'+cls+'"'+attrs+'><div><div class="row-main">'+esc(main)+'</div>'+(sub?'<div class="row-sub">'+esc(sub)+'</div>':'')+'</div><div class="num">'+(i+1)+'</div></div>');
    }
    return '<div class="list">'+out.join('')+'</div>';
  }

  function reasons(obj){if(!obj||typeof obj!=='object')return '<p class="muted">理由データはありません。</p>';var keys=Object.keys(obj);if(!keys.length)return '<p class="muted">理由データはありません。</p>';keys.sort(function(a,b){return Number(obj[b]||0)-Number(obj[a]||0);});var out=[];for(var i=0;i<keys.length;i++)out.push('<div class="row"><div class="row-main">'+esc(keys[i])+'</div><div class="num">'+esc(obj[keys[i]])+'</div></div>');return '<div class="list">'+out.join('')+'</div>';}

  function requestJson(url,ok,fail){var xhr=new XMLHttpRequest();xhr.open('GET',url,true);xhr.timeout=20000;xhr.onreadystatechange=function(){if(xhr.readyState!==4)return;if(xhr.status>=200&&xhr.status<300){try{ok(JSON.parse(xhr.responseText));}catch(e){fail('JSON解析エラー: '+e.message);}}else fail('HTTP '+xhr.status);};xhr.onerror=function(){fail('通信エラー');};xhr.ontimeout=function(){fail('タイムアウト');};try{xhr.send();}catch(e){fail(e.message||'読込エラー');}}

  function ensureTradingView(cb){
    if(window.TradingView&&typeof window.TradingView.widget==='function'){cb();return;}
    tvReadyCallbacks.push(cb);
    if(tvScriptLoading)return;
    tvScriptLoading=true;
    var s=document.createElement('script');
    s.src='https://s3.tradingview.com/tv.js';
    s.async=true;
    s.onload=function(){tvScriptLoading=false;var list=tvReadyCallbacks.slice();tvReadyCallbacks=[];for(var i=0;i<list.length;i++){try{list[i]();}catch(e){}}};
    s.onerror=function(){tvScriptLoading=false;tvReadyCallbacks=[];var help=byId('chartHelp');if(help)help.innerHTML='チャートライブラリの読込に失敗しました。下のリンクからチャートを開いてください。';};
    document.head.appendChild(s);
  }

  function renderChartPanel(){
    var help=byId('chartHelp'),meta=byId('chartMeta'),links=byId('chartLinks'),container=byId('tvChartContainer');
    if(!help||!meta||!links||!container)return;
    if(!selectedChart.code){
      help.textContent='ENTRY候補・ENTRY間近・Focus・Watchの銘柄をタップすると、ここにチャートを表示します。';
      meta.innerHTML='';
      links.innerHTML='';
      container.innerHTML='';
      return;
    }
    var code=selectedChart.code,name=selectedChart.name||code;
    help.textContent='選択中: '+code+' '+name;
    meta.innerHTML='<span class="badge good">銘柄コード: '+esc(code)+'</span><span class="badge">表示足: 60分</span><span class="badge">マーケット: 東証想定</span>';
    links.innerHTML='<a href="'+yahooChartUrl(code)+'" target="_blank" rel="noopener">Yahooファイナンスで開く</a><a href="'+tradingViewPageUrl(code)+'" target="_blank" rel="noopener">TradingViewで開く</a>';
    container.innerHTML='';
    ensureTradingView(function(){
      container.innerHTML='';
      try{
        new window.TradingView.widget({autosize:true,symbol:tradingViewSymbol(code),interval:'60',timezone:'Asia/Tokyo',theme:'dark',style:'1',locale:'ja',toolbar_bg:'#0f1726',enable_publishing:false,hide_top_toolbar:false,hide_legend:false,allow_symbol_change:false,save_image:false,studies:['Volume@tv-basicstudies'],container_id:'tvChartContainer'});
      }catch(e){help.textContent='チャート表示に失敗しました。下のリンクから確認してください。';}
    });
  }

  function bindChartTargets(){
    var root=byId('content');
    if(!root)return;
    var nodes=root.querySelectorAll('[data-chart-code]');
    for(var i=0;i<nodes.length;i++){
      nodes[i].onclick=function(){selectedChart.code=this.getAttribute('data-chart-code')||'';selectedChart.name=this.getAttribute('data-chart-name')||'';render();};
      nodes[i].onkeydown=function(ev){var e=ev||window.event,key=e.key||e.keyCode;if(key==='Enter'||key===' '||key===13||key===32){if(e.preventDefault)e.preventDefault();selectedChart.code=this.getAttribute('data-chart-code')||'';selectedChart.name=this.getAttribute('data-chart-name')||'';render();return false;}};
    }
  }

  function pickDefaultChart(item){
    if(selectedChart.code)return;
    var groups=[arr(item.entryCandidates),get(item,['diagnostics','entryDiagnostics','entryNearbySymbols'],[]),arr(item.focusSymbols),arr(item.watchSymbols)];
    for(var g=0;g<groups.length;g++){
      for(var i=0;i<groups[g].length;i++){
        var x=groups[g][i],code=normalizeCode((x&&typeof x==='object')?(x.code||x.symbol||x.ticker||''):'');
        if(code){selectedChart.code=code;selectedChart.name=(x&&typeof x==='object'&&(x.name||x.symbol||x.code))||code;return;}
      }
    }
  }

  function load(key,preserve,quiet){currentDate=key;var path='reports/radar-notifications-'+key+'.json';if(!quiet)status(key+' を読み込み中','ok',path);requestJson(path+'?cb='+Date.now(),function(next){data=next||{};var reports=data.reports||{};if(!preserve||!reports[activeSlot])activeSlot=newestSlot(reports);loadedAt=new Date();render();status(key+' の通知履歴を表示中','ok',path);},function(message){data=null;render();status(key+' の通知履歴を取得できません: '+message,'error',path);});}

  function render(){
    var summary=byId('summary'),tabs=byId('tabs'),content=byId('content');
    if(!data){summary.textContent='通知履歴を読み込めませんでした。上のエラー内容と読込先を確認してください。';tabs.innerHTML='';content.innerHTML='';return;}
    summary.textContent=data.dailySummary||'最新時間帯を表示しています。ENTRY候補などの銘柄を押すとチャートを表示できます。';
    var reports=data.reports||{},tabHtml=[];
    for(var i=0;i<SLOT_ORDER.length;i++){var key=SLOT_ORDER[i][0],label=SLOT_ORDER[i][1],item=reports[key],sub=item?'Focus '+(item.focusCount||0)+' / Watch '+(item.watchCount||0)+' / '+fmt(item.generatedAt):'未生成';tabHtml.push('<button type="button" class="tab '+(activeSlot===key?'active':'')+'" data-slot="'+key+'"><strong>'+label+'</strong><span>'+esc(sub)+'</span></button>');}
    tabs.innerHTML=tabHtml.join('');
    var tabButtons=tabs.getElementsByTagName('button');
    for(var t=0;t<tabButtons.length;t++)tabButtons[t].onclick=function(){activeSlot=this.getAttribute('data-slot');selectedChart.code='';selectedChart.name='';render();status(currentDate+' の通知履歴を表示中','ok','reports/radar-notifications-'+currentDate+'.json');};
    var item=reports[activeSlot];
    if(!item){content.innerHTML='<div class="card"><h2>'+esc(slotLabel(activeSlot))+'</h2><p>この時間帯の通知はまだありません。</p></div>';return;}
    pickDefaultChart(item);
    var diagnostics=item.diagnostics||{},dataStatus=item.dataStatus||{},entryDiag=get(diagnostics,['entryDiagnostics'],{}),focusDiag=get(diagnostics,['focusDiagnostics'],{}),watchDiag=get(diagnostics,['watchDiagnostics'],{}),entryNearby=get(entryDiag,['entryNearbySymbols'],[]),entryReason=get(entryDiag,['reasonCounts'],{}),focusReason=get(focusDiag,['reasonCounts'],{}),mins=age(item.generatedAt),stale=currentDate===jstKey()&&mins!==null&&mins>STALE_MINUTES;
    content.innerHTML=''
      +'<div class="card full"><h2>チャート</h2><div id="chartHelp" class="muted"></div><div id="chartMeta" class="chart-meta"></div><div id="chartLinks" class="chart-links"></div><div class="chart-wrap"><div id="tvChartContainer"></div></div></div>'
      +'<div class="card"><h2>通知概要</h2><div class="kv"><div class="k">marketDate</div><div class="v">'+esc(item.marketDate||'---')+'</div><div class="k">generatedAt</div><div class="v">'+esc(fmt(item.generatedAt))+(mins!==null?'（'+mins+'分前）':'')+'</div><div class="k">データ鮮度</div><div class="v"><span class="badge '+(stale?'bad':'good')+'">'+(stale?'古い可能性あり':'確認済み')+'</span></div><div class="k">通知</div><div class="v">'+esc((item.notificationType||'---')+' / '+(item.notificationLabel||'---'))+'</div><div class="k">runId</div><div class="v">'+esc(item.runId||'---')+'</div><div class="k">地合い</div><div class="v">'+esc(item.marketRegime||'---')+'</div><div class="k">Focus</div><div class="v">'+esc(item.focusCount||0)+'件</div><div class="k">Watch</div><div class="v">'+esc(item.watchCount||0)+'件</div><div class="k">ENTRY</div><div class="v">'+arr(item.entryCandidates).length+'件</div></div></div>'
      +'<div class="card"><h2>短文通知</h2><pre>'+esc(item.shortNotificationText||'')+'</pre></div>'
      +'<div class="card"><h2>Focus銘柄（タップでチャート）</h2>'+rows(item.focusSymbols,'Focus銘柄はありません。',true)+'</div>'
      +'<div class="card"><h2>Watch銘柄（タップでチャート）</h2>'+rows(item.watchSymbols,'Watch銘柄はありません。',true)+'</div>'
      +'<div class="card"><h2>ENTRY候補（タップでチャート）</h2>'+rows(item.entryCandidates,'現時点でENTRY成立銘柄はありません。',true)+'<h3>ENTRY間近・不足条件（タップでチャート）</h3>'+rows(entryNearby,'ENTRY間近の銘柄情報はありません。',true)+'</div>'
      +'<div class="card"><h2>ENTRY不成立理由</h2>'+reasons(entryReason)+'<h3>Focus除外・不足理由</h3>'+reasons(focusReason)+'</div>'
      +'<div class="card"><h2>注目テーマ</h2>'+chips(item.themes)+'<h3>重要材料</h3>'+chips(item.importantMaterials)+'<h3>注意点</h3>'+chips(item.cautions)+'</div>'
      +'<div class="card"><h2>データ取得状態</h2><div class="kv"><div class="k">scanTarget</div><div class="v">'+esc(dataStatus.scanTargetCount==null?'---':dataStatus.scanTargetCount)+'</div><div class="k">success / failed</div><div class="v">'+esc(dataStatus.priceFetchSuccessCount==null?'---':dataStatus.priceFetchSuccessCount)+' / '+esc(dataStatus.priceFetchFailedCount==null?'---':dataStatus.priceFetchFailedCount)+'</div><div class="k">hourlyEvaluated</div><div class="v">'+esc(dataStatus.hourlyEvaluatedCount==null?'---':dataStatus.hourlyEvaluatedCount)+'</div><div class="k">scanOnly</div><div class="v">'+esc(dataStatus.scanOnlyCount==null?'---':dataStatus.scanOnlyCount)+'</div><div class="k">freshness</div><div class="v">'+esc(dataStatus.dataFreshnessStatus||'---')+'</div><div class="k">source generatedAt</div><div class="v">'+esc(fmt(dataStatus.generatedAt))+'</div></div></div>'
      +'<div class="card"><h2>前回通知からの変化</h2><div class="kv"><div class="k">Watch重複率</div><div class="v">'+esc(typeof watchDiag.watchOverlapRate==='number'?watchDiag.watchOverlapRate.toFixed(1)+'%':'---')+'</div><div class="k">新規Watch</div><div class="v">'+esc(watchDiag.newWatchCount==null?'---':watchDiag.newWatchCount)+'</div><div class="k">Focus昇格</div><div class="v">'+esc(watchDiag.promotedToFocusCount==null?'---':watchDiag.promotedToFocusCount)+'</div><div class="k">停滞理由</div><div class="v">'+esc(watchDiag.watchStagnationReason||'---')+'</div></div></div>'
      +'<div class="card full"><h2>次の時間帯への引き継ぎ</h2><div class="v">'+esc(item.handoffToNextSession||'---')+'</div></div>';
    bindChartTargets();
    renderChartPanel();
  }

  function setAuto(on){autoOn=on;var btn=byId('refreshBtn');btn.textContent='自動更新 60秒: '+(on?'ON':'OFF');btn.className=on?'good':'warn';if(timer){clearInterval(timer);timer=null;}if(on)timer=setInterval(function(){var key=byId('dateInput').value||jstKey();load(key,true,true);},AUTO_MS);if(currentDate)status(currentDate+' の通知履歴を表示中',data?'ok':'error','reports/radar-notifications-'+currentDate+'.json');}

  byId('todayBtn').onclick=function(){var key=jstKey();byId('dateInput').value=key;selectedChart.code='';selectedChart.name='';load(key,false,false);};
  byId('yesterdayBtn').onclick=function(){var key=addDays(jstKey(),-1);byId('dateInput').value=key;selectedChart.code='';selectedChart.name='';load(key,false,false);};
  byId('loadBtn').onclick=function(){var key=byId('dateInput').value||jstKey();selectedChart.code='';selectedChart.name='';load(key,false,false);};
  byId('refreshBtn').onclick=function(){setAuto(!autoOn);};

  var initial=jstKey();
  byId('dateInput').value=initial;
  setAuto(true);
  load(initial,false,false);
})();
