(function(){
  'use strict';

  var SLOT_ORDER = [
    ['morning', '朝'],
    ['midday', '昼'],
    ['evening', '夕'],
    ['night', '夜']
  ];
  var AUTO_REFRESH_MS = 60000;
  var STALE_MINUTES = 180;
  var VIEWER_VERSION = '20260622-5';

  var currentData = null;
  var activeSlot = 'morning';
  var currentDateKey = '';
  var autoRefreshEnabled = true;
  var autoRefreshTimer = null;
  var lastSuccessfulLoadAt = null;
  var selectedChart = { code: '', name: '', scroll: false };
  var chartCache = {};

  function byId(id){ return document.getElementById(id); }

  function escapeHtml(value){
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function asList(value){
    return Object.prototype.toString.call(value) === '[object Array]' ? value : [];
  }

  function getPath(object, path, fallback){
    var current = object;
    var i;
    for(i = 0; i < path.length; i += 1){
      if(current == null || typeof current !== 'object' || !(path[i] in current)) return fallback;
      current = current[path[i]];
    }
    return current == null ? fallback : current;
  }

  function parseDate(value){
    var date = value ? new Date(value) : null;
    return date && !isNaN(date.getTime()) ? date : null;
  }

  function jstDateKey(date){
    var base = date || new Date();
    var jst = new Date(base.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 10);
  }

  function addDays(dateKey, days){
    var date = new Date(dateKey + 'T00:00:00+09:00');
    date.setDate(date.getDate() + days);
    return jstDateKey(date);
  }

  function formatJst(value){
    var date = parseDate(value);
    if(!date) return '---';
    try{
      return new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).format(date);
    }catch(error){
      return date.toLocaleString();
    }
  }

  function ageMinutes(value){
    var date = parseDate(value);
    if(!date) return null;
    return Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  }

  function newestSlotKey(reports){
    var bestKey = 'morning';
    var bestTime = -1;
    var i;
    for(i = 0; i < SLOT_ORDER.length; i += 1){
      var key = SLOT_ORDER[i][0];
      var item = reports && reports[key];
      var date = item ? parseDate(item.generatedAt) : null;
      var time = date ? date.getTime() : -1;
      if(time > bestTime){
        bestTime = time;
        bestKey = key;
      }
    }
    return bestKey;
  }

  function slotLabel(key){
    var i;
    for(i = 0; i < SLOT_ORDER.length; i += 1){
      if(SLOT_ORDER[i][0] === key) return SLOT_ORDER[i][1];
    }
    return key;
  }

  function normalizeJapaneseStockCode(value){
    var text = String(value == null ? '' : value)
      .toUpperCase()
      .replace(/^TSE:/, '')
      .replace(/\.T$/, '')
      .trim();
    var exact = text.match(/^[0-9A-Z]{4}$/);
    if(exact && /\d/.test(exact[0])) return exact[0];
    var token = text.match(/(?:^|[^0-9A-Z])([0-9A-Z]{4})(?:\.T)?(?:$|[^0-9A-Z])/);
    return token && /\d/.test(token[1]) ? token[1] : '';
  }

  function yahooSymbol(code){ return code + '.T'; }

  function yahooPageUrl(code){
    return 'https://finance.yahoo.co.jp/quote/' + encodeURIComponent(yahooSymbol(code)) + '/chart';
  }

  function yahooApiUrls(code){
    var suffix = '/v8/finance/chart/' + encodeURIComponent(yahooSymbol(code)) +
      '?interval=1h&range=1mo&includePrePost=false&events=div%2Csplits';
    return [
      'https://query1.finance.yahoo.com' + suffix,
      'https://query2.finance.yahoo.com' + suffix
    ];
  }

  function formatPrice(value){
    if(typeof value !== 'number' || !isFinite(value)) return '---';
    try{
      return value.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
    }catch(error){
      return String(Math.round(value * 100) / 100);
    }
  }

  function renderStatus(message, type, path){
    var status = byId('status');
    var reports = currentData && currentData.reports ? currentData.reports : {};
    var newest = currentData ? reports[newestSlotKey(reports)] : null;
    var newestAge = newest ? ageMinutes(newest.generatedAt) : null;
    var stale = currentDateKey === jstDateKey() && newestAge !== null && newestAge > STALE_MINUTES;
    var badges = [];

    if(path) badges.push('<span class="badge">読込先: ' + escapeHtml(path) + '</span>');
    badges.push('<span class="badge">Viewer ' + VIEWER_VERSION + '</span>');
    if(lastSuccessfulLoadAt) badges.push('<span class="badge good">最終確認: ' + escapeHtml(formatJst(lastSuccessfulLoadAt)) + '</span>');
    if(newest && newest.generatedAt){
      badges.push('<span class="badge ' + (stale ? 'bad' : 'good') + '">最新通知: ' +
        escapeHtml(formatJst(newest.generatedAt)) + (newestAge !== null ? '（' + newestAge + '分前）' : '') + '</span>');
    }
    if(currentData && currentData.updatedAt) badges.push('<span class="badge">JSON更新: ' + escapeHtml(formatJst(currentData.updatedAt)) + '</span>');
    if(stale) badges.push('<span class="badge bad">データ鮮度警告</span>');

    status.className = 'status ' + (stale && type === 'ok' ? 'warning' : type);
    status.innerHTML = '<div class="status-top"><strong>' + escapeHtml(message) + '</strong><span>' +
      (autoRefreshEnabled ? '自動更新ON' : '自動更新OFF') + '</span></div>' +
      '<div class="badges">' + badges.join('') + '</div>';
  }

  function renderChips(items){
    var list = asList(items);
    if(!list.length) return '<span class="muted">---</span>';
    var html = [];
    var i;
    for(i = 0; i < list.length; i += 1){
      var item = list[i];
      var label;
      if(item && typeof item === 'object'){
        label = [item.symbol, item.name, item.severity, item.title || item.summary || item.reason]
          .filter(function(value){ return !!value; })
          .join(' | ');
        if(!label){
          try{ label = JSON.stringify(item); }
          catch(error){ label = '---'; }
        }
      }else{
        label = item;
      }
      html.push('<span class="chip">' + escapeHtml(label) + '</span>');
    }
    return '<div class="chips">' + html.join('') + '</div>';
  }

  function extractSymbolEntry(raw, statusLabel){
    var object = raw && typeof raw === 'object' ? raw : null;
    var source = object ? (object.code || object.symbol || object.ticker || '') : raw;
    var code = normalizeJapaneseStockCode(source);
    if(!code) return null;

    var name = object ? (object.name || '') : String(raw || '').replace(code, '').trim();
    var details = [];
    if(object){
      if(object.reason) details.push(object.reason);
      if(object.signal) details.push(object.signal);
      if(object.theme) details.push(object.theme);
      if(asList(object.missingConditions).length) details.push(asList(object.missingConditions).join(' / '));
    }

    return {
      code: code,
      name: name,
      statuses: [statusLabel],
      details: details
    };
  }

  function collectChartSymbols(item){
    var ordered = [];
    var map = {};

    function addGroup(items, statusLabel){
      var list = asList(items);
      var i;
      for(i = 0; i < list.length; i += 1){
        var entry = extractSymbolEntry(list[i], statusLabel);
        if(!entry) continue;
        var existing = map[entry.code];
        if(!existing){
          map[entry.code] = entry;
          ordered.push(entry);
        }else{
          if(!existing.name && entry.name) existing.name = entry.name;
          if(existing.statuses.indexOf(statusLabel) === -1) existing.statuses.push(statusLabel);
          var j;
          for(j = 0; j < entry.details.length; j += 1){
            if(existing.details.indexOf(entry.details[j]) === -1) existing.details.push(entry.details[j]);
          }
        }
      }
    }

    addGroup(item.entryCandidates, 'ENTRY');
    addGroup(getPath(item, ['diagnostics', 'entryDiagnostics', 'entryNearbySymbols'], []), 'ENTRY間近');
    addGroup(item.focusSymbols, 'Focus');
    addGroup(item.watchSymbols, 'Watch');
    return ordered;
  }

  function renderChartSymbolList(item){
    var symbols = collectChartSymbols(item);
    if(!symbols.length) return '<p class="muted">チャート表示対象の銘柄はありません。</p>';
    var rows = [];
    var i;
    for(i = 0; i < symbols.length; i += 1){
      var symbol = symbols[i];
      var detailText = symbol.statuses.join(' / ');
      if(symbol.details.length) detailText += '｜' + symbol.details.join('｜');
      rows.push(
        '<div class="row clickable' + (selectedChart.code === symbol.code ? ' selected' : '') + '"' +
        ' data-chart-code="' + escapeHtml(symbol.code) + '"' +
        ' data-chart-name="' + escapeHtml(symbol.name || '') + '"' +
        ' tabindex="0" role="button" aria-label="' + escapeHtml(symbol.code + ' ' + symbol.name + ' のチャートを表示') + '">' +
        '<div><div class="row-main">' + escapeHtml(symbol.code + (symbol.name ? ' ' + symbol.name : '')) + '</div>' +
        '<div class="row-sub">' + escapeHtml(detailText) + '</div></div>' +
        '<div class="num">' + (i + 1) + '</div></div>'
      );
    }
    return '<div class="list">' + rows.join('') + '</div>';
  }

  function renderReasonRows(reasonCounts){
    if(!reasonCounts || typeof reasonCounts !== 'object') return '<p class="muted">理由データはありません。</p>';
    var keys = Object.keys(reasonCounts);
    if(!keys.length) return '<p class="muted">理由データはありません。</p>';
    keys.sort(function(a, b){ return Number(reasonCounts[b] || 0) - Number(reasonCounts[a] || 0); });
    var html = [];
    var i;
    for(i = 0; i < keys.length; i += 1){
      html.push('<div class="row"><div class="row-main">' + escapeHtml(keys[i]) + '</div>' +
        '<div class="num">' + escapeHtml(reasonCounts[keys[i]]) + '</div></div>');
    }
    return '<div class="list">' + html.join('') + '</div>';
  }

  function renderNews(items){
    var list = asList(items);
    if(!list.length) return '<p class="muted">重要ニュースはありません。</p>';
    var html = [];
    var i;
    for(i = 0; i < list.length; i += 1){
      var item = list[i] || {};
      var url = item.url || '';
      html.push('<article class="row"><div>' +
        '<div class="row-main">' + escapeHtml(item.title || item.summary || '---') + '</div>' +
        '<div class="row-sub">' + escapeHtml([item.severity, item.category, item.source].filter(function(v){ return !!v; }).join(' / ')) + '</div>' +
        (url ? '<div class="row-sub"><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">ニュースを開く</a></div>' : '') +
        '</div></article>');
    }
    return '<div class="list">' + html.join('') + '</div>';
  }

  function requestJson(url, onSuccess, onFailure){
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 20000;
    xhr.onreadystatechange = function(){
      if(xhr.readyState !== 4) return;
      if(xhr.status >= 200 && xhr.status < 300){
        try{ onSuccess(JSON.parse(xhr.responseText)); }
        catch(error){ onFailure('JSON解析エラー: ' + error.message); }
      }else{
        onFailure('HTTP ' + xhr.status);
      }
    };
    xhr.onerror = function(){ onFailure('通信エラー'); };
    xhr.ontimeout = function(){ onFailure('タイムアウト'); };
    try{ xhr.send(); }
    catch(error){ onFailure(error.message || '取得エラー'); }
  }

  function buildCandlestickSvg(payload, requestedCode){
    var result = getPath(payload, ['chart', 'result', 0], null);
    if(!result) throw new Error('チャートデータがありません');

    var returnedSymbol = String(getPath(result, ['meta', 'symbol'], '')).toUpperCase();
    var expectedSymbol = yahooSymbol(requestedCode).toUpperCase();
    if(returnedSymbol !== expectedSymbol){
      throw new Error('銘柄コード不一致: ' + returnedSymbol);
    }

    var timestamps = asList(result.timestamp);
    var quote = getPath(result, ['indicators', 'quote', 0], {});
    var opens = asList(quote.open);
    var highs = asList(quote.high);
    var lows = asList(quote.low);
    var closes = asList(quote.close);
    var bars = [];
    var i;

    for(i = 0; i < timestamps.length; i += 1){
      var open = Number(opens[i]);
      var high = Number(highs[i]);
      var low = Number(lows[i]);
      var close = Number(closes[i]);
      if(isFinite(open) && isFinite(high) && isFinite(low) && isFinite(close)){
        bars.push({ time: Number(timestamps[i]), open: open, high: high, low: low, close: close });
      }
    }

    if(!bars.length) throw new Error('有効な株価データがありません');
    if(bars.length > 90) bars = bars.slice(bars.length - 90);

    var min = Infinity;
    var max = -Infinity;
    for(i = 0; i < bars.length; i += 1){
      if(bars[i].low < min) min = bars[i].low;
      if(bars[i].high > max) max = bars[i].high;
    }
    var padding = (max - min) * 0.06 || Math.max(max * 0.01, 1);
    min -= padding;
    max += padding;

    var width = 900;
    var height = 420;
    var left = 68;
    var right = 18;
    var top = 18;
    var bottom = 42;
    var plotWidth = width - left - right;
    var plotHeight = height - top - bottom;

    function y(value){ return top + (max - value) / (max - min) * plotHeight; }
    function x(index){ return left + (index + 0.5) * plotWidth / bars.length; }

    var candleWidth = Math.max(2, Math.min(9, plotWidth / bars.length * 0.62));
    var svg = [
      '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' +
      escapeHtml(requestedCode + ' の60分足ローソク足') + '" style="display:block;width:100%;height:auto;background:#0e1627">',
      '<rect width="' + width + '" height="' + height + '" fill="#0e1627"/>'
    ];

    for(i = 0; i <= 5; i += 1){
      var gridY = top + plotHeight * i / 5;
      var gridPrice = max - (max - min) * i / 5;
      svg.push('<line x1="' + left + '" y1="' + gridY + '" x2="' + (width - right) + '" y2="' + gridY + '" stroke="rgba(255,255,255,.10)"/>');
      svg.push('<text x="' + (left - 8) + '" y="' + (gridY + 4) + '" fill="#9fb0c8" font-size="12" text-anchor="end">' + escapeHtml(formatPrice(gridPrice)) + '</text>');
    }

    for(i = 0; i < bars.length; i += 1){
      var bar = bars[i];
      var centerX = x(i);
      var openY = y(bar.open);
      var closeY = y(bar.close);
      var color = bar.close >= bar.open ? '#20c997' : '#ff6b7a';
      svg.push('<line x1="' + centerX + '" y1="' + y(bar.high) + '" x2="' + centerX + '" y2="' + y(bar.low) + '" stroke="' + color + '" stroke-width="1.4"/>');
      svg.push('<rect x="' + (centerX - candleWidth / 2) + '" y="' + Math.min(openY, closeY) + '" width="' + candleWidth + '" height="' + Math.max(1.5, Math.abs(closeY - openY)) + '" fill="' + color + '" rx="1"/>');
    }

    var labelIndexes = [0, Math.floor((bars.length - 1) / 2), bars.length - 1];
    for(i = 0; i < labelIndexes.length; i += 1){
      var barIndex = labelIndexes[i];
      var date = new Date(bars[barIndex].time * 1000);
      var hours = String(date.getHours());
      if(hours.length < 2) hours = '0' + hours;
      var dateLabel = (date.getMonth() + 1) + '/' + date.getDate() + ' ' + hours + ':00';
      svg.push('<text x="' + x(barIndex) + '" y="' + (height - 14) + '" fill="#9fb0c8" font-size="12" text-anchor="middle">' + escapeHtml(dateLabel) + '</text>');
    }
    svg.push('</svg>');

    var firstClose = bars[0].close;
    var lastClose = bars[bars.length - 1].close;
    var change = lastClose - firstClose;
    return {
      svg: svg.join(''),
      symbol: returnedSymbol,
      name: getPath(result, ['meta', 'longName'], '') || getPath(result, ['meta', 'shortName'], ''),
      last: lastClose,
      change: change,
      changePct: firstClose ? change / firstClose * 100 : 0
    };
  }

  function fetchChartFromYahoo(code, onSuccess, onFailure){
    if(chartCache[code]){
      onSuccess(chartCache[code]);
      return;
    }

    var urls = yahooApiUrls(code);
    var index = 0;
    function tryNext(lastError){
      if(index >= urls.length){
        onFailure(lastError || 'チャートを取得できませんでした');
        return;
      }
      var url = urls[index];
      index += 1;
      requestJson(url, function(payload){
        try{
          var chart = buildCandlestickSvg(payload, code);
          chartCache[code] = chart;
          onSuccess(chart);
        }catch(error){
          tryNext(error.message);
        }
      }, function(message){
        tryNext(message);
      });
    }
    tryNext('');
  }

  function renderChartCard(){
    if(!selectedChart.code) return '';
    return '<div id="chartCard" class="card full">' +
      '<div class="status-top"><h2>' + escapeHtml(selectedChart.code + ' ' + selectedChart.name) + ' チャート</h2>' +
      '<button id="closeChartBtn" type="button">閉じる</button></div>' +
      '<div id="chartMeta" class="chart-meta">' +
      '<span class="badge good">' + escapeHtml(yahooSymbol(selectedChart.code)) + '</span>' +
      '<span class="badge">60分足</span><span class="badge">日本株のみ</span></div>' +
      '<div class="chart-links"><a href="' + yahooPageUrl(selectedChart.code) + '" target="_blank" rel="noopener">Yahooファイナンスで開く</a></div>' +
      '<div class="chart-wrap"><div id="chartCanvas" style="min-height:320px;display:flex;align-items:center;justify-content:center;color:#9fb0c8;padding:16px">チャートを読み込み中...</div></div>' +
      '</div>';
  }

  function loadSelectedChart(){
    if(!selectedChart.code) return;
    var requestedCode = selectedChart.code;
    fetchChartFromYahoo(requestedCode, function(chart){
      if(selectedChart.code !== requestedCode) return;
      var canvas = byId('chartCanvas');
      var meta = byId('chartMeta');
      if(!canvas || !meta) return;
      var sign = chart.change >= 0 ? '+' : '';
      meta.innerHTML = '<span class="badge good">' + escapeHtml(chart.symbol) + '</span>' +
        (chart.name ? '<span class="badge">' + escapeHtml(chart.name) + '</span>' : '') +
        '<span class="badge">終値 ' + escapeHtml(formatPrice(chart.last)) + '</span>' +
        '<span class="badge ' + (chart.change >= 0 ? 'good' : 'bad') + '">' +
        sign + escapeHtml(formatPrice(chart.change)) + '（' + sign + escapeHtml(chart.changePct.toFixed(2)) + '%）</span>';
      canvas.style.display = 'block';
      canvas.style.padding = '0';
      canvas.innerHTML = chart.svg;
    }, function(message){
      if(selectedChart.code !== requestedCode) return;
      var canvas = byId('chartCanvas');
      if(canvas){
        canvas.innerHTML = 'チャートを取得できませんでした: ' + escapeHtml(message) +
          '<br>誤った銘柄は表示していません。上のYahooファイナンスボタンから確認してください。';
      }
    });
  }

  function bindChartSelection(){
    var root = byId('content');
    var nodes = root ? root.querySelectorAll('[data-chart-code]') : [];
    var i;
    for(i = 0; i < nodes.length; i += 1){
      nodes[i].onclick = function(){
        selectedChart.code = normalizeJapaneseStockCode(this.getAttribute('data-chart-code'));
        selectedChart.name = this.getAttribute('data-chart-name') || '';
        selectedChart.scroll = true;
        render();
      };
      nodes[i].onkeydown = function(event){
        var e = event || window.event;
        var key = e.key || e.keyCode;
        if(key === 'Enter' || key === ' ' || key === 13 || key === 32){
          if(e.preventDefault) e.preventDefault();
          selectedChart.code = normalizeJapaneseStockCode(this.getAttribute('data-chart-code'));
          selectedChart.name = this.getAttribute('data-chart-name') || '';
          selectedChart.scroll = true;
          render();
          return false;
        }
      };
    }
  }

  function loadDate(dateKey, preserveSlot, quiet){
    currentDateKey = dateKey;
    var path = 'reports/radar-notifications-' + dateKey + '.json';
    if(!quiet) renderStatus(dateKey + ' を読み込み中', 'ok', path);
    requestJson(path + '?cb=' + Date.now(), function(nextData){
      currentData = nextData || {};
      var reports = currentData.reports || {};
      if(!preserveSlot || !reports[activeSlot]) activeSlot = newestSlotKey(reports);
      lastSuccessfulLoadAt = new Date();
      render();
      renderStatus(dateKey + ' の通知履歴を表示中', 'ok', path);
    }, function(message){
      currentData = null;
      render();
      renderStatus(dateKey + ' の通知履歴を取得できません: ' + message, 'error', path);
    });
  }

  function render(){
    var summary = byId('summary');
    var tabs = byId('tabs');
    var content = byId('content');

    if(!currentData){
      summary.textContent = '通知履歴を読み込めませんでした。';
      tabs.innerHTML = '';
      content.innerHTML = '';
      return;
    }

    summary.textContent = currentData.dailySummary || '下の銘柄一覧から1銘柄をタップすると、その日本株のチャートを表示します。';
    var reports = currentData.reports || {};
    var tabHtml = [];
    var i;
    for(i = 0; i < SLOT_ORDER.length; i += 1){
      var key = SLOT_ORDER[i][0];
      var item = reports[key];
      var sub = item ? 'Focus ' + (item.focusCount || 0) + ' / Watch ' + (item.watchCount || 0) + ' / ' + formatJst(item.generatedAt) : '未生成';
      tabHtml.push('<button type="button" class="tab ' + (activeSlot === key ? 'active' : '') + '" data-slot="' + key + '">' +
        '<strong>' + SLOT_ORDER[i][1] + '</strong><span>' + escapeHtml(sub) + '</span></button>');
    }
    tabs.innerHTML = tabHtml.join('');
    var tabButtons = tabs.getElementsByTagName('button');
    for(i = 0; i < tabButtons.length; i += 1){
      tabButtons[i].onclick = function(){
        activeSlot = this.getAttribute('data-slot');
        selectedChart = { code: '', name: '', scroll: false };
        render();
        renderStatus(currentDateKey + ' の通知履歴を表示中', 'ok', 'reports/radar-notifications-' + currentDateKey + '.json');
      };
    }

    var activeItem = reports[activeSlot];
    if(!activeItem){
      content.innerHTML = '<div class="card"><h2>' + escapeHtml(slotLabel(activeSlot)) + '</h2><p>この時間帯の通知はまだありません。</p></div>';
      return;
    }

    var diagnostics = activeItem.diagnostics || {};
    var dataStatus = activeItem.dataStatus || {};
    var entryDiagnostics = getPath(diagnostics, ['entryDiagnostics'], {});
    var focusDiagnostics = getPath(diagnostics, ['focusDiagnostics'], {});
    var watchDiagnostics = getPath(diagnostics, ['watchDiagnostics'], {});
    var generatedAge = ageMinutes(activeItem.generatedAt);
    var stale = currentDateKey === jstDateKey() && generatedAge !== null && generatedAge > STALE_MINUTES;

    content.innerHTML = renderChartCard() +
      '<div class="card full"><h2>銘柄一覧（タップでチャート）</h2>' + renderChartSymbolList(activeItem) + '</div>' +
      '<div class="card"><h2>通知概要</h2><div class="kv">' +
      '<div class="k">marketDate</div><div class="v">' + escapeHtml(activeItem.marketDate || '---') + '</div>' +
      '<div class="k">generatedAt</div><div class="v">' + escapeHtml(formatJst(activeItem.generatedAt)) + (generatedAge !== null ? '（' + generatedAge + '分前）' : '') + '</div>' +
      '<div class="k">データ鮮度</div><div class="v"><span class="badge ' + (stale ? 'bad' : 'good') + '">' + (stale ? '古い可能性あり' : '確認済み') + '</span></div>' +
      '<div class="k">Focus</div><div class="v">' + escapeHtml(activeItem.focusCount || 0) + '件</div>' +
      '<div class="k">Watch</div><div class="v">' + escapeHtml(activeItem.watchCount || 0) + '件</div>' +
      '<div class="k">ENTRY</div><div class="v">' + asList(activeItem.entryCandidates).length + '件</div></div></div>' +
      '<div class="card"><h2>短文通知</h2><pre>' + escapeHtml(activeItem.shortNotificationText || '') + '</pre></div>' +
      '<div class="card"><h2>ENTRY不成立理由</h2>' + renderReasonRows(getPath(entryDiagnostics, ['reasonCounts'], {})) +
      '<h3>Focus除外・不足理由</h3>' + renderReasonRows(getPath(focusDiagnostics, ['reasonCounts'], {})) + '</div>' +
      '<div class="card"><h2>注目テーマ</h2>' + renderChips(activeItem.themes) +
      '<h3>重要材料</h3>' + renderChips(activeItem.importantMaterials) +
      '<h3>注意点</h3>' + renderChips(activeItem.cautions) + '</div>' +
      '<div class="card"><h2>データ取得状態</h2><div class="kv">' +
      '<div class="k">scanTarget</div><div class="v">' + escapeHtml(dataStatus.scanTargetCount == null ? '---' : dataStatus.scanTargetCount) + '</div>' +
      '<div class="k">success / failed</div><div class="v">' + escapeHtml(dataStatus.priceFetchSuccessCount == null ? '---' : dataStatus.priceFetchSuccessCount) + ' / ' + escapeHtml(dataStatus.priceFetchFailedCount == null ? '---' : dataStatus.priceFetchFailedCount) + '</div>' +
      '<div class="k">hourlyEvaluated</div><div class="v">' + escapeHtml(dataStatus.hourlyEvaluatedCount == null ? '---' : dataStatus.hourlyEvaluatedCount) + '</div>' +
      '<div class="k">scanOnly</div><div class="v">' + escapeHtml(dataStatus.scanOnlyCount == null ? '---' : dataStatus.scanOnlyCount) + '</div></div></div>' +
      '<div class="card"><h2>前回通知からの変化</h2><div class="kv">' +
      '<div class="k">Watch重複率</div><div class="v">' + escapeHtml(typeof watchDiagnostics.watchOverlapRate === 'number' ? watchDiagnostics.watchOverlapRate.toFixed(1) + '%' : '---') + '</div>' +
      '<div class="k">新規Watch</div><div class="v">' + escapeHtml(watchDiagnostics.newWatchCount == null ? '---' : watchDiagnostics.newWatchCount) + '</div>' +
      '<div class="k">Focus昇格</div><div class="v">' + escapeHtml(watchDiagnostics.promotedToFocusCount == null ? '---' : watchDiagnostics.promotedToFocusCount) + '</div></div></div>' +
      '<div class="card full"><h2>重要ニュース</h2>' + renderNews(activeItem.importantNews || currentData.importantNews) + '</div>' +
      '<div class="card full"><h2>次の時間帯への引き継ぎ</h2><div class="v">' + escapeHtml(activeItem.handoffToNextSession || '---') + '</div></div>';

    bindChartSelection();

    var closeButton = byId('closeChartBtn');
    if(closeButton){
      closeButton.onclick = function(){
        selectedChart = { code: '', name: '', scroll: false };
        render();
      };
    }

    if(selectedChart.code){
      loadSelectedChart();
      var card = byId('chartCard');
      if(card && selectedChart.scroll){
        selectedChart.scroll = false;
        setTimeout(function(){
          try{ card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          catch(error){ card.scrollIntoView(true); }
        }, 0);
      }
    }
  }

  function setAutoRefresh(enabled){
    autoRefreshEnabled = enabled;
    var button = byId('refreshBtn');
    button.textContent = '自動更新 60秒: ' + (enabled ? 'ON' : 'OFF');
    button.className = enabled ? 'good' : 'warn';
    if(autoRefreshTimer){
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    if(enabled){
      autoRefreshTimer = setInterval(function(){
        loadDate(byId('dateInput').value || jstDateKey(), true, true);
      }, AUTO_REFRESH_MS);
    }
  }

  byId('todayBtn').onclick = function(){
    var key = jstDateKey();
    byId('dateInput').value = key;
    selectedChart = { code: '', name: '', scroll: false };
    loadDate(key, false, false);
  };
  byId('yesterdayBtn').onclick = function(){
    var key = addDays(jstDateKey(), -1);
    byId('dateInput').value = key;
    selectedChart = { code: '', name: '', scroll: false };
    loadDate(key, false, false);
  };
  byId('loadBtn').onclick = function(){
    selectedChart = { code: '', name: '', scroll: false };
    loadDate(byId('dateInput').value || jstDateKey(), false, false);
  };
  byId('refreshBtn').onclick = function(){ setAutoRefresh(!autoRefreshEnabled); };

  var initialDate = jstDateKey();
  byId('dateInput').value = initialDate;
  setAutoRefresh(true);
  loadDate(initialDate, false, false);
})();
