const SLOT_ORDER = [
  ["morning", "朝"],
  ["midday", "昼"],
  ["evening", "夕"],
  ["night", "夜"]
];
const AUTO_REFRESH_MS = 60 * 1000;
const STALE_MINUTES = 180;
const NOTIFIED_STORAGE_KEY = "radar_notification_viewer_last_notified_v2";
let currentData = null;
let activeSlot = "morning";
let currentDateKey = "";
let autoRefreshEnabled = true;
let autoRefreshTimer = null;
let lastSuccessfulLoadAt = null;
let lastLoadedReportKey = "";

function jstDateKey(date = new Date()){
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0,10);
}

function addDays(dateKey, days){
  const d = new Date(`${dateKey}T00:00:00+09:00`);
  d.setDate(d.getDate() + days);
  return jstDateKey(d);
}

function escapeHtml(value){
  return String(value ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}

function asList(value){
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function storageGet(key){
  try{ return localStorage.getItem(key) || ""; }
  catch(err){ return ""; }
}

function storageSet(key,value){
  try{ localStorage.setItem(key,value); }
  catch(err){ console.warn("localStorage error",err); }
}

function parseDate(value){
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function formatJst(value){
  const d = parseDate(value);
  if(!d) return "---";
  return new Intl.DateTimeFormat("ja-JP",{
    timeZone:"Asia/Tokyo",
    year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",second:"2-digit"
  }).format(d);
}

function ageMinutes(value){
  const d = parseDate(value);
  if(!d) return null;
  return Math.max(0,Math.floor((Date.now()-d.getTime())/60000));
}

function newestSlotKey(reports){
  const candidates = SLOT_ORDER
    .map(([key]) => ({key,item:reports?.[key]}))
    .filter(entry => entry.item)
    .sort((a,b) => {
      const at = parseDate(a.item.generatedAt)?.getTime() || 0;
      const bt = parseDate(b.item.generatedAt)?.getTime() || 0;
      return bt-at;
    });
  return candidates[0]?.key || "morning";
}

function latestReportKey(data){
  const reports = data?.reports || {};
  const key = newestSlotKey(reports);
  const item = reports[key];
  return item ? `${key}|${item.runId || ""}|${item.generatedAt || ""}` : "";
}

function chips(items){
  const source = asList(items);
  if(!source.length) return '<span class="chip">---</span>';
  return `<div class="chips">${source.map(item => {
    if(item && typeof item === "object"){
      const label = [item.symbol,item.name,item.severity,item.title || item.summary || item.reason]
        .filter(Boolean).join(" | ");
      return `<span class="chip">${escapeHtml(label || JSON.stringify(item))}</span>`;
    }
    return `<span class="chip">${escapeHtml(item)}</span>`;
  }).join("")}</div>`;
}

function symbolRows(items, emptyText="該当銘柄はありません。"){
  const source = asList(items);
  if(!source.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<div class="symbol-list">${source.map((item,index) => {
    if(item && typeof item === "object"){
      const main = [item.symbol || item.code,item.name].filter(Boolean).join(" ") || JSON.stringify(item);
      const sub = [item.reason,item.signal,item.theme,item.missingConditions?.join(" / ")].filter(Boolean).join("｜");
      return `<div class="symbol-row"><div><div class="symbol-main">${escapeHtml(main)}</div>${sub ? `<div class="symbol-sub">${escapeHtml(sub)}</div>` : ""}</div><div class="count-pill">${index+1}</div></div>`;
    }
    return `<div class="symbol-row"><div class="symbol-main">${escapeHtml(item)}</div><div class="count-pill">${index+1}</div></div>`;
  }).join("")}</div>`;
}

function reasonRows(reasonCounts){
  if(!reasonCounts || typeof reasonCounts !== "object") return '<p class="muted">理由データはありません。</p>';
  const rows = Object.entries(reasonCounts).sort((a,b) => Number(b[1]||0)-Number(a[1]||0));
  if(!rows.length) return '<p class="muted">理由データはありません。</p>';
  return `<div class="symbol-list">${rows.map(([reason,count]) => `<div class="symbol-row"><div class="symbol-main">${escapeHtml(reason)}</div><div class="count-pill">${escapeHtml(count)}</div></div>`).join("")}</div>`;
}

function renderNewsList(items){
  const source = asList(items);
  if(!source.length) return '<p class="muted">重要ニュースはありません。</p>';
  return `<div class="news-list">${source.map(item => {
    const title = item && typeof item === "object" ? item.title || item.summary || "---" : item;
    const themes = item && typeof item === "object" && Array.isArray(item.themes) ? item.themes.join(" / ") : "";
    const tickers = item && typeof item === "object" && Array.isArray(item.relatedTickers) ? item.relatedTickers.join(" / ") : "";
    const sources = item && typeof item === "object" && Array.isArray(item.sources) ? item.sources.join(" / ") : (item?.source || "");
    const url = item && typeof item === "object" ? item.url || "" : "";
    return `<article class="news-item">
      <div><strong>${escapeHtml(title)}</strong></div>
      <div class="kv compact">
        <div class="k">severity</div><div class="v">${escapeHtml(item?.severity || "---")}</div>
        <div class="k">category</div><div class="v">${escapeHtml(item?.category || "---")}</div>
        <div class="k">themes</div><div class="v">${escapeHtml(themes || "---")}</div>
        <div class="k">relatedTickers</div><div class="v">${escapeHtml(tickers || "---")}</div>
        <div class="k">source</div><div class="v">${escapeHtml(sources || "---")}</div>
        <div class="k">publishedAt</div><div class="v">${escapeHtml(item?.publishedAt || "---")}</div>
      </div>
      <p>${escapeHtml(item?.summary || "")}</p>
      <p>${escapeHtml(item?.impact || "")}</p>
      ${url ? `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener">ニュースを開く</a></p>` : ""}
    </article>`;
  }).join("")}</div>`;
}

function renderNewsFetchStatus(newsFetch){
  if(!newsFetch || typeof newsFetch !== "object") return '<p class="muted">取得状態はありません。</p>';
  const sources = Array.isArray(newsFetch.sources) ? newsFetch.sources : [];
  const warnings = Array.isArray(newsFetch.warnings) ? newsFetch.warnings : [];
  const errors = Array.isArray(newsFetch.errors) ? newsFetch.errors : [];
  return `<div class="kv">
    <div class="k">status</div><div class="v">${escapeHtml(newsFetch.status || "---")}</div>
    <div class="k">ready</div><div class="v">${escapeHtml(newsFetch.ready ?? "---")}</div>
    <div class="k">fetchedAt</div><div class="v">${escapeHtml(newsFetch.fetchedAt || "---")}</div>
    <div class="k">sources</div><div class="v">${escapeHtml(sources.map(src => `${src.name}:${src.status}(${src.count ?? 0})`).join(" / ") || "---")}</div>
    <div class="k">warnings</div><div class="v">${escapeHtml(warnings.join(" / ") || "---")}</div>
    <div class="k">errors</div><div class="v">${escapeHtml(errors.join(" / ") || "---")}</div>
  </div>`;
}

function updateNotificationButton(){
  const btn = document.getElementById("notificationBtn");
  if(!("Notification" in window)){
    btn.textContent = "画面表示中通知: 非対応";
    btn.disabled = true;
    return;
  }
  if(Notification.permission === "granted"){
    btn.textContent = "画面表示中通知: ON";
    btn.className = "good";
  }else if(Notification.permission === "denied"){
    btn.textContent = "画面表示中通知: 拒否済み";
    btn.className = "warn";
  }else{
    btn.textContent = "画面表示中通知を有効化";
    btn.className = "";
  }
}

async function requestBrowserNotification(){
  if(!("Notification" in window)) return;
  try{
    await Notification.requestPermission();
  }catch(err){
    console.warn("Notification permission error",err);
  }
  updateNotificationButton();
}

function notifyIfNewReport(data, previousKey){
  const newKey = latestReportKey(data);
  if(!newKey || !previousKey || newKey === previousKey) return;
  if(!("Notification" in window) || Notification.permission !== "granted") return;
  const reports = data.reports || {};
  const slotKey = newestSlotKey(reports);
  const item = reports[slotKey];
  if(!item) return;
  const label = SLOT_ORDER.find(([key]) => key === slotKey)?.[1] || slotKey;
  const title = `相場レーダー ${label}更新`;
  const body = `Focus ${item.focusCount || 0}件 / Watch ${item.watchCount || 0}件 / ENTRY ${asList(item.entryCandidates).length}件`;
  try{
    new Notification(title,{body,tag:`radar-${item.runId || item.generatedAt || slotKey}`} );
    storageSet(NOTIFIED_STORAGE_KEY,newKey);
  }catch(err){
    console.warn("Notification error",err);
  }
}

function renderStatus(message,type="ok",path=""){
  const status = document.getElementById("status");
  status.className = `status ${type}`;
  const newest = currentData?.reports?.[newestSlotKey(currentData?.reports || {})];
  const newestAge = ageMinutes(newest?.generatedAt);
  const isToday = currentDateKey === jstDateKey();
  const stale = isToday && newestAge !== null && newestAge > STALE_MINUTES;
  const details = [];
  if(path) details.push(`<span class="badge">読込先: ${escapeHtml(path)}</span>`);
  if(lastSuccessfulLoadAt) details.push(`<span class="badge good">最終確認: ${escapeHtml(formatJst(lastSuccessfulLoadAt))}</span>`);
  if(newest?.generatedAt) details.push(`<span class="badge ${stale ? "bad" : "good"}">最新通知: ${escapeHtml(formatJst(newest.generatedAt))}${newestAge !== null ? `（${newestAge}分前）` : ""}</span>`);
  if(currentData?.updatedAt) details.push(`<span class="badge">日別JSON更新: ${escapeHtml(formatJst(currentData.updatedAt))}</span>`);
  if(stale) details.push(`<span class="badge bad">データ鮮度警告</span>`);
  status.innerHTML = `<div class="status-row"><strong>${escapeHtml(message)}</strong><span>${autoRefreshEnabled ? "自動更新ON" : "自動更新OFF"}</span></div>${details.length ? `<div class="status-details">${details.join("")}</div>` : ""}`;
  if(stale && type === "ok") status.className = "status warning";
}
