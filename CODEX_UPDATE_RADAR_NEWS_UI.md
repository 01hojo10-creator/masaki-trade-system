# Codex修正依頼：通知ビューアーを銘柄一覧＋相場関連ニュース中心へ整理

## 対象
PC正本：
- `C:\Users\01hoj\OneDrive\デスクトップ\新しいフォルダー\radar_notification_viewer.html`
- `C:\Users\01hoj\OneDrive\デスクトップ\新しいフォルダー\radar_notification_viewer.css`
- `C:\Users\01hoj\OneDrive\デスクトップ\新しいフォルダー\radar_notification_viewer_app.js`
- 必要な場合のみ `masaki-radar-bridge\publish_to_github.py`

GitHub：
- `01hojo10-creator/masaki-trade-system`

## 目的
通知ビューアーの不要な診断項目を削除し、利用者が見るべき内容を以下の2つへ絞る。

1. 銘柄一覧（タップでTradingViewを開く）
2. 相場関連ニュース

## 削除する表示項目
画面から以下を完全に削除する。

- `通知概要`
- `短文通知`
- `ENTRY不成立理由`
- `Focus除外・不足理由`
- `データ取得状態`
- `次の時間帯への引き継ぎ`

注意：表示だけを削除し、元JSONの項目や売買判定ロジックは削除・変更しない。

## 残す表示
- 上部タイトル
- 今日／昨日／日付指定／表示／自動更新
- 読み込み状態
- 朝・昼・夕・夜タブ
- 銘柄一覧（重複排除済み）
- TradingView直結リンク

## 追加する「相場関連ニュース」
既存の日次通知JSONにある以下を使用する。

優先順位：
1. `currentData.importantNews`
2. `currentData.holidayImportantNews`
3. `activeItem.importantNews` が存在する場合は補助的に統合

新しい外部APIをブラウザから直接呼ばない。
有料APIを追加しない。
既存のニュース自動取得レイヤーと日次JSONだけを使う。

### 重複排除
以下の優先順で同一ニュースを1件へまとめる。
1. `id`
2. `url`
3. `title`

### 並び順
- `publishedAt` の新しい順
- 同時刻の場合は `severity` を `HIGH` → `MEDIUM` → `LOW` の順

### ニュースカードの表示内容
各ニュースに以下を表示する。

- 重要度：`severity`
- 見出し：`title`
- 公開時刻：`publishedAt` を日本時間表示
- 分類：`category`
- 出典：`source` または `sources`
- 要約：`summary`
- 相場への影響：`impact`
- 関連銘柄：`relatedTickers`
- 記事リンク：`url`

### 表示仕様
- 見出しを最も目立たせる。
- `HIGH`は強調表示する。
- 関連銘柄はチップ表示にする。
- 記事リンクは通常の`<a>`で別タブ表示。
- `target="_blank"`
- `rel="noopener noreferrer"`
- URLがないニュースはリンクを表示しない。
- ニュースが0件なら「現在、表示できる相場関連ニュースはありません。」と表示する。

## 画面構成
上から次の順にする。

1. 状態表示
2. 日次サマリー
3. 朝・昼・夕・夜タブ
4. 銘柄一覧（タップでTradingViewを開く）
5. 相場関連ニュース

PCではニュースを2列、スマホでは1列を基本とする。
ただし長文が読みにくくならないよう、カード幅を優先する。

## バージョン
- Viewer表記を `20260623-9` に更新する。
- HTMLのCSS／JSキャッシュバスターも `20260623-9` に更新する。

## TradingView仕様
現在のv8仕様を維持する。

例：
`https://jp.tradingview.com/chart/?symbol=TSE%3A7309&interval=60`

以下を変更しない。
- 銘柄コード重複排除
- `target="_blank"`
- `rel="noopener noreferrer"`
- 初期チャートなし
- 埋め込みWidgetなし

## 禁止事項
- 売買条件の変更
- Focus／Watch／ENTRYの判定ロジック変更
- 通知JSON生成ロジックの削除
- Local Storage初期化
- Yahooチャートの再導入
- TradingView埋め込みWidgetの再導入
- 新しい有料APIの追加
- HTMLだけの単独公開

## 公開
PC正本のHTML/CSS/JSを修正後、既存の一括公開経路でGitHubへ反映する。

- `publish_auto.bat` → `publish_to_github.py`
- HTML/CSS/JSを一括同期
- `reports` JSONは従来どおり同期

## 検証
1. PC公開画面で `Viewer 20260623-9` が表示される。
2. スマホ公開画面でも `Viewer 20260623-9` が表示される。
3. 削除対象6項目が画面に存在しない。
4. 銘柄一覧が1か所だけ。
5. 同一銘柄コードの重複0。
6. TradingViewリンクがv8仕様のまま正常。
7. 相場関連ニュースが表示される。
8. ニュースの見出し・時刻・分類・出典・要約・影響・関連銘柄・リンクが表示される。
9. ニュース重複0。
10. 60秒自動更新後も表示が壊れない。
11. Consoleエラーなし。
12. `publish_auto.bat`再実行後もv9が維持される。

## 完了報告
以下を必ず報告する。

- 変更ファイル一覧
- バックアップ先
- ニュースデータの取得元フィールド
- 表示ニュース件数
- 重複排除件数
- PC検証結果
- スマホ検証結果
- コミットSHA
- Pages Actions結果
- 自動公開再実行後もv9が維持された証拠
