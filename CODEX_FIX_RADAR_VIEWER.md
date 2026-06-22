# Codex修正依頼：相場レーダー通知ビューアーの公開版を安定化

## 現象
- GitHubリポジトリ上の `radar_notification_viewer.html` と `radar_notification_viewer_app.js` は Viewer `20260622-7`。
- 実際のGitHub Pages画面では `Viewer 20260622-5` と `TradingView直結 v6` が表示され、読み込み中から進まない。
- つまり、公開ページが現行mainの内容と一致していない、またはPC側の自動公開処理が旧版を再投入している可能性が高い。

## ゴール
1. 通知ビューがPC・スマホの両方で確実に読み込める。
2. 画面上部に `Viewer 20260622-8` と表示される。
3. 銘柄一覧は1か所のみ。
4. 同じ銘柄コードは1回だけ表示する。
5. 初期状態でチャートは表示しない。
6. 銘柄をタップすると、TradingViewの該当日本株を別タブで直接開く。
7. 7309を押した場合のURLは、必ず `symbol=TSE%3A7309` を含む。
8. Yahooチャート、TradingView埋め込み、Appleなどの代替銘柄表示は使用しない。
9. 売買条件・Focus/Watch/ENTRY判定ロジックは変更しない。

## 最優先の監査
### A. 公開元・上書き元の特定
Windows PC上で以下を検索する。
- `radar_notification_viewer.html`
- `radar_notification_viewer_app.js`
- `radar_tradingview_open_fix.js`
- 文字列 `Viewer 20260622-5`
- 文字列 `TradingView直結 v6`
- 文字列 `radar_notification_viewer`

検索対象：
- `C:\Users\01hoj\OneDrive\デスクトップ\新しいフォルダー`
- `masaki-radar-bridge`
- GitHubローカルクローン
- PowerShell / Python / bat / cmd / yaml / json
- WindowsタスクスケジューラのActionとStart in

旧版HTML/JSをコピーまたは生成しているスクリプトを特定する。推測で削除しない。

### B. GitHub Pages配信元の確認
- Pagesのsource branchとfolderを確認する。
- main root以外（gh-pages、docs等）を配信していないか確認する。
- `radar_notification_viewer.html` の公開URLが、どのcommitの内容か確認する。
- 公開HTMLが読み込むJSのURLとレスポンス本文をNetworkで確認する。
- Service Workerが存在する場合は登録元、scope、cache名を確認する。
- CDN/ブラウザキャッシュだけでなく、旧ファイルの再コミットも確認する。

### C. 読み込み停止の原因特定
ブラウザDevToolsで以下を確認する。
- Consoleの最初のJavaScriptエラー
- `radar_notification_viewer_app.js` のHTTP status
- `reports/radar-notifications-2026-06-22.json` のHTTP status
- JSON parse errorの有無
- Content-Type
- CORSエラーの有無

## 実装修正
監査後、正本を1つに固定する。

### 推奨構成
- `radar_notification_viewer.html`
- `radar_notification_viewer.css`
- `radar_notification_viewer_app.js`

後付けの `radar_tradingview_open_fix.js` は使用しない。必要な処理はapp.jsへ統合する。

### 銘柄一覧
- ENTRY
- ENTRY間近
- Focus
- Watch
を銘柄コードで重複排除し、一覧1か所へ表示する。
- 状態は `ENTRY / Focus` のようなタグで併記する。

### TradingViewリンク
各銘柄は通常の `<a>` 要素にする。
例：
`https://jp.tradingview.com/chart/?symbol=TSE%3A7309&interval=60`

条件：
- `target="_blank"`
- `rel="noopener noreferrer"`
- window.openや埋め込みWidgetを使わない。
- 初期チャート枠を作らない。

## 再上書き防止
- 公開スクリプトがHTML/JSをコピーする場合は、正本からのみコピーする。
- `reports/` JSONの更新時にビューアーHTML/JSを触らない。
- 通知生成処理と静的UI配信を分離する。
- 旧版ファイルを生成するテンプレートがあればテンプレート側を修正する。

## 検証
1. ローカルPCでHTTPサーバー経由で開く。
2. PC Chrome/Edgeで読込完了。
3. スマホChromeで読込完了。
4. 画面に `Viewer 20260622-8`。
5. `Viewer 20260622-5` と `TradingView直結 v6` がソース・公開画面のどこにも残らない。
6. 銘柄一覧が1か所のみ。
7. 同一コードの重複なし。
8. 7309を押してTradingViewの7309が開く。
9. 6258を押してTradingViewの6258が開く。
10. Apple/AAPLが開かない。
11. 60秒自動更新後も一覧とリンクが壊れない。
12. Windowsタスクまたは次回自動公開後もv8が維持される。

## 完了報告に必須
- 原因
- 上書き元または配信元
- 変更ファイル一覧
- 変更前後のパス
- コミットSHA
- PC/スマホの検証結果
- 次回自動公開後も維持された証拠

## 禁止事項
- 売買条件の変更
- Focus/Watch/ENTRY閾値の変更
- JSON内容の捏造
- Local Storageの削除・初期化
- 原因確認前の大量削除
- 別コピーを新たに正本化すること
