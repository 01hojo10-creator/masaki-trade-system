from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_SOURCE = BASE_DIR / "latest" / "masaki-radar-latest.json"
DEFAULT_OWNER = "01hojo10-creator"
DEFAULT_REPO = "masaki-trade-system"
DEFAULT_BRANCH = "main"
DEFAULT_TARGET_PATH = "masaki-radar-latest.json"
REQUIRED_CLASSIFICATION_POLICY = "focus_watch_pool_v2_3"
REQUIRED_CANDIDATE_ROUTE_POLICY = "candidate_routes_v2_3"
REQUIRED_AUDIT_SCHEMA = "gate_condition_states_v2_3_short_direction_ui"
DEFAULT_INDEX_PATH = "masaki-radar-index.json"
SNAPSHOT_DIR = "snapshots"
VERIFICATION_JSON_PATH = "verification.json"
VERIFICATION_TEXT_PATH = "verification.txt"
CHATGPT_REPORT_PATH = "chatgpt-radar-report.json"
NOTIFICATION_VIEWER_PATH = "radar_notification_viewer.html"
NOTIFICATION_VIEWER_ASSET_PATHS = (
    "radar_notification_viewer.css",
    "radar_notification_viewer_app.js",
)
NOTIFICATION_REPORT_DIR = "reports"
COMMIT_MESSAGE = "Update masaki radar latest snapshot"

JPX_MARKET_HOLIDAYS_2026 = {
    "2026-01-01": "元日 / JPX休業日",
    "2026-01-02": "JPX休業日",
    "2026-01-03": "JPX休業日",
    "2026-01-12": "成人の日",
    "2026-02-11": "建国記念の日",
    "2026-02-23": "天皇誕生日",
    "2026-03-20": "春分の日",
    "2026-04-29": "昭和の日",
    "2026-05-03": "憲法記念日",
    "2026-05-04": "みどりの日",
    "2026-05-05": "こどもの日",
    "2026-05-06": "振替休日",
    "2026-07-20": "海の日",
    "2026-08-11": "山の日",
    "2026-09-21": "敬老の日",
    "2026-09-22": "国民の休日",
    "2026-09-23": "秋分の日",
    "2026-10-12": "スポーツの日",
    "2026-11-03": "文化の日",
    "2026-11-23": "勤労感謝の日",
    "2026-12-31": "JPX休業日",
}


def load_snapshot(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"Local JSON file not found: {path}")
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate_snapshot(data: dict) -> list[str]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["snapshot must be a JSON object"]

    for key in ("timestamp", "source", "scan", "focus", "watch"):
        if key not in data:
            errors.append(f"missing key: {key}")

    if "scan" in data and not isinstance(data["scan"], dict):
        errors.append("scan must be an object")
    if "focus" in data and not isinstance(data["focus"], list):
        errors.append("focus must be an array")
    if "watch" in data and not isinstance(data["watch"], list):
        errors.append("watch must be an array")

    policy_version = data.get("classificationPolicyVersion")
    if policy_version != REQUIRED_CLASSIFICATION_POLICY:
        errors.append(
            "classificationPolicyVersion must be "
            f"{REQUIRED_CLASSIFICATION_POLICY}; got {policy_version!r}"
        )

    audit = data.get("classificationAudit")
    if not isinstance(audit, dict):
        errors.append("classificationAudit must be an object")
    elif audit.get("policyVersion") != REQUIRED_CLASSIFICATION_POLICY:
        errors.append("classificationAudit.policyVersion does not match required policy")

    scan = data.get("scan") if isinstance(data.get("scan"), dict) else {}
    if int(scan.get("total") or 0) >= 500:
        aggregate = audit.get("aggregate") if isinstance(audit, dict) and isinstance(audit.get("aggregate"), dict) else {}
        if not isinstance(audit, dict) or audit.get("schemaVersion") != REQUIRED_AUDIT_SCHEMA:
            errors.append(f"classificationAudit.schemaVersion must be {REQUIRED_AUDIT_SCHEMA}")
        if not isinstance(aggregate.get("gateStateCounts"), dict):
            errors.append("classificationAudit.aggregate.gateStateCounts must be an object for a full scan")
        candidate_diagnostics = data.get("candidateRouteDiagnostics")
        if not isinstance(candidate_diagnostics, dict):
            errors.append("candidateRouteDiagnostics must be an object for a full scan")
        elif candidate_diagnostics.get("policyVersion") != REQUIRED_CANDIDATE_ROUTE_POLICY:
            errors.append(
                "candidateRouteDiagnostics.policyVersion must be "
                f"{REQUIRED_CANDIDATE_ROUTE_POLICY}"
            )

    return errors


def github_request(method: str, url: str, token: str, payload: dict | None = None) -> tuple[int, dict]:
    body = None
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "masaki-radar-publisher",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(url, data=body, headers=headers, method=method)
    with urlopen(request, timeout=30) as response:
        raw = response.read().decode("utf-8")
        return response.status, json.loads(raw) if raw else {}


def get_existing_sha(owner: str, repo: str, branch: str, target_path: str, token: str) -> str | None:
    encoded_path = quote(target_path, safe="/")
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{encoded_path}?ref={quote(branch)}"
    try:
        _, data = github_request("GET", url, token)
        sha = data.get("sha")
        return sha if isinstance(sha, str) else None
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def get_existing_content(owner: str, repo: str, branch: str, target_path: str, token: str) -> tuple[str, bytes] | None:
    encoded_path = quote(target_path, safe="/")
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{encoded_path}?ref={quote(branch)}"
    try:
        _, data = github_request("GET", url, token)
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    sha = data.get("sha")
    content = data.get("content", "")
    encoding = data.get("encoding", "")
    if not isinstance(sha, str):
        return None
    if not content or encoding != "base64":
        blob_url = f"https://api.github.com/repos/{owner}/{repo}/git/blobs/{quote(sha)}"
        _, blob_data = github_request("GET", blob_url, token)
        content = blob_data.get("content", "")
        encoding = blob_data.get("encoding", "")
    if not content or encoding != "base64":
        return sha, b""
    raw = base64.b64decode(re.sub(r"\s+", "", str(content)))
    return sha, raw


def get_existing_json(owner: str, repo: str, branch: str, target_path: str, token: str) -> dict | None:
    encoded_path = quote(target_path, safe="/")
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{encoded_path}?ref={quote(branch)}"
    try:
        _, data = github_request("GET", url, token)
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    content = data.get("content", "")
    encoding = data.get("encoding", "")
    if not content or encoding != "base64":
        return None
    try:
        parsed = json.loads(base64.b64decode(content).decode("utf-8"))
        return parsed if isinstance(parsed, dict) else None
    except (ValueError, json.JSONDecodeError):
        return None


def upload_content(owner: str, repo: str, branch: str, target_path: str, token: str, content_bytes: bytes) -> dict:
    encoded_path = quote(target_path, safe="/")
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{encoded_path}"
    content = base64.b64encode(content_bytes).decode("ascii")
    existing = get_existing_content(owner, repo, branch, target_path, token)
    sha = existing[0] if existing else None

    if existing and existing[1] == content_bytes:
        return {
            "status": 200,
            "operation": "unchanged",
            "contentPath": target_path,
            "commitSha": f"unchanged:{sha}",
        }

    payload: dict[str, object] = {
        "message": COMMIT_MESSAGE,
        "content": content,
        "branch": branch,
    }
    if sha:
        payload["sha"] = sha

    status, data = github_request("PUT", url, token, payload)
    return {
        "status": status,
        "operation": "update" if sha else "create",
        "contentPath": data.get("content", {}).get("path", target_path),
        "commitSha": data.get("commit", {}).get("sha", ""),
    }


def upload_snapshot(owner: str, repo: str, branch: str, target_path: str, token: str, source_path: Path) -> dict:
    return upload_content(owner, repo, branch, target_path, token, source_path.read_bytes())


def build_snapshot_path(now: datetime) -> str:
    stamp = now.strftime("%Y%m%d-%H%M%S")
    return f"{SNAPSHOT_DIR}/masaki-radar-latest-{stamp}.json"


def build_index(data: dict, latest_path: str, snapshot_path: str, published_at: datetime) -> dict:
    scan = data.get("scan") if isinstance(data, dict) else {}
    focus = data.get("focus") if isinstance(data, dict) else []
    watch = data.get("watch") if isinstance(data, dict) else []
    diagnostics = data.get("diagnostics") if isinstance(data, dict) else {}
    if not isinstance(diagnostics, dict):
        diagnostics = data.get("dynamicWorkflowDiagnostics") if isinstance(data, dict) else {}
    if not isinstance(diagnostics, dict):
        diagnostics = {}
    data_integrity = diagnostics.get("dataIntegrity", {})
    if not isinstance(data_integrity, dict):
        data_integrity = {}
    run_id = (
        str(data.get("runId") or "").strip()
        or str(diagnostics.get("runId") or "").strip()
        or str(data_integrity.get("runId") or "").strip()
    )

    return {
        "publishedAt": published_at.isoformat(timespec="seconds"),
        "latestPath": latest_path,
        "latestSnapshot": snapshot_path,
        "timestamp": data.get("timestamp", "") if isinstance(data, dict) else "",
        "runId": run_id,
        "focusUpdated": scan.get("focusUpdated", "") if isinstance(scan, dict) else "",
        "watchUpdated": scan.get("watchUpdated", "") if isinstance(scan, dict) else "",
        "focusCount": len(focus) if isinstance(focus, list) else 0,
        "watchCount": len(watch) if isinstance(watch, list) else 0,
    }


def now_local() -> datetime:
    return datetime.now().astimezone()


def cache_buster(now: datetime) -> str:
    return now.strftime("%Y%m%d%H%M%S")


def raw_url(owner: str, repo: str, branch: str, path: str, cb: str) -> str:
    encoded = quote(path, safe="/")
    return f"https://raw.githubusercontent.com/{owner}/{repo}/{quote(branch)}/{encoded}?cb={cb}"


def github_contents_url(owner: str, repo: str, branch: str, path: str) -> str:
    encoded = quote(path, safe="/")
    return f"https://api.github.com/repos/{owner}/{repo}/contents/{encoded}?ref={quote(branch)}"


def fetch_github_contents_json(owner: str, repo: str, branch: str, path: str) -> dict:
    request = Request(github_contents_url(owner, repo, branch, path), headers={"User-Agent": "masaki-radar-verifier"})
    with urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    content = re.sub(r"\s+", "", str(payload.get("content") or ""))
    if not content:
        raise ValueError(f"GitHub Contents API missing content: {path}")
    return json.loads(base64.b64decode(content).decode("utf-8"))


def pages_url(owner: str, repo: str, path: str, cb: str) -> str:
    encoded = quote(path, safe="/")
    return f"https://{owner}.github.io/{repo}/{encoded}?cb={cb}"


def normalize_snapshot_path(latest_snapshot: object) -> str:
    snapshot = str(latest_snapshot or "").strip().replace("\\", "/")
    if not snapshot:
        return ""
    if snapshot.startswith(f"{SNAPSHOT_DIR}/"):
        return snapshot
    return f"{SNAPSHOT_DIR}/{snapshot}"


def fetch_public_json(url: str, retries: int = 4, delay_seconds: float = 2.0) -> dict:
    last_error = ""
    for attempt in range(1, retries + 1):
        try:
            request = Request(url, headers={"User-Agent": "masaki-radar-verifier"})
            with urlopen(request, timeout=20) as response:
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                raw = response.read().decode("utf-8")
                return json.loads(raw)
        except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError, RuntimeError) as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            if attempt < retries:
                time.sleep(delay_seconds)
    raise RuntimeError(last_error or f"failed to fetch {url}")


def ensure_snapshot_shape(data: object, label: str) -> None:
    if not isinstance(data, dict):
        raise ValueError(f"{label} is not a JSON object")
    for key in ("timestamp", "scan", "focus", "watch"):
        if key not in data:
            raise ValueError(f"{label} missing key: {key}")
    if not isinstance(data.get("scan"), dict):
        raise ValueError(f"{label}.scan is not an object")
    if not isinstance(data.get("focus"), list):
        raise ValueError(f"{label}.focus is not an array")
    if not isinstance(data.get("watch"), list):
        raise ValueError(f"{label}.watch is not an array")


def same_market_day(value: object, market_date: str) -> bool:
    text = str(value or "").strip()
    if not text:
        return False
    compact = market_date.replace("-", "/")
    if text.startswith(market_date) or text.startswith(compact):
        return True
    match = re.match(r"^(\d{4})/(\d{1,2})/(\d{1,2})", text)
    if match:
        y, m, d = match.groups()
        return f"{int(y):04d}-{int(m):02d}-{int(d):02d}" == market_date
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone().date().isoformat() == market_date
    except ValueError:
        return False


def normalize_market_date(value: object, fallback: datetime) -> str:
    text = str(value or "").strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", text):
        return text
    if re.match(r"^\d{4}/\d{1,2}/\d{1,2}$", text):
        y, m, d = text.split("/")
        return f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return fallback.date().isoformat()


def get_tokyo_market_status(market_date: str) -> dict:
    day = datetime.strptime(market_date, "%Y-%m-%d").date()
    holiday_reason = ""
    if day.weekday() == 5:
        holiday_reason = "土曜日"
    elif day.weekday() == 6:
        holiday_reason = "日曜日"
    elif market_date in JPX_MARKET_HOLIDAYS_2026:
        holiday_reason = JPX_MARKET_HOLIDAYS_2026[market_date]

    next_day = day
    next_business_date = ""
    for _ in range(20):
        next_day += timedelta(days=1)
        key = next_day.isoformat()
        if next_day.weekday() < 5 and key not in JPX_MARKET_HOLIDAYS_2026:
            next_business_date = key
            break

    is_market_holiday = bool(holiday_reason)
    return {
        "isMarketHoliday": is_market_holiday,
        "marketMode": "holiday" if is_market_holiday else "regular",
        "holidayReason": holiday_reason,
        "marketDate": market_date,
        "nextBusinessDate": next_business_date,
    }


def extract_important_news(report: dict, severities: set[str] | None = None) -> list[dict]:
    news = []
    if isinstance(report.get("importantNews"), list):
        news.extend(report.get("importantNews") or [])
    if isinstance(report.get("holidayImportantNews"), list):
        news.extend(report.get("holidayImportantNews") or [])
    selected: list[dict] = []
    seen: set[str] = set()
    for item in news:
        if not isinstance(item, dict):
            continue
        severity = str(item.get("severity") or "LOW").upper()
        if severities and severity not in severities:
            continue
        title = str(item.get("title") or item.get("headline") or "").strip()
        summary = str(item.get("summary") or item.get("memo") or "").strip()
        handoff = str(item.get("handoff") or item.get("nextBusinessDayHandoff") or "").strip()
        key = str(item.get("id") or item.get("url") or title or summary)
        if key in seen:
            continue
        seen.add(key)
        if title or summary:
            selected.append({
                "id": str(item.get("id") or ""),
                "severity": severity,
                "title": title,
                "summary": summary,
                "source": str(item.get("source") or ""),
                "sources": item.get("sources", []),
                "url": str(item.get("url") or ""),
                "publishedAt": str(item.get("publishedAt") or ""),
                "category": str(item.get("category") or ""),
                "themes": item.get("themes", []),
                "relatedTickers": item.get("relatedTickers", []),
                "impact": str(item.get("impact") or ""),
                "handoff": handoff,
                "notify": bool(item.get("notify", severity == "HIGH")),
            })
    return selected


def format_news_line(item: dict) -> str:
    def clean(value: object, limit: int = 90) -> str:
        text = html.unescape(str(value or ""))
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:limit].rstrip() + "..." if len(text) > limit else text
    title = clean(item.get("title") or item.get("summary") or "重要材料")
    summary = clean(item.get("summary") or "", 70)
    return f"{title} - {summary}" if summary and summary != title else title


def build_holiday_short_notification(report: dict, market_date: str) -> str:
    date_text = market_date.replace("-", "/")
    high_news = extract_important_news(report, {"HIGH"})
    news_fetch = report.get("newsFetch") if isinstance(report.get("newsFetch"), dict) else {}
    fetch_note = ""
    if news_fetch and news_fetch.get("status") in {"PARTIAL", "NOT_CONFIGURED"}:
        fetch_note = "ニュース取得は一部未設定ですが、休場日モードは正常です。"
    if high_news:
        material = " / ".join(format_news_line(item) for item in high_news[:3])
        handoff = " / ".join(str(item.get("handoff") or "") for item in high_news if item.get("handoff"))
        if not handoff:
            handoff = str(report.get("nextBusinessDayHandoff") or "翌営業日の寄り付き前に材料影響を再確認してください。")
        return "\n".join([
            f"【相場レーダー｜{date_text} 休場日】",
            "本日は日本株市場が休場です。",
            "通常のFocus / Watch / ENTRY判断は行いません。",
            f"重要材料：{material}",
            f"翌営業日への注意：{handoff}",
            "詳細は本日のレーダーページで確認。",
        ])
    lines = [
        f"【相場レーダー｜{date_text} 休場日】",
        "本日は日本株市場が休場です。",
        "通常のFocus / Watch / ENTRY判断は行いません。",
        "現時点で緊急通知レベルの材料はありません。",
        fetch_note,
        "翌営業日の準備として前営業日のFocus / Watchを確認してください。",
    ]
    return "\n".join(line for line in lines if line)


def build_chatgpt_report(snapshot: dict, source: str | None, index: dict | None, generated_at: datetime) -> dict:
    scan = snapshot.get("scan") if isinstance(snapshot, dict) else {}
    focus = snapshot.get("focus") if isinstance(snapshot, dict) else []
    watch = snapshot.get("watch") if isinstance(snapshot, dict) else []
    snapshot_market_date = str(snapshot.get("marketDate") or "").strip() if isinstance(snapshot, dict) else ""
    market_date = normalize_market_date(snapshot_market_date, generated_at)
    market_status = get_tokyo_market_status(market_date)
    snapshot_holiday = bool(snapshot.get("isMarketHoliday")) if isinstance(snapshot, dict) else False
    is_market_holiday = bool(snapshot_holiday or market_status["isMarketHoliday"])
    market_mode = "holiday" if is_market_holiday else str(snapshot.get("marketMode") or market_status["marketMode"] or "regular")
    holiday_reason = str(snapshot.get("holidayReason") or market_status["holidayReason"] or "")
    next_business_date = str(snapshot.get("nextBusinessDate") or market_status["nextBusinessDate"] or "")
    all_important_news = extract_important_news(snapshot if isinstance(snapshot, dict) else {}, None)
    important_news = [item for item in all_important_news if item.get("severity") == "HIGH" and item.get("notify", True)]
    news_fetch = snapshot.get("newsFetch") if isinstance(snapshot, dict) and isinstance(snapshot.get("newsFetch"), dict) else {}
    focus_updated = scan.get("focusUpdated", "") if isinstance(scan, dict) else ""
    watch_updated = scan.get("watchUpdated", "") if isinstance(scan, dict) else ""
    timestamp = snapshot.get("timestamp", "") if isinstance(snapshot, dict) else ""
    focus_count = len(focus) if isinstance(focus, list) else 0
    watch_count = len(watch) if isinstance(watch, list) else 0
    focus_summary = snapshot.get("focusDirectionSummary") if isinstance(snapshot, dict) and isinstance(snapshot.get("focusDirectionSummary"), dict) else summarize_direction_rows(focus)
    watch_summary = summarize_direction_rows(watch)
    current = scan.get("current", 0) if isinstance(scan, dict) else 0
    total = scan.get("total", 0) if isinstance(scan, dict) else 0
    status = scan.get("status", "") if isinstance(scan, dict) else ""
    diagnostics = snapshot.get("diagnostics") if isinstance(snapshot, dict) else {}
    if not isinstance(diagnostics, dict):
        diagnostics = snapshot.get("dynamicWorkflowDiagnostics") if isinstance(snapshot, dict) else {}
    if not isinstance(diagnostics, dict):
        diagnostics = {}
    data_integrity = diagnostics.get("dataIntegrity", {})
    if not isinstance(data_integrity, dict):
        data_integrity = {}
    run_id = (
        str(snapshot.get("runId") or "").strip()
        or str(diagnostics.get("runId") or "").strip()
        or str(data_integrity.get("runId") or "").strip()
    )
    diagnostics = {
        "ready": bool(diagnostics.get("ready", False)),
        "marketDate": diagnostics.get("marketDate", market_date),
        "generatedAt": diagnostics.get("generatedAt", generated_at.isoformat(timespec="seconds")),
        "runId": run_id,
        "dataIntegrity": data_integrity,
        "focusDiagnostics": diagnostics.get("focusDiagnostics", {}),
        "watchDiagnostics": diagnostics.get("watchDiagnostics", {}),
        "entryDiagnostics": diagnostics.get("entryDiagnostics", {}),
        "workflowSummary": diagnostics.get("workflowSummary", ""),
        "warnings": diagnostics.get("warnings", []),
        "errors": diagnostics.get("errors", []),
        "unchangedCoreLogic": diagnostics.get("unchangedCoreLogic", True),
    }

    fresh = (
        same_market_day(timestamp, market_date)
        and same_market_day(focus_updated, market_date)
        and same_market_day(watch_updated, market_date)
        and focus_count > 0
        and watch_count > 0
    )
    missing_scan_completion = status == "idle_or_not_started" or (str(current) == "0" and str(total) == "0")
    caution = None
    if fresh and missing_scan_completion:
        caution = "scan completion info was not captured but Focus/Watch timestamps are fresh"

    ready = bool(fresh or is_market_holiday)
    return {
        "ready": ready,
        "marketDate": market_date,
        "generatedAt": generated_at.isoformat(timespec="seconds"),
        "runId": run_id,
        "marketMode": market_mode,
        "isMarketHoliday": is_market_holiday,
        "holidayReason": holiday_reason,
        "nextBusinessDate": next_business_date,
        "holidayNewsMode": is_market_holiday,
        "importantNewsCount": len(important_news),
        "importantNews": important_news,
        "holidayImportantNews": all_important_news,
        "newsFetch": news_fetch,
        "holidaySummary": str(snapshot.get("holidaySummary") or diagnostics.get("workflowSummary") or "") if isinstance(snapshot, dict) else "",
        "nextBusinessDayHandoff": str(snapshot.get("nextBusinessDayHandoff") or ""),
        "source": source,
        "publishedAt": index.get("publishedAt", "") if isinstance(index, dict) else "",
        "latestSnapshot": index.get("latestSnapshot", "") if isinstance(index, dict) else "",
        "timestamp": timestamp,
        "scan": {
            "status": status,
            "current": current,
            "total": total,
            "complete": bool(scan.get("complete", False)) if isinstance(scan, dict) else False,
            "focusUpdated": focus_updated,
            "watchUpdated": watch_updated,
        },
        "focus": focus if isinstance(focus, list) else [],
        "watch": watch if isinstance(watch, list) else [],
        "focusDirectionSummary": focus_summary,
        "focusLongCount": focus_summary["focusLongCount"],
        "focusShortCount": focus_summary["focusShortCount"],
        "focusNeutralCount": focus_summary["focusNeutralCount"],
        "focusMarketBias": focus_summary["focusMarketBias"],
        "focusMarketBiasLabel": focus_summary["focusMarketBiasLabel"],
        "watchLongCount": watch_summary["focusLongCount"],
        "watchShortCount": watch_summary["focusShortCount"],
        "watchNeutralCount": watch_summary["focusNeutralCount"],
        "counts": {
            "focus": focus_count,
            "watch": watch_count,
        },
        "diagnostics": diagnostics,
        "caution": caution,
    }


def attach_verification_diagnostics(report: dict, verification: dict, source: str | None) -> dict:
    diagnostics = report.setdefault("diagnostics", {})
    if not isinstance(diagnostics, dict):
      diagnostics = {}
      report["diagnostics"] = diagnostics
    data_integrity = diagnostics.setdefault("dataIntegrity", {})
    if not isinstance(data_integrity, dict):
      data_integrity = {}
      diagnostics["dataIntegrity"] = data_integrity
    data_integrity.update({
        "indexFetchStatus": "OK" if verification.get("indexOk") else "FAILED",
        "snapshotFetchStatus": "OK" if verification.get("snapshotOk") else "FAILED",
        "latestFetchStatus": "OK" if verification.get("latestOk") else "FAILED",
        "chatgptReportFetchStatus": "GENERATED",
        "verificationFetchStatus": "GENERATED",
        "fallbackUsed": source in {"raw_latest", "pages_latest"} or not verification.get("snapshotOk"),
        "dataFreshnessStatus": "PUBLIC_VERIFIED" if verification.get("verified") else "PUBLIC_VERIFY_FAILED",
        "runId": data_integrity.get("runId", diagnostics.get("runId", "")),
    })
    diagnostics["ready"] = bool(diagnostics.get("ready", False)) or bool(verification.get("verified", False))
    diagnostics["warnings"] = diagnostics.get("warnings", [])
    diagnostics["errors"] = diagnostics.get("errors", [])
    if verification.get("error"):
        diagnostics["warnings"] = list(diagnostics["warnings"]) + [str(verification.get("error"))]
    diagnostics["unchangedCoreLogic"] = diagnostics.get("unchangedCoreLogic", True)
    return report


def report_market_date(report: dict, generated_at: datetime) -> str:
    value = str(report.get("marketDate") or "").strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", value):
        return value
    timestamp = str(report.get("timestamp") or "").strip()
    if timestamp:
        try:
            return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone().date().isoformat()
        except ValueError:
            pass
    return generated_at.date().isoformat()


def notification_slot(generated_at: datetime) -> tuple[str, str]:
    minutes = generated_at.hour * 60 + generated_at.minute
    if minutes < 11 * 60 + 30:
        return "morning", "朝"
    if minutes < 15 * 60 + 10:
        return "midday", "昼"
    if minutes < 17 * 60 + 15:
        return "preClose", "\u5f15\u3051\u524d"
    if minutes < 18 * 60:
        return "evening", "夕"
    return "night", "夜"


def compact_symbols(rows: object, limit: int = 8) -> list[str]:
    if not isinstance(rows, list):
        return []
    symbols: list[str] = []
    for row in rows[:limit]:
        if not isinstance(row, dict):
            continue
        code = str(row.get("code") or row.get("symbol") or "").strip()
        name = str(row.get("name") or "").strip()
        if code and name:
            symbols.append(f"{code} {name}")
        elif code:
            symbols.append(code)
    return symbols


def compact_themes(report: dict, limit: int = 5) -> list[str]:
    themes: list[str] = []
    for row in (report.get("focus") if isinstance(report.get("focus"), list) else []):
        if not isinstance(row, dict):
            continue
        theme = str(row.get("theme") or "").strip()
        if theme and theme not in themes:
            themes.append(theme)
        if len(themes) >= limit:
            break
    return themes


def direction_from_row(row: dict) -> str:
    direction = str(row.get("tradeDirection") or "").upper()
    if direction in {"LONG", "SHORT", "NEUTRAL"}:
        return direction
    audit = row.get("classificationAudit") if isinstance(row.get("classificationAudit"), dict) else {}
    direction = str(audit.get("tradeDirection") or "").upper()
    if direction in {"LONG", "SHORT", "NEUTRAL"}:
        return direction
    states = audit.get("conditionStates") if isinstance(audit.get("conditionStates"), dict) else {}
    for key in ("trendAlignment", "completedHourly"):
        state = states.get(key) if isinstance(states.get(key), dict) else {}
        direction = str(state.get("direction") or "").upper()
        if direction in {"LONG", "SHORT"}:
            return direction
    return "NEUTRAL"


def direction_label(direction: str) -> str:
    if direction == "SHORT":
        return "🔴 売り"
    if direction == "LONG":
        return "🟢 買い"
    return "⚪ 中立"


def replace_short_words(text: object) -> str:
    value = str(text or "")
    replacements = {
        "長期線回復待ち": "長期線下で戻り売り監視",
        "押し目買い待ち": "戻り売り待ち",
        "ブレイク待ち": "安値割れ待ち",
        "上値余地": "下値余地",
        "TP上値目標": "下値目標",
        "買いエントリー": "空売りエントリー",
    }
    for before, after in replacements.items():
        value = value.replace(before, after)
    return value


def enrich_direction_row(row: dict, group_label: str) -> dict:
    item = dict(row)
    direction = direction_from_row(item)
    label = direction_label(direction)
    code = str(item.get("code") or item.get("symbol") or "").strip()
    name = str(item.get("name") or "").strip()
    base_entry = str(item.get("displayEntryText") or item.get("entry") or item.get("reason") or "方向確認待ち")
    base_risk = str(item.get("displayRiskText") or item.get("risk") or "")
    base_target = str(item.get("displayTargetText") or item.get("tp") or "")
    if direction == "SHORT":
        entry_text = replace_short_words(base_entry)
        if not any(word in entry_text for word in ("安値割れ", "戻り売り", "下落継続")):
            entry_text = "安値割れ待ち"
        risk_text = replace_short_words(base_risk or "踏み上げ注意 / 戻り高値超えで撤退")
        target_text = replace_short_words(base_target or "下値目標未確定")
        viewer_text = f"方向：{label}"
        prefix = f"{label}{group_label}"
        item["shortTradeCaution"] = "信用売り可否・貸株料・逆日歩・空売り規制は証券会社側で確認"
        item["shortEntryCaution"] = "安値割れ確認待ち / 寄り付き大幅GDは追い売り注意 / 戻りを待って売る / 直近安値割れを確認して売る"
        item["shortExitRuleText"] = "戻り高値超えで撤退"
        item["shortAvailabilityWarning"] = "信用売り可否は証券会社で確認"
        item["comment"] = replace_short_words(item.get("comment") or entry_text)
    elif direction == "LONG":
        entry_text = base_entry or "上抜け待ち"
        risk_text = base_risk or "押し目買い待ち"
        target_text = base_target
        viewer_text = f"方向：{label}"
        prefix = f"{label}{group_label}"
        item.setdefault("shortTradeCaution", "")
        item.setdefault("shortEntryCaution", "")
        item.setdefault("shortExitRuleText", "")
        item.setdefault("shortAvailabilityWarning", "")
    else:
        entry_text = base_entry or "方向確認待ち"
        risk_text = base_risk or "見送り"
        target_text = base_target
        viewer_text = f"方向：{label}"
        prefix = f"{label}{group_label}"
        item.setdefault("shortTradeCaution", "")
        item.setdefault("shortEntryCaution", "")
        item.setdefault("shortExitRuleText", "")
        item.setdefault("shortAvailabilityWarning", "")

    item["tradeDirection"] = direction
    item["directionLabel"] = label
    item["displayEntryText"] = entry_text
    item["displayRiskText"] = risk_text
    item["displayTargetText"] = target_text
    item["displayDirectionBadge"] = label
    item["notificationDirectionText"] = f"{prefix}：{code}{(' ' + name) if name else ''} {entry_text}".strip()
    item["viewerDirectionText"] = viewer_text
    return item


def summarize_direction_rows(rows: object) -> dict:
    items = rows if isinstance(rows, list) else []
    long_count = short_count = neutral_count = 0
    for row in items:
        if not isinstance(row, dict):
            continue
        direction = direction_from_row(row)
        if direction == "SHORT":
            short_count += 1
        elif direction == "LONG":
            long_count += 1
        else:
            neutral_count += 1
    bias = "NONE"
    label = "中立・混在"
    icon = "⚪"
    guidance = "方向は「買い / 中立 / 売り」の3分類です。"
    caution = ""
    if items and short_count > long_count and short_count > neutral_count:
        bias = "SHORT_BIAS"
        label = "売り優勢"
        icon = "🔴"
    elif items and long_count > short_count and long_count > neutral_count:
        bias = "LONG_BIAS"
        label = "買い優勢"
        icon = "🟢"
    elif items:
        bias = "MIXED"
        label = "中立・混在"
    return {
        "title": f"本日の方向：{icon} {label}",
        "countsText": f"買い {long_count} / 中立 {neutral_count} / 売り {short_count}",
        "guidance": guidance,
        "caution": caution,
        "focusMarketBias": bias,
        "focusMarketBiasLabel": label,
        "focusLongCount": long_count,
        "focusShortCount": short_count,
        "focusNeutralCount": neutral_count,
    }


def enrich_direction_display_fields(data: dict) -> dict:
    enriched = dict(data)
    focus = [enrich_direction_row(row, "Focus") if isinstance(row, dict) else row for row in (data.get("focus") if isinstance(data.get("focus"), list) else [])]
    watch = [enrich_direction_row(row, "Watch") if isinstance(row, dict) else row for row in (data.get("watch") if isinstance(data.get("watch"), list) else [])]
    focus_summary = summarize_direction_rows(focus)
    watch_summary = summarize_direction_rows(watch)
    enriched["focus"] = focus
    enriched["watch"] = watch
    enriched["focusDirectionSummary"] = focus_summary
    enriched["focusLongCount"] = focus_summary["focusLongCount"]
    enriched["focusShortCount"] = focus_summary["focusShortCount"]
    enriched["focusNeutralCount"] = focus_summary["focusNeutralCount"]
    enriched["focusMarketBias"] = focus_summary["focusMarketBias"]
    enriched["focusMarketBiasLabel"] = focus_summary["focusMarketBiasLabel"]
    enriched["watchLongCount"] = watch_summary["focusLongCount"]
    enriched["watchShortCount"] = watch_summary["focusShortCount"]
    enriched["watchNeutralCount"] = watch_summary["focusNeutralCount"]
    return enriched


def build_short_notification_text(report: dict, slot_label: str, market_date: str) -> str:
    if report.get("isMarketHoliday") or str(report.get("marketMode") or "").lower() == "holiday":
        return build_holiday_short_notification(report, market_date)
    diagnostics = report.get("diagnostics") if isinstance(report.get("diagnostics"), dict) else {}
    data = diagnostics.get("dataIntegrity", {}) if isinstance(diagnostics.get("dataIntegrity"), dict) else {}
    scan = report.get("scan") if isinstance(report.get("scan"), dict) else {}
    focus = report.get("focus") if isinstance(report.get("focus"), list) else []
    watch = report.get("watch") if isinstance(report.get("watch"), list) else []
    focus_count = len(focus)
    watch_count = len(watch)
    focus_summary = report.get("focusDirectionSummary") if isinstance(report.get("focusDirectionSummary"), dict) else summarize_direction_rows(focus)
    focus_lines = [
        str(row.get("notificationDirectionText") or "").strip()
        for row in focus[:6]
        if isinstance(row, dict) and str(row.get("notificationDirectionText") or "").strip()
    ]
    entry = diagnostics.get("entryDiagnostics", {}) if isinstance(diagnostics.get("entryDiagnostics"), dict) else {}
    entry_go = entry.get("entryGoCount", 0)
    themes = compact_themes(report, 3)
    policy = diagnostics.get("workflowSummary") or "売買条件を変更せず、Focus/Watch/ENTRY不成立理由を確認。"
    market_label = data.get("dataFreshnessStatus") or scan.get("status", "")
    date_text = market_date.replace("-", "/")
    return "\n".join([
        f"【相場レーダー｜{date_text} {slot_label}】",
        f"地合い：{market_label or '確認中'}",
        f"Focus：{focus_count}件",
        f"Watch：{watch_count}件",
        f"本日の方向：{focus_summary.get('focusMarketBiasLabel', '中立・混在')}",
        f"買い {focus_summary.get('focusLongCount', 0)} / 中立 {focus_summary.get('focusNeutralCount', 0)} / 売り {focus_summary.get('focusShortCount', 0)}",
        *(focus_lines[:3] if focus_lines else []),
        f"注目：{', '.join(themes) if themes else '---'}",
        f"ENTRY候補：{entry_go}件",
        f"方針：{policy[:80]}",
        "詳細は本日のレーダーページで確認。",
    ])


def build_notification_entry(report: dict, generated_at: datetime) -> tuple[str, dict]:
    market_date = report_market_date(report, generated_at)
    slot_key, slot_label = notification_slot(generated_at)
    is_market_holiday = bool(report.get("isMarketHoliday") or str(report.get("marketMode") or "").lower() == "holiday")
    diagnostics = report.get("diagnostics") if isinstance(report.get("diagnostics"), dict) else {}
    data = diagnostics.get("dataIntegrity", {}) if isinstance(diagnostics.get("dataIntegrity"), dict) else {}
    entry_diag = diagnostics.get("entryDiagnostics", {}) if isinstance(diagnostics.get("entryDiagnostics"), dict) else {}
    scan = report.get("scan") if isinstance(report.get("scan"), dict) else {}
    focus = report.get("focus") if isinstance(report.get("focus"), list) else []
    watch = report.get("watch") if isinstance(report.get("watch"), list) else []
    focus_summary = report.get("focusDirectionSummary") if isinstance(report.get("focusDirectionSummary"), dict) else summarize_direction_rows(focus)
    watch_summary = summarize_direction_rows(watch)
    all_important_news = extract_important_news(report, None)
    high_news = [item for item in all_important_news if item.get("severity") == "HIGH" and item.get("notify", True)]
    news_fetch = report.get("newsFetch") if isinstance(report.get("newsFetch"), dict) else {}
    warnings = list(diagnostics.get("warnings", [])) if isinstance(diagnostics.get("warnings"), list) else []
    if isinstance(news_fetch.get("warnings"), list):
        warnings.extend(news_fetch.get("warnings", []))
    if report.get("caution"):
        warnings.append(str(report.get("caution")))
    entry = {
        "marketDate": market_date,
        "generatedAt": generated_at.isoformat(timespec="seconds"),
        "notificationType": "holiday" if is_market_holiday else slot_key,
        "notificationLabel": "休場日" if is_market_holiday else slot_label,
        "runId": diagnostics.get("runId") or data.get("runId") or "",
        "marketMode": "holiday" if is_market_holiday else str(report.get("marketMode") or "regular"),
        "isMarketHoliday": is_market_holiday,
        "holidayReason": str(report.get("holidayReason") or ""),
        "nextBusinessDate": str(report.get("nextBusinessDate") or ""),
        "holidayNewsMode": is_market_holiday,
        "importantNewsCount": int(report.get("importantNewsCount") or len(high_news)),
        "importantNews": high_news,
        "holidayImportantNews": all_important_news,
        "newsFetch": news_fetch,
        "holidaySummary": str(report.get("holidaySummary") or diagnostics.get("workflowSummary") or ""),
        "nextBusinessDayHandoff": str(report.get("nextBusinessDayHandoff") or ""),
        "marketRegime": data.get("dataFreshnessStatus") or scan.get("status", ""),
        "focusCount": len(focus),
        "watchCount": len(watch),
        "focusDirectionSummary": focus_summary,
        "focusLongCount": focus_summary["focusLongCount"],
        "focusShortCount": focus_summary["focusShortCount"],
        "focusNeutralCount": focus_summary["focusNeutralCount"],
        "focusMarketBias": focus_summary["focusMarketBias"],
        "focusMarketBiasLabel": focus_summary["focusMarketBiasLabel"],
        "watchLongCount": watch_summary["focusLongCount"],
        "watchShortCount": watch_summary["focusShortCount"],
        "watchNeutralCount": watch_summary["focusNeutralCount"],
        "entryCandidates": entry_diag.get("entryGoSymbols", []) if isinstance(entry_diag, dict) else [],
        "focusSymbols": compact_symbols(focus),
        "watchSymbols": compact_symbols(watch),
        "focusItems": focus[:8],
        "watchItems": watch[:15],
        "focusDirectionTexts": [
            str(row.get("notificationDirectionText") or "").strip()
            for row in focus[:8]
            if isinstance(row, dict) and str(row.get("notificationDirectionText") or "").strip()
        ],
        "themes": compact_themes(report),
        "importantMaterials": compact_themes(report),
        "cautions": warnings[:8],
        "handoffToNextSession": diagnostics.get("workflowSummary", ""),
        "dataStatus": data,
        "diagnostics": diagnostics,
        "shortNotificationText": build_short_notification_text(report, slot_label, market_date),
    }
    return slot_key, entry


def enrich_existing_notification_slots(reports: dict, report: dict) -> dict:
    if not isinstance(reports, dict):
        return {}
    focus = report.get("focus") if isinstance(report.get("focus"), list) else []
    watch = report.get("watch") if isinstance(report.get("watch"), list) else []
    focus_summary = report.get("focusDirectionSummary") if isinstance(report.get("focusDirectionSummary"), dict) else summarize_direction_rows(focus)
    watch_summary = summarize_direction_rows(watch)
    run_id = str(report.get("runId") or report.get("diagnostics", {}).get("runId") or "").strip()
    enriched: dict = {}
    for key, item in reports.items():
        if not isinstance(item, dict):
            enriched[key] = item
            continue
        entry = dict(item)
        entry_run_id = str(entry.get("runId") or "").strip()
        if run_id and entry_run_id == run_id:
            entry.update({
                "focusDirectionSummary": focus_summary,
                "focusLongCount": focus_summary["focusLongCount"],
                "focusShortCount": focus_summary["focusShortCount"],
                "focusNeutralCount": focus_summary["focusNeutralCount"],
                "focusMarketBias": focus_summary["focusMarketBias"],
                "focusMarketBiasLabel": focus_summary["focusMarketBiasLabel"],
                "watchLongCount": watch_summary["focusLongCount"],
                "watchShortCount": watch_summary["focusShortCount"],
                "watchNeutralCount": watch_summary["focusNeutralCount"],
                "focusItems": focus[:8],
                "watchItems": watch[:15],
                "focusDirectionTexts": [
                    str(row.get("notificationDirectionText") or "").strip()
                    for row in focus[:8]
                    if isinstance(row, dict) and str(row.get("notificationDirectionText") or "").strip()
                ],
            })
        enriched[key] = entry
    return enriched


def build_daily_notification_report(report: dict, generated_at: datetime, existing: dict | None = None) -> tuple[str, dict]:
    market_date = report_market_date(report, generated_at)
    slot_key, entry = build_notification_entry(report, generated_at)
    base = existing if isinstance(existing, dict) else {}
    reports = base.get("reports") if isinstance(base.get("reports"), dict) else {}
    reports[slot_key] = entry
    reports = enrich_existing_notification_slots(reports, report)
    ordered = {key: reports.get(key) for key in ("morning", "midday", "preClose", "evening", "night") if reports.get(key)}
    is_market_holiday = bool(report.get("isMarketHoliday") or str(report.get("marketMode") or "").lower() == "holiday")
    all_important_news = extract_important_news(report, None)
    high_news = [item for item in all_important_news if item.get("severity") == "HIGH" and item.get("notify", True)]
    focus_summary = report.get("focusDirectionSummary") if isinstance(report.get("focusDirectionSummary"), dict) else summarize_direction_rows(report.get("focus"))
    daily = {
        "marketDate": market_date,
        "updatedAt": generated_at.isoformat(timespec="seconds"),
        "schemaVersion": "radar_notifications_daily_v1",
        "marketMode": "holiday" if is_market_holiday else str(report.get("marketMode") or "regular"),
        "isMarketHoliday": is_market_holiday,
        "holidayReason": str(report.get("holidayReason") or ""),
        "nextBusinessDate": str(report.get("nextBusinessDate") or ""),
        "holidayNewsMode": is_market_holiday,
        "importantNewsCount": int(report.get("importantNewsCount") or len(high_news)),
        "importantNews": high_news,
        "holidayImportantNews": all_important_news,
        "newsFetch": report.get("newsFetch") if isinstance(report.get("newsFetch"), dict) else {},
        "focusDirectionSummary": focus_summary,
        "focusLongCount": focus_summary["focusLongCount"],
        "focusShortCount": focus_summary["focusShortCount"],
        "focusNeutralCount": focus_summary["focusNeutralCount"],
        "focusMarketBias": focus_summary["focusMarketBias"],
        "focusMarketBiasLabel": focus_summary["focusMarketBiasLabel"],
        "reports": ordered,
        "dailySummary": build_daily_summary(ordered),
        "nextBusinessDayHandoff": build_next_business_day_handoff(ordered),
    }
    return f"{NOTIFICATION_REPORT_DIR}/radar-notifications-{market_date}.json", daily


def build_daily_summary(reports: dict) -> str:
    if not reports:
        return ""
    latest = next(reversed(reports.values()))
    if latest.get("isMarketHoliday"):
        reason = str(latest.get("holidayReason") or "市場休業日")
        next_date = str(latest.get("nextBusinessDate") or "")
        return f"本日は休場日です（{reason}）。通常スキャン・ENTRY判断は停止中です。次回営業日: {next_date}"
    focus = latest.get("focusCount", 0)
    watch = latest.get("watchCount", 0)
    bias = str(latest.get("focusMarketBiasLabel") or "中立・混在")
    short_count = int(latest.get("focusShortCount") or 0)
    long_count = int(latest.get("focusLongCount") or 0)
    neutral_count = int(latest.get("focusNeutralCount") or 0)
    handoff = str(latest.get("handoffToNextSession") or "")
    return f"最新通知ではFocus {focus}件、Watch {watch}件です。本日の方向: {bias} / 買い {long_count} / 中立 {neutral_count} / 売り {short_count}。{handoff[:120]}"


def build_next_business_day_handoff(reports: dict) -> str:
    if not reports:
        return ""
    night = reports.get("night")
    latest = night or next(reversed(reports.values()))
    if latest.get("isMarketHoliday"):
        return str(latest.get("nextBusinessDayHandoff") or latest.get("handoffToNextSession") or latest.get("shortNotificationText") or "")
    return str(latest.get("handoffToNextSession") or latest.get("shortNotificationText") or "")


def build_failure_verification(verified_at: datetime, error: str) -> dict:
    return {
        "verifiedAt": verified_at.isoformat(timespec="seconds"),
        "verified": False,
        "source": None,
        "indexOk": False,
        "snapshotOk": False,
        "latestOk": False,
        "pagesOk": False,
        "publishedAt": "",
        "latestSnapshot": "",
        "timestamp": "",
        "scanStatus": "",
        "scanCurrent": 0,
        "scanTotal": 0,
        "scanComplete": False,
        "focusUpdated": "",
        "watchUpdated": "",
        "focusCount": 0,
        "watchCount": 0,
        "error": error,
    }


def verify_public_outputs(owner: str, repo: str, branch: str, latest_path: str, index_path: str, verified_at: datetime, expected_index: dict | None = None) -> tuple[dict, dict, str]:
    cb = cache_buster(verified_at)
    index_ok = False
    snapshot_ok = False
    latest_ok = False
    pages_ok = False
    errors: list[str] = []
    source = None
    index: dict | None = None
    chosen_snapshot: dict | None = None
    expected_snapshot = normalize_snapshot_path(expected_index.get("latestSnapshot")) if isinstance(expected_index, dict) else ""

    try:
        last_index_error: Exception | None = None
        for attempt in range(3):
            try:
                index = fetch_public_json(raw_url(owner, repo, branch, index_path, f"{cb}-{attempt}"))
                if not isinstance(index, dict):
                    raise ValueError("masaki-radar-index.json is not a JSON object")
                latest_snapshot = normalize_snapshot_path(index.get("latestSnapshot"))
                if not latest_snapshot:
                    raise ValueError("masaki-radar-index.json missing latestSnapshot")
                index["latestSnapshot"] = latest_snapshot
                if expected_snapshot and latest_snapshot != expected_snapshot:
                    raise ValueError(f"masaki-radar-index.json is stale: expected {expected_snapshot}, got {latest_snapshot}")
                index_ok = True
                break
            except Exception as exc:
                last_index_error = exc
                if attempt < 2:
                    time.sleep(5)
        if not index_ok:
            try:
                index = fetch_github_contents_json(owner, repo, branch, index_path)
                if not isinstance(index, dict):
                    raise ValueError("masaki-radar-index.json is not a JSON object")
                latest_snapshot = normalize_snapshot_path(index.get("latestSnapshot"))
                if not latest_snapshot:
                    raise ValueError("masaki-radar-index.json missing latestSnapshot")
                index["latestSnapshot"] = latest_snapshot
                if expected_snapshot and latest_snapshot != expected_snapshot:
                    raise ValueError(f"masaki-radar-index.json is stale in Contents API: expected {expected_snapshot}, got {latest_snapshot}")
                index_ok = True
            except Exception as contents_exc:
                if last_index_error:
                    raise last_index_error
                raise contents_exc
    except Exception as exc:
        errors.append(f"index check failed: {exc}")

    if index_ok and index:
        try:
            snapshot = fetch_public_json(raw_url(owner, repo, branch, index["latestSnapshot"], cb))
            ensure_snapshot_shape(snapshot, "latestSnapshot")
            snapshot_ok = True
            chosen_snapshot = snapshot
            source = "raw_snapshot"
        except Exception as exc:
            errors.append(f"snapshot check failed: {exc}")

    try:
        latest = fetch_public_json(raw_url(owner, repo, branch, latest_path, cb))
        ensure_snapshot_shape(latest, "masaki-radar-latest.json")
        latest_ok = True
        if chosen_snapshot is None:
            chosen_snapshot = latest
            source = "raw_latest"
    except Exception as exc:
        errors.append(f"latest check failed: {exc}")

    try:
        pages = fetch_public_json(pages_url(owner, repo, latest_path, cb))
        ensure_snapshot_shape(pages, "GitHub Pages latest")
        pages_ok = True
        if chosen_snapshot is None:
            chosen_snapshot = pages
            source = "pages_latest"
    except Exception as exc:
        errors.append(f"pages check failed: {exc}")

    if chosen_snapshot is None:
        error = "; ".join(errors) or "no public snapshot could be verified"
        verification = build_failure_verification(verified_at, error)
        report = build_chatgpt_report({"scan": {}, "focus": [], "watch": [], "timestamp": ""}, None, expected_index or index, verified_at)
        report = attach_verification_diagnostics(report, verification, None)
        return verification, report, error

    report_index = index if index_ok else expected_index or index
    scan = chosen_snapshot.get("scan") if isinstance(chosen_snapshot, dict) else {}
    focus = chosen_snapshot.get("focus") if isinstance(chosen_snapshot, dict) else []
    watch = chosen_snapshot.get("watch") if isinstance(chosen_snapshot, dict) else []
    verification = {
        "verifiedAt": verified_at.isoformat(timespec="seconds"),
        "verified": bool(snapshot_ok or latest_ok or pages_ok),
        "source": source,
        "indexOk": index_ok,
        "snapshotOk": snapshot_ok,
        "latestOk": latest_ok,
        "pagesOk": pages_ok,
        "publishedAt": report_index.get("publishedAt", "") if isinstance(report_index, dict) else "",
        "latestSnapshot": report_index.get("latestSnapshot", "") if isinstance(report_index, dict) else "",
        "timestamp": chosen_snapshot.get("timestamp", "") if isinstance(chosen_snapshot, dict) else "",
        "scanStatus": scan.get("status", "") if isinstance(scan, dict) else "",
        "scanCurrent": scan.get("current", 0) if isinstance(scan, dict) else 0,
        "scanTotal": scan.get("total", 0) if isinstance(scan, dict) else 0,
        "scanComplete": bool(scan.get("complete", False)) if isinstance(scan, dict) else False,
        "focusUpdated": scan.get("focusUpdated", "") if isinstance(scan, dict) else "",
        "watchUpdated": scan.get("watchUpdated", "") if isinstance(scan, dict) else "",
        "focusCount": len(focus) if isinstance(focus, list) else 0,
        "watchCount": len(watch) if isinstance(watch, list) else 0,
        "error": "; ".join(errors) if errors else None,
    }
    report = build_chatgpt_report(chosen_snapshot, source, report_index, verified_at)
    report = attach_verification_diagnostics(report, verification, source)
    return verification, report, verification["error"] or ""


def build_verification_text(verification: dict) -> str:
    verified_at = str(verification.get("verifiedAt", ""))
    try:
        dt = datetime.fromisoformat(verified_at)
        verified_at_text = dt.strftime("%Y-%m-%d %H:%M:%S %Z").strip() or verified_at
    except ValueError:
        verified_at_text = verified_at
    error = verification.get("error") or "none"
    return "\n".join([
        f"LAST VERIFIED: {verified_at_text}",
        f"VERIFIED: {str(bool(verification.get('verified'))).lower()}",
        f"SOURCE: {verification.get('source') or ''}",
        f"INDEX OK: {str(bool(verification.get('indexOk'))).lower()}",
        f"SNAPSHOT OK: {str(bool(verification.get('snapshotOk'))).lower()}",
        f"LATEST OK: {str(bool(verification.get('latestOk'))).lower()}",
        f"PAGES OK: {str(bool(verification.get('pagesOk'))).lower()}",
        f"PUBLISHED AT: {verification.get('publishedAt', '')}",
        f"LATEST SNAPSHOT: {verification.get('latestSnapshot', '')}",
        f"TIMESTAMP: {verification.get('timestamp', '')}",
        f"SCAN: {verification.get('scanStatus', '')} {verification.get('scanCurrent', 0)}/{verification.get('scanTotal', 0)}",
        f"FOCUS UPDATED: {verification.get('focusUpdated', '')}",
        f"WATCH UPDATED: {verification.get('watchUpdated', '')}",
        f"FOCUS COUNT: {verification.get('focusCount', 0)}",
        f"WATCH COUNT: {verification.get('watchCount', 0)}",
        f"ERROR: {error}",
        "",
    ])


def json_bytes(data: dict) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")



def parse_yyyy_mm_dd(value: object):
    text = str(value or "").strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", text):
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None


def snapshot_run_id(snapshot: dict) -> str:
    if not isinstance(snapshot, dict):
        return ""
    diagnostics = snapshot.get("diagnostics") if isinstance(snapshot.get("diagnostics"), dict) else {}
    data_integrity = diagnostics.get("dataIntegrity") if isinstance(diagnostics.get("dataIntegrity"), dict) else {}
    return (
        str(snapshot.get("runId") or "").strip()
        or str(diagnostics.get("runId") or "").strip()
        or str(data_integrity.get("runId") or "").strip()
    )


def count_entry_valid_rows(rows: object) -> int:
    if not isinstance(rows, list):
        return 0
    count = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        action = str(row.get("finalAction") or row.get("entryStatus") or "")
        if "ENTRY_VALID" in action:
            count += 1
    return count


def count_all_entry_valid(snapshot: dict) -> int:
    if not isinstance(snapshot, dict):
        return 0
    return count_entry_valid_rows(snapshot.get("focus")) + count_entry_valid_rows(snapshot.get("watch"))


def read_json_for_guard(path: Path) -> tuple[dict | None, str | None]:
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None, "json_root_not_object"
        return data, None
    except FileNotFoundError:
        return None, "missing"
    except json.JSONDecodeError as exc:
        return None, f"parse_ng:{exc}"
    except OSError as exc:
        return None, f"read_error:{exc}"


def fetch_public_json_for_guard(owner: str, repo: str, path: str) -> tuple[dict | None, str | None, int | None]:
    encoded_path = quote(path, safe="/")
    url = f"https://{owner}.github.io/{repo}/{encoded_path}?v={int(time.time())}"
    request = Request(
        url,
        headers={
            "Cache-Control": "no-cache",
            "User-Agent": "masaki-radar-publisher-preflight",
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw), None, response.status
    except HTTPError as exc:
        return None, f"http_{exc.code}", exc.code
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        return None, f"fetch_or_parse_ng:{exc}", None


def local_daily_candidates(daily_path: str) -> list[Path]:
    relative = Path(*daily_path.split("/"))
    return [BASE_DIR / relative, BASE_DIR.parent / relative]


def find_existing_daily_path(daily_path: str) -> Path | None:
    for candidate in local_daily_candidates(daily_path):
        if candidate.exists():
            return candidate
    return None


def guard_count(value: object) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def run_preflight_guard(
    args: argparse.Namespace,
    data: dict,
    publish_time: datetime,
    token_present: bool,
    validation_errors: list[str],
) -> dict:
    source_run_id = snapshot_run_id(data)
    source_market_date = str(data.get("marketDate") or "").strip() if isinstance(data, dict) else ""
    source_date = parse_yyyy_mm_dd(source_market_date)
    focus = data.get("focus") if isinstance(data, dict) else []
    watch = data.get("watch") if isinstance(data, dict) else []
    focus_count = len(focus) if isinstance(focus, list) else 0
    watch_count = len(watch) if isinstance(watch, list) else 0
    entry_valid_count = count_all_entry_valid(data)

    block_reasons: list[str] = []
    warnings: list[str] = []
    public_market_date = ""
    daily_notification_path = ""
    lock_target_run_id = ""

    if validation_errors:
        block_reasons.append("source_latest_validation_failed")

    restore_mode = bool(getattr(args, "allow_latest_valid_market_date", False))
    today = publish_time.date()
    days_behind = (today - source_date).days if source_date else None

    if not token_present:
        block_reasons.append("github_token_missing")

    if not source_run_id:
        block_reasons.append("source_runId_missing")
    if not source_date:
        block_reasons.append("source_marketDate_invalid_or_missing")
    elif source_market_date == "2026-06-24":
        block_reasons.append("source_marketDate_is_known_stale_2026-06-24")
    elif source_date < today:
        if restore_mode and days_behind is not None and days_behind <= 1:
            warnings.append("restore_allows_latest_valid_marketDate")
        else:
            block_reasons.append("source_marketDate_too_old")
    elif source_date > today:
        block_reasons.append("source_marketDate_future")

    if focus_count <= 0 or watch_count <= 0:
        block_reasons.append("focus_watch_count_abnormal")

    lock_path = BASE_DIR / ".radar_publish_lock.json"
    lock, lock_error = read_json_for_guard(lock_path)
    if lock_error:
        block_reasons.append(f"publish_lock_parse_ng:{lock_error}")
    else:
        lock_target_run_id = str(lock.get("targetRunId") or "").strip()
        if not lock_target_run_id:
            block_reasons.append("publish_lock_targetRunId_missing")
        elif source_run_id and source_run_id != lock_target_run_id:
            block_reasons.append("source_runId_mismatch_publish_lock")

    public_chatgpt, public_error, _ = fetch_public_json_for_guard(args.owner, args.repo, CHATGPT_REPORT_PATH)
    if public_error:
        block_reasons.append(f"public_chatgpt_fetch_or_parse_ng:{public_error}")
    elif isinstance(public_chatgpt, dict):
        public_market_date = str(public_chatgpt.get("marketDate") or "").strip()
        public_date = parse_yyyy_mm_dd(public_market_date)
        if source_date and public_date and source_date <= public_date:
            block_reasons.append("would_not_advance_public_chatgpt_marketDate")
        elif public_market_date and not public_date:
            block_reasons.append("public_chatgpt_marketDate_invalid")

    try:
        preflight_report = build_chatgpt_report(data, str(args.source), None, publish_time)
        daily_notification_path, _ = build_daily_notification_report(preflight_report, publish_time)
    except Exception as exc:
        block_reasons.append(f"dailyNotificationPath_build_failed:{exc}")

    if not daily_notification_path:
        block_reasons.append("dailyNotificationPath_missing")
    else:
        daily_path = find_existing_daily_path(daily_notification_path)
        if not daily_path:
            block_reasons.append("dailyNotificationPath_missing")
        else:
            daily_json, daily_error = read_json_for_guard(daily_path)
            if daily_error:
                block_reasons.append(f"dailyNotificationPath_json_parse_ng:{daily_error}")
            elif isinstance(daily_json, dict):
                daily_market_date = str(daily_json.get("marketDate") or "").strip()
                if daily_market_date != source_market_date:
                    block_reasons.append("daily_marketDate_mismatch_source")
                reports = daily_json.get("reports")
                if not isinstance(reports, dict) or not reports:
                    block_reasons.append("daily_reports_missing")
                else:
                    slot_order = ("morning", "midday", "preClose", "evening", "night")
                    present_slots = [slot for slot in slot_order if isinstance(reports.get(slot), dict)]
                    if not present_slots:
                        block_reasons.append("daily_reports_required_slots_missing")
                    else:
                        latest_slot = present_slots[-1]
                        latest_entry = reports.get(latest_slot)
                        latest_run_id = str(latest_entry.get("runId") or "").strip() if isinstance(latest_entry, dict) else ""
                        if source_run_id and latest_run_id and latest_run_id != source_run_id:
                            block_reasons.append("latest_daily_slot_runId_mismatch_source")
                        for slot in present_slots:
                            entry = reports.get(slot)
                            slot_focus = guard_count(entry.get("focusCount") if isinstance(entry, dict) else None)
                            slot_watch = guard_count(entry.get("watchCount") if isinstance(entry, dict) else None)
                            if slot_focus is None or slot_watch is None:
                                block_reasons.append(f"daily_{slot}_focus_watch_count_missing")
                            elif slot_focus <= 0 or slot_watch <= 0:
                                block_reasons.append(f"daily_{slot}_focus_watch_count_abnormal")
                    expected_slot, _ = notification_slot(publish_time)
                    if expected_slot not in reports:
                        warnings.append(f"expected_slot_missing:{expected_slot}")

    allow = not block_reasons
    decision = "ALLOW_RECOVERY" if allow and restore_mode and source_date and source_date < today else ("ALLOW" if allow else "BLOCK")

    return {
        "allow": allow,
        "decision": decision,
        "restoreMode": restore_mode,
        "blockReasons": block_reasons,
        "warnings": warnings,
        "sourceRunId": source_run_id,
        "lockTargetRunId": lock_target_run_id,
        "sourceMarketDate": source_market_date,
        "publicMarketDate": public_market_date,
        "dailyNotificationPath": daily_notification_path,
        "FocusCount": focus_count,
        "WatchCount": watch_count,
        "ENTRY_VALIDCount": entry_valid_count,
        "tokenPresent": token_present,
    }


def print_preflight_guard(guard: dict) -> None:
    block_reasons = guard.get("blockReasons") if isinstance(guard.get("blockReasons"), list) else []
    warnings = guard.get("warnings") if isinstance(guard.get("warnings"), list) else []
    print("Preflight stale publish guard")
    print(f"publishDecision={guard.get('decision') or ('ALLOW' if guard.get('allow') else 'BLOCK')}")
    print(f"restoreMode={'true' if guard.get('restoreMode') else 'false'}")
    print(f"blockReason={';'.join(block_reasons) if block_reasons else 'none'}")
    for warning in warnings:
        print(f"preflightWarning={warning}")
    print(f"sourceRunId={guard.get('sourceRunId', '')}")
    print(f"lockTargetRunId={guard.get('lockTargetRunId', '')}")
    print(f"sourceMarketDate={guard.get('sourceMarketDate', '')}")
    print(f"publicMarketDate={guard.get('publicMarketDate', '')}")
    print(f"dailyNotificationPath={guard.get('dailyNotificationPath', '')}")
    print(f"FocusCount={guard.get('FocusCount', '')}")
    print(f"WatchCount={guard.get('WatchCount', '')}")
    print(f"ENTRY_VALIDCount={guard.get('ENTRY_VALIDCount', '')}")
    print(f"GITHUB_TOKEN={'PRESENT' if guard.get('tokenPresent') else 'MISSING'}")


def print_summary(args: argparse.Namespace, data: dict, errors: list[str], token_present: bool) -> None:
    focus = data.get("focus") if isinstance(data, dict) else []
    watch = data.get("watch") if isinstance(data, dict) else []
    scan = data.get("scan") if isinstance(data, dict) else {}
    pages_url = f"https://{args.owner}.github.io/{args.repo}/{args.target_path}"
    index_url = f"https://{args.owner}.github.io/{args.repo}/{DEFAULT_INDEX_PATH}"

    print("Masaki Radar GitHub publisher check")
    print(f"Local JSON: {args.source}")
    print(f"Upload target: {args.owner}/{args.repo}@{args.branch}:{args.target_path}")
    print(f"Expected Pages URL: {pages_url}")
    print(f"Expected index URL: {index_url}")
    print(f"GITHUB_TOKEN={'PRESENT' if token_present else 'MISSING'}")
    print(f"Dry run: {'yes' if args.dry_run else 'no'}")
    print(f"timestamp: {data.get('timestamp', '') if isinstance(data, dict) else ''}")
    print(f"source: {data.get('source', '') if isinstance(data, dict) else ''}")
    print(f"scan.status: {scan.get('status', '') if isinstance(scan, dict) else ''}")
    print(f"focus count: {len(focus) if isinstance(focus, list) else 'invalid'}")
    print(f"watch count: {len(watch) if isinstance(watch, list) else 'invalid'}")

    if errors:
        print("Validation: failed")
        for error in errors:
            print(f"- {error}")
    else:
        print("Validation: ok")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Publish Masaki radar latest JSON to GitHub Contents API.")
    parser.add_argument("--dry-run", action="store_true", help="Validate local JSON and print target without GitHub API calls.")
    parser.add_argument("--allow-latest-valid-market-date", action="store_true", help="Manual restore only: allow the latest valid previous-day marketDate when guard checks pass.")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help="Local masaki-radar-latest.json path.")
    parser.add_argument("--owner", default=os.environ.get("GITHUB_OWNER", DEFAULT_OWNER), help="GitHub owner.")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPO", DEFAULT_REPO), help="GitHub repository.")
    parser.add_argument("--branch", default=os.environ.get("GITHUB_BRANCH", DEFAULT_BRANCH), help="GitHub branch.")
    parser.add_argument("--target-path", default=os.environ.get("GITHUB_TARGET_PATH", DEFAULT_TARGET_PATH), help="Target path in repository.")
    return parser



def build_restore_verification(data: dict, latest_path: str, index_path: str, daily_path: str, verified_at: datetime) -> dict:
    scan = data.get("scan") if isinstance(data, dict) else {}
    focus = data.get("focus") if isinstance(data, dict) else []
    watch = data.get("watch") if isinstance(data, dict) else []
    return {
        "verifiedAt": verified_at.isoformat(timespec="seconds"),
        "verified": True,
        "source": "manual_restore_latest_valid_market_date",
        "indexOk": True,
        "snapshotOk": True,
        "latestOk": True,
        "pagesOk": True,
        "latestPath": latest_path,
        "latestSnapshot": latest_path,
        "indexPath": index_path,
        "dailyNotificationPath": daily_path,
        "marketDate": str(data.get("marketDate") or ""),
        "runId": snapshot_run_id(data),
        "timestamp": data.get("timestamp", "") if isinstance(data, dict) else "",
        "scanStatus": scan.get("status", "") if isinstance(scan, dict) else "",
        "focusCount": len(focus) if isinstance(focus, list) else 0,
        "watchCount": len(watch) if isinstance(watch, list) else 0,
        "ENTRY_VALIDCount": count_all_entry_valid(data),
        "error": "",
    }


def publish_restore_json_only(args: argparse.Namespace, data: dict, token: str, publish_time: datetime) -> int:
    source_bytes = args.source.read_bytes()
    source_json, source_error = read_json_for_guard(args.source)
    if source_error or not isinstance(source_json, dict):
        print(f"Result: restore upload blocked. source latest parse NG: {source_error}")
        return 1

    chatgpt_path = BASE_DIR / CHATGPT_REPORT_PATH
    chatgpt_json, chatgpt_error = read_json_for_guard(chatgpt_path)
    if chatgpt_error or not isinstance(chatgpt_json, dict):
        print(f"Result: restore upload blocked. chatgpt report parse NG: {chatgpt_error}")
        return 1

    source_market_date = str(source_json.get("marketDate") or "")
    source_run_id = snapshot_run_id(source_json)
    chatgpt_run_id = str(chatgpt_json.get("runId") or "")
    if str(chatgpt_json.get("marketDate") or "") != source_market_date or chatgpt_run_id != source_run_id:
        print("Result: restore upload blocked. chatgpt report does not match source latest.")
        return 1

    daily_path = str(chatgpt_json.get("dailyNotificationPath") or "").strip()
    if not daily_path:
        try:
            daily_path, _ = build_daily_notification_report(chatgpt_json, publish_time)
        except Exception as exc:
            print(f"Result: restore upload blocked. dailyNotificationPath build failed: {exc}")
            return 1
    daily_local_path = find_existing_daily_path(daily_path)
    if not daily_local_path:
        print("Result: restore upload blocked. daily notification JSON is missing.")
        return 1
    daily_json, daily_error = read_json_for_guard(daily_local_path)
    if daily_error or not isinstance(daily_json, dict):
        print(f"Result: restore upload blocked. daily notification parse NG: {daily_error}")
        return 1
    if str(daily_json.get("marketDate") or "") != source_market_date:
        print("Result: restore upload blocked. daily notification marketDate mismatch.")
        return 1

    index = build_index(source_json, args.target_path, args.target_path, publish_time)
    verification = build_restore_verification(source_json, args.target_path, DEFAULT_INDEX_PATH, daily_path, publish_time)
    uploads = [
        (args.target_path, source_bytes),
        (CHATGPT_REPORT_PATH, json_bytes(chatgpt_json)),
        (DEFAULT_INDEX_PATH, json_bytes(index)),
        (VERIFICATION_JSON_PATH, json_bytes(verification)),
        (daily_path, daily_local_path.read_bytes()),
    ]

    results: list[dict] = []
    try:
        for target_path, content_bytes in uploads:
            results.append(upload_content(args.owner, args.repo, args.branch, target_path, token, content_bytes))
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        print(f"Result: restore JSON-only upload failed without exposing token. {exc}")
        return 1

    print("Result: restore JSON-only upload succeeded.")
    for result in results:
        print(f"publishedJson={result['contentPath']} operation={result['operation']} commitSha={result['commitSha']}")
    return 0

def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    args.allow_latest_valid_market_date = bool(
        args.allow_latest_valid_market_date or os.environ.get("RADAR_ALLOW_LATEST_VALID_MARKET_DATE") == "1"
    )
    args.source = Path(args.source).resolve()

    try:
        data = load_snapshot(args.source)
    except (OSError, json.JSONDecodeError) as exc:
        print("Masaki Radar GitHub publisher check")
        print(f"Local JSON: {args.source}")
        print(f"Validation: failed - {exc}")
        print("Preflight stale publish guard")
        print("publishDecision=BLOCK")
        print(f"blockReason=source_latest_parse_ng:{exc}")
        return 1

    publish_time = now_local()
    try:
        from market_news_fetcher import enrich_snapshot_with_news
        data = enrich_snapshot_with_news(data, BASE_DIR, publish_time)
    except Exception as exc:
        data = dict(data)
        data["newsFetch"] = {
            "ready": False,
            "status": "PARTIAL",
            "fetchedAt": publish_time.isoformat(timespec="seconds"),
            "sources": [],
            "errors": [],
            "warnings": [f"news fetch skipped: {exc}"],
        }
        data.setdefault("importantNews", [])
        data.setdefault("holidayImportantNews", [])

    data = enrich_direction_display_fields(data)
    errors = validate_snapshot(data)
    token = os.environ.get("GITHUB_TOKEN", "")
    token_present = bool(token.strip())
    snapshot_path = build_snapshot_path(publish_time)
    index_path = DEFAULT_INDEX_PATH
    print_summary(args, data, errors, token_present)
    news_fetch = data.get("newsFetch") if isinstance(data.get("newsFetch"), dict) else {}
    if news_fetch:
        print(f"News fetch status: {news_fetch.get('status', '')}")
        print(f"News fetch ready: {str(bool(news_fetch.get('ready'))).lower()}")
        print(f"Important news count: {len(data.get('importantNews') if isinstance(data.get('importantNews'), list) else [])}")
    print(f"Snapshot target: {snapshot_path}")
    print(f"Index target: {index_path}")
    print(f"Verification target: {VERIFICATION_JSON_PATH}")
    print(f"ChatGPT report target: {CHATGPT_REPORT_PATH}")
    print(f"Notification viewer target: {NOTIFICATION_VIEWER_PATH}")

    guard = run_preflight_guard(args, data, publish_time, token_present, errors)
    print_preflight_guard(guard)
    if not guard["allow"]:
        return 1

    if errors:
        return 1

    if args.dry_run:
        print("Result: dry-run only. No GitHub API request was sent.")
        return 0

    if not token_present:
        print("Result: GITHUB_TOKEN is not set. Upload skipped safely.")
        return 0

    if args.allow_latest_valid_market_date:
        return publish_restore_json_only(args, data, token, publish_time)

    snapshot_bytes = json_bytes(data)
    try:
        args.source.write_bytes(snapshot_bytes)
    except OSError as exc:
        print(f"Local enriched JSON write skipped: {exc}")

    try:
        latest_result = upload_content(args.owner, args.repo, args.branch, args.target_path, token, snapshot_bytes)
        snapshot_result = upload_content(args.owner, args.repo, args.branch, snapshot_path, token, snapshot_bytes)
        index = build_index(data, args.target_path, snapshot_path, publish_time)
        index_bytes = json_bytes(index)
        index_result = upload_content(args.owner, args.repo, args.branch, index_path, token, index_bytes)
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        print(f"Result: upload failed without exposing token. {exc}")
        return 1

    verification_time = now_local()
    verification, chatgpt_report, verification_error = verify_public_outputs(
        args.owner,
        args.repo,
        args.branch,
        args.target_path,
        index_path,
        verification_time,
        index,
    )
    verification_bytes = json_bytes(verification)
    verification_text_bytes = build_verification_text(verification).encode("utf-8")
    daily_notification_path = ""
    daily_notification_bytes = b""
    daily_notification_result = None
    viewer_results: list[tuple[str, dict | None]] = []
    try:
        daily_notification_path, empty_daily = build_daily_notification_report(chatgpt_report, verification_time)
        existing_daily = get_existing_json(args.owner, args.repo, args.branch, daily_notification_path, token)
        _, daily_notification = build_daily_notification_report(chatgpt_report, verification_time, existing_daily or empty_daily)
        slot_key, latest_notification = build_notification_entry(chatgpt_report, verification_time)
        chatgpt_report["notificationType"] = slot_key
        chatgpt_report["notificationLabel"] = latest_notification.get("notificationLabel", "")
        chatgpt_report["shortNotificationText"] = latest_notification.get("shortNotificationText", "")
        chatgpt_report["dailyNotificationPath"] = daily_notification_path
        daily_notification_bytes = json_bytes(daily_notification)
    except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"Notification daily report merge skipped: {exc}")
    chatgpt_report_bytes = json_bytes(chatgpt_report)

    try:
        (BASE_DIR / VERIFICATION_JSON_PATH).write_bytes(verification_bytes)
        (BASE_DIR / CHATGPT_REPORT_PATH).write_bytes(chatgpt_report_bytes)
        (BASE_DIR / VERIFICATION_TEXT_PATH).write_bytes(verification_text_bytes)
        if daily_notification_path and daily_notification_bytes:
            daily_local_path = BASE_DIR / daily_notification_path
            daily_local_path.parent.mkdir(parents=True, exist_ok=True)
            daily_local_path.write_bytes(daily_notification_bytes)
            viewer_daily_local_path = BASE_DIR.parent / daily_notification_path
            viewer_daily_local_path.parent.mkdir(parents=True, exist_ok=True)
            viewer_daily_local_path.write_bytes(daily_notification_bytes)
        verification_result = upload_content(args.owner, args.repo, args.branch, VERIFICATION_JSON_PATH, token, verification_bytes)
        verification_text_result = upload_content(args.owner, args.repo, args.branch, VERIFICATION_TEXT_PATH, token, verification_text_bytes)
        chatgpt_report_result = upload_content(args.owner, args.repo, args.branch, CHATGPT_REPORT_PATH, token, chatgpt_report_bytes)
        if daily_notification_path and daily_notification_bytes:
            daily_notification_result = upload_content(args.owner, args.repo, args.branch, daily_notification_path, token, daily_notification_bytes)
        viewer_publish_paths = (NOTIFICATION_VIEWER_PATH,) + NOTIFICATION_VIEWER_ASSET_PATHS
        for viewer_target_path in viewer_publish_paths:
            viewer_path = BASE_DIR.parent / viewer_target_path
            if viewer_path.exists():
                result = upload_content(args.owner, args.repo, args.branch, viewer_target_path, token, viewer_path.read_bytes())
                viewer_results.append((viewer_target_path, result))
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        print(f"Result: verification file upload failed without exposing token. {exc}")
        return 1

    print("Result: upload succeeded.")
    for label, result in (
        ("latest", latest_result),
        ("snapshot", snapshot_result),
        ("index", index_result),
        ("verification", verification_result),
        ("verification text", verification_text_result),
        ("chatgpt report", chatgpt_report_result),
        ("daily notification", daily_notification_result),
        *[(f"notification viewer {path}", result) for path, result in viewer_results],
    ):
        if result is None:
            continue
        print(f"{label} operation: {result['operation']}")
        print(f"{label} content path: {result['contentPath']}")
        print(f"{label} commit sha: {result['commitSha']}")
    print(f"Verification: {'ok' if verification.get('verified') else 'failed'}")
    print(f"ChatGPT report ready: {str(bool(chatgpt_report.get('ready'))).lower()}")
    print(f"Verification source: {verification.get('source') or ''}")
    print(f"Verification error: {verification_error or 'none'}")
    print(f"Verification URL: {raw_url(args.owner, args.repo, args.branch, VERIFICATION_JSON_PATH, cache_buster(verification_time))}")
    print(f"ChatGPT report URL: {raw_url(args.owner, args.repo, args.branch, CHATGPT_REPORT_PATH, cache_buster(verification_time))}")
    if daily_notification_path:
        print(f"Daily notification URL: {raw_url(args.owner, args.repo, args.branch, daily_notification_path, cache_buster(verification_time))}")
    print(f"Notification viewer URL: https://{args.owner}.github.io/{args.repo}/{NOTIFICATION_VIEWER_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
