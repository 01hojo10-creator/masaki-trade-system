async function loadDate(dateKey,{preserveSlot=false,quiet=false}={}){
  currentDateKey = dateKey;
  const pathOnly = `reports/radar-notifications-${dateKey}.json`;
  const path = `${pathOnly}?cb=${Date.now()}`;
  if(!quiet) renderStatus(`${dateKey} を読み込み中`,"ok",pathOnly);
  const previousKey = lastLoadedReportKey || storageGet(NOTIFIED_STORAGE_KEY);
  try{
    const res = await fetch(path,{cache:"no-store"});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const nextData = await res.json();
    const reports = nextData?.reports || {};
    currentData = nextData;
    if(!preserveSlot || !reports[activeSlot]) activeSlot = newestSlotKey(reports);
    lastSuccessfulLoadAt = new Date();
    const nextKey = latestReportKey(nextData);
    notifyIfNewReport(nextData,previousKey);
    lastLoadedReportKey = nextKey;
    if(nextKey) storageSet(NOTIFIED_STORAGE_KEY,nextKey);
    render();
    renderStatus(`${dateKey} の通知履歴を表示中`,"ok",pathOnly);
  }catch(err){
    currentData = null;
    render();
    renderStatus(`${dateKey} の通知履歴を取得できません: ${err.message}`,"error",pathOnly);
  }
}

function render(){
  const summary = document.getElementById("dailySummary");
  const tabs = document.getElementById("slotTabs");
  const grid = document.getElementById("contentGrid");
  if(!currentData){
    summary.textContent = "通知履歴がありません。上の読込先とエラー内容を確認してください。";
    tabs.innerHTML = "";
    grid.innerHTML = "";
    return;
  }
  const isHoliday = !!currentData.isMarketHoliday || currentData.marketMode === "holiday";
  if(isHoliday){
    summary.innerHTML = `
      <div class="holiday-banner">
        <strong>本日は休場日</strong>
        <div>休場理由: ${escapeHtml(currentData.holidayReason || "---")} / 次回営業日: ${escapeHtml(currentData.nextBusinessDate || "---")}</div>
        <div>通常スキャン・ENTRY判断は停止中です。前営業日のFocus / Watchは参考扱いで確認してください。</div>
      </div>
      <div>${escapeHtml(currentData.dailySummary || "休場日モードで通知を確認できます。")}</div>`;
  }else{
    summary.textContent = currentData.dailySummary || "最新時間帯を初期表示します。Focus・Watch・ENTRY間近を確認できます。";
  }

  const reports = currentData.reports || {};
  tabs.innerHTML = SLOT_ORDER.map(([key,label]) => {
    const item = reports[key];
    const countText = item ? `Focus ${item.focusCount || 0} / Watch ${item.watchCount || 0} / ${formatJst(item.generatedAt)}` : "未生成";
    return `<button type="button" class="slot-tab ${activeSlot === key ? "active" : ""}" data-slot="${key}">${label}<span>${escapeHtml(countText)}</span></button>`;
  }).join("");
  tabs.querySelectorAll("[data-slot]").forEach(btn => {
    btn.addEventListener("click",() => {
      activeSlot = btn.dataset.slot;
      render();
      renderStatus(`${currentDateKey} の通知履歴を表示中`,"ok",`reports/radar-notifications-${currentDateKey}.json`);
    });
  });

  const item = reports[activeSlot];
  if(!item){
    grid.innerHTML = `<div class="card"><h2>${escapeHtml(SLOT_ORDER.find(([key]) => key === activeSlot)?.[1] || activeSlot)}</h2><p>この時間帯の通知はまだありません。</p></div>`;
    return;
  }

  const diagnostics = item.diagnostics || {};
  const dataStatus = item.dataStatus || {};
  const itemHoliday = !!item.isMarketHoliday || item.marketMode === "holiday";
  const newsItems = item.holidayImportantNews || item.importantNews || [];
  const entryNearby = diagnostics.entryDiagnostics?.entryNearbySymbols || [];
  const entryReasons = diagnostics.entryDiagnostics?.reasonCounts || {};
  const focusReasons = diagnostics.focusDiagnostics?.reasonCounts || {};
  const generatedAge = ageMinutes(item.generatedAt);
  const activeStale = currentDateKey === jstDateKey() && generatedAge !== null && generatedAge > STALE_MINUTES;

  grid.innerHTML = `
    <div class="card">
      <h2>通知概要</h2>
      <div class="kv">
        <div class="k">marketDate</div><div class="v">${escapeHtml(item.marketDate || "---")}</div>
        <div class="k">generatedAt</div><div class="v">${escapeHtml(formatJst(item.generatedAt))}${generatedAge !== null ? `（${generatedAge}分前）` : ""}</div>
        <div class="k">データ鮮度</div><div class="v">${activeStale ? '<span class="badge bad">古い可能性あり</span>' : '<span class="badge good">確認済み</span>'}</div>
        <div class="k">notificationType</div><div class="v">${escapeHtml(item.notificationType || "---")} / ${escapeHtml(item.notificationLabel || "---")}</div>
        <div class="k">runId</div><div class="v">${escapeHtml(item.runId || "---")}</div>
        <div class="k">marketMode</div><div class="v">${escapeHtml(item.marketMode || (itemHoliday ? "holiday" : "regular"))}</div>
        <div class="k">地合い判断</div><div class="v">${escapeHtml(item.marketRegime || "---")}</div>
        <div class="k">Focus件数</div><div class="v">${escapeHtml(item.focusCount ?? 0)}</div>
        <div class="k">Watch件数</div><div class="v">${escapeHtml(item.watchCount ?? 0)}</div>
        <div class="k">ENTRY候補件数</div><div class="v">${escapeHtml(asList(item.entryCandidates).length)}</div>
      </div>
    </div>
    <div class="card">
      <h2>短文通知</h2>
      <pre>${escapeHtml(item.shortNotificationText || "")}</pre>
    </div>
    <div class="card">
      <h2>Focus銘柄</h2>
      ${symbolRows(item.focusSymbols,"Focus銘柄はありません。")}
    </div>
    <div class="card">
      <h2>Watch銘柄</h2>
      ${symbolRows(item.watchSymbols,"Watch銘柄はありません。")}
    </div>
    <div class="card">
      <h2>ENTRY候補</h2>
      ${symbolRows(item.entryCandidates,"現時点でENTRY成立銘柄はありません。")}
      <h3>ENTRY間近・不足条件</h3>
      ${symbolRows(entryNearby,"ENTRY間近の銘柄情報はありません。")}
    </div>
    <div class="card">
      <h2>ENTRY不成立理由</h2>
      ${reasonRows(entryReasons)}
      <h3>Focus除外・不足理由</h3>
      ${reasonRows(focusReasons)}
    </div>
    <div class="card">
      <h2>注目テーマ</h2>
      ${chips(item.themes)}
      <h3>重要材料</h3>
      ${chips(item.importantMaterials)}
      <h3>注意点</h3>
      ${chips(item.cautions)}
    </div>
    <div class="card">
      <h2>データ取得状態</h2>
      <div class="kv">
        <div class="k">scanTarget</div><div class="v">${escapeHtml(dataStatus.scanTargetCount ?? "---")}</div>
        <div class="k">success / failed</div><div class="v">${escapeHtml(dataStatus.priceFetchSuccessCount ?? "---")} / ${escapeHtml(dataStatus.priceFetchFailedCount ?? "---")}</div>
        <div class="k">hourlyEvaluated</div><div class="v">${escapeHtml(dataStatus.hourlyEvaluatedCount ?? "---")}</div>
        <div class="k">scanOnly</div><div class="v">${escapeHtml(dataStatus.scanOnlyCount ?? "---")}</div>
        <div class="k">freshness</div><div class="v">${escapeHtml(dataStatus.dataFreshnessStatus || "---")}</div>
        <div class="k">source generatedAt</div><div class="v">${escapeHtml(formatJst(dataStatus.generatedAt))}</div>
      </div>
    </div>
    <div class="card full">
      <h2>重要ニュース・材料</h2>
      ${itemHoliday ? `<div class="k">休日重要ニュース</div>` : ""}
      ${renderNewsList(newsItems)}
    </div>
    <div class="card">
      <h2>ニュース取得状態</h2>
      ${renderNewsFetchStatus(item.newsFetch)}
    </div>
    <div class="card">
      <h2>前回通知からの変化</h2>
      <div class="kv">
        <div class="k">Watch重複率</div><div class="v">${escapeHtml(diagnostics.watchDiagnostics?.watchOverlapRate?.toFixed ? diagnostics.watchDiagnostics.watchOverlapRate.toFixed(1)+"%" : "---")}</div>
        <div class="k">新規Watch</div><div class="v">${escapeHtml(diagnostics.watchDiagnostics?.newWatchCount ?? "---")}</div>
        <div class="k">Focus昇格</div><div class="v">${escapeHtml(diagnostics.watchDiagnostics?.promotedToFocusCount ?? "---")}</div>
        <div class="k">停滞理由</div><div class="v">${escapeHtml(diagnostics.watchDiagnostics?.watchStagnationReason || "---")}</div>
      </div>
    </div>
    <div class="card">
      <h2>次の時間帯への引き継ぎ</h2>
      <div class="v">${escapeHtml(item.handoffToNextSession || "---")}</div>
    </div>
    <div class="card">
      <h2>診断レポート</h2>
      <div class="v">${escapeHtml(diagnostics.workflowSummary || "---")}</div>
      <p><a href="chatgpt-radar-report.json" target="_blank" rel="noopener">chatgpt-radar-report.json</a></p>
      <p><a href="verification.json" target="_blank" rel="noopener">verification.json</a></p>
    </div>`;
}

function setAutoRefresh(enabled){
  autoRefreshEnabled = enabled;
  const btn = document.getElementById("autoRefreshBtn");
  btn.textContent = `自動更新 60秒: ${enabled ? "ON" : "OFF"}`;
  btn.className = enabled ? "good" : "warn";
  if(autoRefreshTimer){
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if(enabled){
    autoRefreshTimer = setInterval(() => {
      const key = document.getElementById("dateInput").value || jstDateKey();
      loadDate(key,{preserveSlot:true,quiet:true});
    },AUTO_REFRESH_MS);
  }
  if(currentDateKey){
    renderStatus(`${currentDateKey} の通知履歴を表示中`,currentData ? "ok" : "error",`reports/radar-notifications-${currentDateKey}.json`);
  }
}

document.getElementById("todayBtn").addEventListener("click",() => {
  const key = jstDateKey();
  document.getElementById("dateInput").value = key;
  loadDate(key,{preserveSlot:false});
});
document.getElementById("yesterdayBtn").addEventListener("click",() => {
  const key = addDays(jstDateKey(),-1);
  document.getElementById("dateInput").value = key;
  loadDate(key,{preserveSlot:false});
});
document.getElementById("loadBtn").addEventListener("click",() => {
  const key = document.getElementById("dateInput").value || jstDateKey();
  loadDate(key,{preserveSlot:false});
});
document.getElementById("autoRefreshBtn").addEventListener("click",() => setAutoRefresh(!autoRefreshEnabled));
document.getElementById("notificationBtn").addEventListener("click",requestBrowserNotification);

document.getElementById("dateInput").value = jstDateKey();
updateNotificationButton();
setAutoRefresh(true);
loadDate(jstDateKey(),{preserveSlot:false});
