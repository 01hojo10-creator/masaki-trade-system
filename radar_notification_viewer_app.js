(function(){
  'use strict';

  var SLOT_ORDER = [
    ['morning', '朝'],
    ['midday', '昼'],
    ['evening', '夕'],
    ['night', '夜']
  ];
  var AUTO_REFRESH_MS = 60000;
  var VIEWER_VERSION = '20260623-9';

  var currentData = null;
  var activeSlot = 'morning';
  var currentDateKey = '';
  var autoRefreshEnabled = true;
  var autoRefreshTimer = null;
  var lastLoadedAt = null;

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

  function tradingViewUrl(code){
    return 'https://jp.tradingview.com/chart/?symbol=' + encodeURIComponent('TSE:' + code) + '&interval=60';
  }

  function renderStatus(message, type, path){
    var status = byId('status');
    var badges = [];
    if(path) badges.push('<span class="badge">読込先: ' + escapeHtml(path) + '</span>');
    badges.push('<span class="badge good">Viewer ' + VIEWER_VERSION + '</span>');
    badges.push('<span class="badge good">TradingView直結</span>');
    if(lastLoadedAt) badges.push('<span class="badge">最終確認: ' + escapeHtml(formatJst(lastLoadedAt)) + '</span>');
    if(currentData && currentData.updatedAt) badges.push('<span class="badge">JSON更新: ' + escapeHtml(formatJst(currentData.updatedAt)) + '</span>');
    status.className = 'status ' + type;
    status.innerHTML = '<div class="status-top"><strong>' + escapeHtml(message) + '</strong><span>' +
      (autoRefreshEnabled ? '自動更新ON' : '自動更新OFF') + '</span></div>' +
      '<div class="badges">' + badges.join('') + '</div>';
  }

  function extractEntry(raw, statusLabel){
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

  function collectUniqueSymbols(item){
    var ordered = [];
    var map = {};

    function addGroup(items, statusLabel){
      var list = asList(items);
      var i;
      var j;
      for(i = 0; i < list.length; i += 1){
        var entry = extractEntry(list[i], statusLabel);
        if(!entry) continue;
        var existing = map[entry.code];
        if(!existing){
          map[entry.code] = entry;
          ordered.push(entry);
        }else{
          if(!existing.name && entry.name) existing.name = entry.name;
          if(existing.statuses.indexOf(statusLabel) === -1) existing.statuses.push(statusLabel);
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

  function renderSymbolList(item){
    var symbols = collectUniqueSymbols(item);
    if(!symbols.length) return '<p class="muted">対象銘柄はありません。</p>';

    var html = [];
    var i;
    for(i = 0; i < symbols.length; i += 1){
      var symbol = symbols[i];
      var detail = symbol.statuses.join(' / ');
      if(symbol.details.length) detail += ' | ' + symbol.details.join(' | ');
      html.push(
        '<a class="row clickable" href="' + escapeHtml(tradingViewUrl(symbol.code)) + '" target="_blank" rel="noopener noreferrer">' +
        '<div><div class="row-main">' + escapeHtml(symbol.code + (symbol.name ? ' ' + symbol.name : '')) + '</div>' +
        '<div class="row-sub">' + escapeHtml(detail) + '</div></div>' +
        '<div class="num">TV</div></a>'
      );
    }
    return '<div class="list" id="symbolList">' + html.join('') + '</div>';
  }

  function collectMarketNews(activeItem){
    var source = []
      .concat(asList(currentData && currentData.importantNews))
      .concat(asList(currentData && currentData.holidayImportantNews))
      .concat(asList(activeItem && activeItem.importantNews));
    var seenIds = {};
    var seenUrls = {};
    var seenTitles = {};
    var unique = [];
    var i;

    for(i = 0; i < source.length; i += 1){
      var item = source[i] && typeof source[i] === 'object' ? source[i] : null;
      if(!item) continue;
      var id = String(item.id || '').trim();
      var url = String(item.url || '').trim();
      var title = String(item.title || '').trim();
      if((id && seenIds[id]) || (url && seenUrls[url]) || (title && seenTitles[title])) continue;
      if(id) seenIds[id] = true;
      if(url) seenUrls[url] = true;
      if(title) seenTitles[title] = true;
      unique.push(item);
    }

    var severityOrder = {HIGH: 0, MEDIUM: 1, LOW: 2};
    unique.sort(function(a, b){
      var aDate = parseDate(a.publishedAt);
      var bDate = parseDate(b.publishedAt);
      var timeDifference = (bDate ? bDate.getTime() : 0) - (aDate ? aDate.getTime() : 0);
      if(timeDifference) return timeDifference;
      return (severityOrder[String(a.severity || '').toUpperCase()] ?? 9) -
        (severityOrder[String(b.severity || '').toUpperCase()] ?? 9);
    });
    return {items: unique, inputCount: source.length, duplicateCount: source.length - unique.length};
  }

  function newsSources(item){
    var values = [];
    if(item.source) values.push(String(item.source));
    var sources = asList(item.sources);
    var i;
    for(i = 0; i < sources.length; i += 1){
      if(values.indexOf(String(sources[i])) === -1) values.push(String(sources[i]));
    }
    return values.join(' / ') || '---';
  }

  function renderNewsCard(item){
    var severity = String(item.severity || 'LOW').toUpperCase();
    var related = asList(item.relatedTickers);
    var tickerHtml = related.length
      ? related.map(function(ticker){ return '<span class="news-ticker">' + escapeHtml(ticker) + '</span>'; }).join('')
      : '<span class="muted">なし</span>';
    var link = item.url
      ? '<a class="news-link" href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener noreferrer">記事を開く</a>'
      : '';

    return '<article class="news-card severity-' + escapeHtml(severity.toLowerCase()) + '">' +
      '<div class="news-meta"><span class="severity-badge">' + escapeHtml(severity) + '</span>' +
      '<time>' + escapeHtml(formatJst(item.publishedAt)) + '</time></div>' +
      '<h3>' + escapeHtml(item.title || '見出しなし') + '</h3>' +
      '<dl class="news-facts"><div><dt>分類</dt><dd>' + escapeHtml(item.category || '---') + '</dd></div>' +
      '<div><dt>出典</dt><dd>' + escapeHtml(newsSources(item)) + '</dd></div></dl>' +
      '<div class="news-copy"><strong>要約</strong><p>' + escapeHtml(item.summary || '---') + '</p></div>' +
      '<div class="news-copy impact"><strong>相場への影響</strong><p>' + escapeHtml(item.impact || '---') + '</p></div>' +
      '<div class="news-related"><strong>関連銘柄</strong><div class="news-tickers">' + tickerHtml + '</div></div>' +
      link + '</article>';
  }

  function renderMarketNews(activeItem){
    var result = collectMarketNews(activeItem);
    if(!result.items.length){
      return '<section class="news-section full" id="marketNews" data-news-count="0" data-duplicate-count="0">' +
        '<div class="section-head"><h2>相場関連ニュース</h2><span>0件</span></div>' +
        '<p class="muted">現在、表示できる相場関連ニュースはありません。</p></section>';
    }
    return '<section class="news-section full" id="marketNews" data-news-count="' + result.items.length +
      '" data-duplicate-count="' + result.duplicateCount + '">' +
      '<div class="section-head"><h2>相場関連ニュース</h2><span>' + result.items.length + '件</span></div>' +
      '<div class="news-grid">' + result.items.map(renderNewsCard).join('') + '</div></section>';
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

  function loadDate(dateKey, preserveSlot, quiet, fallbackDateKey){
    currentDateKey = dateKey;
    var path = 'reports/radar-notifications-' + dateKey + '.json';
    if(!quiet) renderStatus(dateKey + ' を読み込み中', 'ok', path);

    requestJson(path + '?cb=' + Date.now(), function(nextData){
      currentData = nextData || {};
      byId('dateInput').value = dateKey;
      var reports = currentData.reports || {};
      if(!preserveSlot || !reports[activeSlot]) activeSlot = newestSlotKey(reports);
      lastLoadedAt = new Date();
      render();
      renderStatus(dateKey + ' の通知履歴を表示中', 'ok', path);
    }, function(message){
      if(fallbackDateKey && fallbackDateKey !== dateKey){
        renderStatus(dateKey + ' は未生成のため ' + fallbackDateKey + ' を表示します', 'warning', path);
        loadDate(fallbackDateKey, false, true, '');
        return;
      }
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

    var reports = currentData.reports || {};
    summary.textContent = currentData.dailySummary || '銘柄をタップするとTradingViewの60分足を別タブで開きます。';

    var tabHtml = [];
    var i;
    for(i = 0; i < SLOT_ORDER.length; i += 1){
      var key = SLOT_ORDER[i][0];
      var item = reports[key];
      var sub = item ? 'Focus ' + (item.focusCount || 0) + ' / Watch ' + (item.watchCount || 0) + ' / ' + formatJst(item.generatedAt) : '未生成';
      tabHtml.push('<button type="button" class="tab ' + (activeSlot === key ? 'active' : '') + '" data-slot="' + key + '"><strong>' + SLOT_ORDER[i][1] + '</strong><span>' + escapeHtml(sub) + '</span></button>');
    }
    tabs.innerHTML = tabHtml.join('');

    var tabButtons = tabs.getElementsByTagName('button');
    for(i = 0; i < tabButtons.length; i += 1){
      tabButtons[i].onclick = function(){
        activeSlot = this.getAttribute('data-slot');
        render();
        renderStatus(currentDateKey + ' の通知履歴を表示中', 'ok', 'reports/radar-notifications-' + currentDateKey + '.json');
      };
    }

    var activeItem = reports[activeSlot];
    if(!activeItem){
      content.innerHTML = '<div class="card"><h2>' + escapeHtml(slotLabel(activeSlot)) + '</h2><p>この時間帯の通知はまだありません。</p></div>';
      return;
    }

    content.innerHTML =
      '<div class="card full"><h2>銘柄一覧（タップでTradingViewを開く）</h2>' + renderSymbolList(activeItem) + '</div>' +
      renderMarketNews(activeItem);
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
        var today = jstDateKey();
        var fallback = currentDateKey && currentDateKey !== today ? currentDateKey : addDays(today, -1);
        loadDate(today, true, true, fallback);
      }, AUTO_REFRESH_MS);
    }
  }

  byId('todayBtn').onclick = function(){
    var key = jstDateKey();
    byId('dateInput').value = key;
    loadDate(key, false, false);
  };

  byId('yesterdayBtn').onclick = function(){
    var key = addDays(jstDateKey(), -1);
    byId('dateInput').value = key;
    loadDate(key, false, false);
  };

  byId('loadBtn').onclick = function(){
    loadDate(byId('dateInput').value || jstDateKey(), false, false);
  };

  byId('refreshBtn').onclick = function(){
    setAutoRefresh(!autoRefreshEnabled);
  };

  var initialDate = jstDateKey();
  byId('dateInput').value = initialDate;
  setAutoRefresh(true);
  loadDate(initialDate, false, false, addDays(initialDate, -1));
})();
