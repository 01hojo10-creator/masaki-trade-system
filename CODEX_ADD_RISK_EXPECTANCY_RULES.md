# Codex修正依頼：トレードシステムへ資金管理・期待値・再ENTRY制御を追加

## 0. 最重要方針

今回の修正は、既存の銘柄選定・Focus／Watch／Pool・ENTRY・1時間足・SL・TP判定を壊さず、次の3機能を優先追加する。

1. ENTRY／SL／TPからRR・100株損益・推奨株数を算出して表示／JSON出力
2. 仮想売買の評価を勝率中心から期待値・最大DD中心へ拡張
3. SL後の即時再ENTRYとナンピン相当動作を禁止し、新しいシグナル成立時だけ再ENTRYを許可

固定TP後の利益追跡と地合い別リスク予算は、既存売買判定を変えずに「仮想比較／シャドー評価」として追加する。最初から本番判定へ混ぜない。

---

## 1. 正本と対象

### PC正本

現在実際にJSONを生成している最新版を必ず特定して修正する。

候補：

- `C:\Users\01hoj\OneDrive\デスクトップ\新しいフォルダー\Masaki_PC_latest.html`
- `C:\Users\01hoj\OneDrive\デスクトップ\新しいフォルダー\masaki-radar-bridge\publish_to_github.py`
- 仮想売買・通知JSON生成に使用している関連JS／Python／JSON

### GitHub

- `01hojo10-creator/masaki-trade-system`

### 注意

GitHub上の `index.html` と `Masaki_PC_latest.html` は、PC正本より古い可能性がある。GitHub側の旧HTMLを先に修正しないこと。

必ず以下を確認する。

- 現在の `masaki-radar-latest.json` の `runId`／`generatedAt` を生成したPCファイル
- `unifiedDecision`
- `marketRegime`
- `setupType`
- `hourlyRawBarsCount`
- `hourlyEvaluationBarsCount`
- `incompleteBarExcluded`
- 仮想売買保存キー `mts_virtual_trade_v1` または現行キー

これらが存在する最新版を正本とする。

---

## 2. 変更禁止

以下は今回変更しない。

- Focus／Watch／Poolの分類基準
- `UNIFIED_DECISION_POLICY` の評価順序
- 形成途中1時間足の除外ロジック
- EMA75長期トレンドゲート
- REVERSAL_WATCHのFocus禁止
- ENTRY成立条件
- 現行SL価格の算出ロジック
- 現行TP価格の算出ロジック
- Yahooデータ取得・フォールバック順
- 通知時刻
- 100株固定の既存仮想売買結果
- Local Storageの既存データ初期化
- 既存JSONフィールドの削除・名称変更

既存値を上書きせず、追加フィールド方式にする。

---

## 3. 機能A：RR・最大損失・推奨株数

### 3.1 共通計算

LONG：

- `riskPerShare = entryPrice - stopLoss`
- `rewardPerShare = takeProfit - entryPrice`

SHORT：

- `riskPerShare = stopLoss - entryPrice`
- `rewardPerShare = entryPrice - takeProfit`

共通：

- `riskReward = rewardPerShare / riskPerShare`
- `risk100SharesYen = riskPerShare * 100`
- `reward100SharesYen = rewardPerShare * 100`

無効条件：

- ENTRY／SL／TPのいずれかが欠損
- `riskPerShare <= 0`
- `rewardPerShare <= 0`
- 数値が非有限

無効時は0で誤魔化さず、`null` と理由を出す。

### 3.2 推奨株数

設定値を追加する。

- 初期許容損失額：`10000円`
- 設定キー例：`riskBudgetYen`
- UIで変更可能
- Local Storageへ保存
- 最小100株、100株単位で切り捨て

式：

`recommendedShares = floor(riskBudgetYen / riskPerShare / 100) * 100`

ただし：

- 100株未満になる場合は `0株／見送り`
- 既存仮想売買は100株固定を維持
- 推奨株数を自動注文には使用しない

### 3.3 JSON追加フィールド

各Focus／ENTRY候補に、後方互換を保って以下を追加する。

```json
{
  "positionSizing": {
    "valid": true,
    "side": "LONG",
    "entryPrice": 1500,
    "stopLoss": 1450,
    "takeProfit": 1610,
    "riskPerShare": 50,
    "rewardPerShare": 110,
    "riskReward": 2.2,
    "risk100SharesYen": 5000,
    "reward100SharesYen": 11000,
    "riskBudgetYen": 10000,
    "recommendedShares": 200,
    "invalidReason": ""
  }
}
```

### 3.4 PC画面表示

ENTRY／SL／TP付近に以下を追加する。

- `RR 2.20`
- `100株損失 -5,000円`
- `100株目標 +11,000円`
- `許容損失1万円なら 200株`

表示はENTRY候補だけ。WAITで数値が無効な場合はカードを圧迫しない。

---

## 4. 機能B：仮想売買の期待値評価

### 4.1 対象

クローズ済み仮想取引のみを対象にする。

損益は日本株100株単位の金額ベースを正本とする。

### 4.2 追加集計

最低限、以下を算出する。

- `closedTrades`
- `wins`
- `losses`
- `winRatePct`
- `grossProfitYen`
- `grossLossYen`
- `netProfitYen`
- `averageWinYen`
- `averageLossYen`（絶対値）
- `payoffRatio = averageWinYen / averageLossYen`
- `profitFactor = grossProfitYen / grossLossYen`
- `expectancyYen = winRate * averageWin - lossRate * averageLoss`
- `maxDrawdownYen`
- `maxDrawdownPct`（元本が定義されている場合のみ）
- `maxLosingStreak`
- `averageHoldingMinutes`
- `tpExitRatePct`
- `slExitRatePct`
- `otherExitRatePct`

0除算は `null` とする。

### 4.3 最大ドローダウン

クローズ時刻順の累積確定損益から算出する。

- 未決済含み損益を混ぜない
- peakからその後のtroughまでの最大減少額
- データ順序が不正な場合は時刻で並べ直す

### 4.4 区分別集計

全体に加え、件数がある区分のみ出す。

- Focus／Watch起点
- LONG／SHORT
- `marketRegime`
- `setupType`
- `entryTimeframe.key`（morning／midday／evening／night等）
- スコア帯：60未満、60–69、70–79、80以上

1件しかない区分を優秀と断定しない。件数を必ず併記する。

### 4.5 UI

仮想売買検証欄の上部に以下を表示する。

- 総損益
- 期待値／1取引
- PF
- 平均利益／平均損失
- 最大DD
- 最大連敗
- 勝率（補助指標）

色判定は勝率ではなく、期待値とPFを優先する。

例：

- 期待値プラスかつPF>1：良好
- 期待値マイナスまたはPF<1：要改善
- 取引件数20未満：参考値

### 4.6 JSON／CSV

既存の監査JSONまたは検証JSONへ追加する。

```json
{
  "performanceMetrics": {
    "version": "expectancy_v1",
    "generatedAt": "...",
    "overall": {},
    "byClassification": {},
    "bySide": {},
    "byMarketRegime": {},
    "bySetupType": {},
    "byEntryTimeframe": {},
    "byScoreBand": {}
  }
}
```

既存CSV列は削除せず、末尾に追加する。

---

## 5. 機能C：SL後の即時再ENTRY禁止

### 5.1 目的

同一条件のまま損切り直後に入り直す行為と、実質的なナンピンを防ぐ。

### 5.2 ロックキー

最低限、以下を組み合わせる。

- 銘柄コード
- LONG／SHORT
- `setupType`
- SL決済時刻
- SL決済に使用した最新「確定済み1時間足」の時刻
- ENTRY条件のフィンガープリント

例：

`symbol|side|setupType|evaluationLatestBarAt|signalFingerprint`

### 5.3 SL後の禁止

SL決済後、以下を禁止する。

- 同じ確定済み1時間足の中での再ENTRY
- 同じENTRY条件フィンガープリントでの再ENTRY
- ENTRY価格を下げただけの再ENTRY
- SLを不利方向へ広げてポジションを維持
- 既存ポジションと同方向の買い増し

### 5.4 再ENTRY許可条件

以下をすべて満たした場合のみ、新しい独立取引として許可する。

1. SL決済後に新しい確定済み1時間足が1本以上追加
2. 現行ENTRY判定が再度ゼロから成立
3. `signalFingerprint` が前回と異なる、または前回失敗条件が明示的に解消
4. データ鮮度・流動性・除外・地合い・1時間足・ENTRYの全ゲートを再通過
5. 同一銘柄の未決済ポジションがない

### 5.5 フィンガープリント

少なくとも以下から安定した文字列を作る。

- symbol
- side
- setupType
- marketRegime
- evaluationLatestBarAt
- entry band rounded
- SL rounded
- TP rounded
- hourly pattern
- unifiedDecision classification/reason

JSONキー順の違いで変化しないよう、固定順で連結する。

### 5.6 保存

Local Storageへ追加保存する。

- 既存キーを壊さない
- 新規キー例：`mts_reentry_guard_v1`
- 古いロックは30営業日程度で削除
- 保存失敗時はENTRYを緩めず、安全側で再ENTRYを抑制

### 5.7 表示／監査

ロック中は以下を表示・出力する。

- `REENTRY_LOCK`
- ロック理由
- 前回SL時刻
- 前回確定1時間足
- 最短再評価時刻ではなく「次の確定1時間足待ち」

追加JSON例：

```json
{
  "reentryGuard": {
    "version": "reentry_guard_v1",
    "locked": true,
    "reason": "same_completed_hourly_bar_after_sl",
    "previousStopAt": "...",
    "previousEvaluationLatestBarAt": "...",
    "currentEvaluationLatestBarAt": "...",
    "previousSignalFingerprint": "...",
    "currentSignalFingerprint": "..."
  }
}
```

---

## 6. 機能D：固定TP対トレンド継続のシャドー比較

### 6.1 本番ルールは変更しない

現行TP到達時の既存仮想売買結果をbaselineとして維持する。

同じENTRYから別レコードでシャドー戦略を追跡する。

### 6.2 シャドー戦略

初期案：

- TP1到達で50株を決済
- 残り50株を追跡
- LONGは確定済み1時間足の直近安値またはEMA21割れで決済
- SHORTは確定済み1時間足の直近高値またはEMA21上抜けで決済
- DOWNTREND／UPTRENDなど既存の方向ゲート反転時は全決済
- 形成途中足を使わない

### 6.3 比較指標

- baseline純損益
- shadow純損益
- 差額
- 最大DD
- 利益を伸ばせた割合
- TP後に利益を戻した割合
- 平均保有時間

最低30件程度のクローズ取引が集まるまで本番採用判定を出さない。

---

## 7. 機能E：地合い別リスク予算（表示・シャドーのみ）

既存 `marketRegime` 等を使用し、まず推奨値だけを出す。

- RISK_ON：リスク予算100%
- NEUTRAL：リスク予算50%
- RISK_OFF：ロング25%または見送り

今回はENTRY判定やFocus分類を変更しない。

追加フィールド例：

```json
{
  "marketRiskBudget": {
    "state": "NEUTRAL",
    "multiplier": 0.5,
    "baseRiskBudgetYen": 10000,
    "adjustedRiskBudgetYen": 5000,
    "mode": "advisory_only"
  }
}
```

---

## 8. 実装順序

1. 正本・バックアップ・現行runId確認
2. 共通の数値計算関数を追加
3. RR／100株損益／推奨株数をUIとJSONへ追加
4. 仮想売買集計を追加
5. 再ENTRYガードを追加
6. baselineを変えずにTPシャドー比較を追加
7. 地合い別リスク予算を助言表示として追加
8. ローカル検証
9. JSON互換性確認
10. PC正本と公開対象を一括同期

一度に大規模置換しない。機能ごとに小さいコミットへ分ける。

---

## 9. バックアップ

変更前に、対象ファイルを以下のようなフォルダへ保存する。

`C:\Users\01hoj\OneDrive\デスクトップ\新しいフォルダー\backup_risk_expectancy_YYYYMMDD-HHMMSS`

バックアップに含める。

- PC正本HTML／JS／Python
- `publish_to_github.py`
- 仮想売買Local Storageを書き出せる場合は監査JSON
- 現行 `masaki-radar-latest.json`
- 現行 `chatgpt-radar-report.json`

既存Local Storageは削除しない。

---

## 10. 検証

### 10.1 回帰確認

- Focus／Watch／Pool件数が意図せず変化していない
- ENTRY件数が今回の追加機能だけを理由に変化していない
- ENTRY／SL／TPの既存値が変更されていない
- 形成途中1時間足除外が維持
- `UNIFIED_DECISION_POLICY` が維持
- 旧JSON利用側でエラーなし
- 通知ビューアーv9の銘柄一覧・ニュース表示が壊れていない

### 10.2 RR計算テスト

LONG例：

- ENTRY 1500
- SL 1450
- TP 1610
- RR 2.20
- 100株損失 5000円
- 100株利益 11000円
- 許容損失10000円なら200株

SHORT例：

- ENTRY 1500
- SL 1530
- TP 1440
- RR 2.00
- 100株損失 3000円
- 100株利益 6000円
- 許容損失10000円なら300株

無効例：

- LONGでSL >= ENTRY
- SHORTでSL <= ENTRY
- TPが逆方向
- 欠損値

すべて `valid=false`、`null`、理由付きになること。

### 10.3 期待値テスト

人工データ：

- +15000
- +15000
- -5000
- -5000
- -5000

期待：

- 勝率40%
- 平均利益15000円
- 平均損失5000円
- 期待値3000円／取引
- PF 2.0

### 10.4 再ENTRYテスト

- SL後、同一確定足：ロック
- 新しい確定足あり・条件未成立：ロック
- 新しい確定足あり・同一フィンガープリント：ロック
- 新しい確定足あり・新規シグナル成立：許可
- 未決済同方向ポジションあり：禁止

### 10.5 ブラウザ

- Consoleエラー0
- ページ再読み込み後も設定・ロック維持
- 日付跨ぎでも壊れない
- 古いLocal Storageデータがあってもマイグレーション可能

---

## 11. 公開

PC正本の修正と検証が完了してから、既存の一括公開経路を使用する。

- `publish_auto.bat`
- `publish_to_github.py`
- HTML／CSS／JS／JSONを必要な単位で同期

禁止：

- GitHub上の旧HTMLだけを先行修正
- PC正本へ逆同期せず公開のみ変更
- HTMLだけ公開して関連JS／JSONを同期しない
- 既存v9通知ビューアーを旧版で上書き

---

## 12. 完了条件

以下を必ず報告する。

1. 正本と判断したファイルパス
2. バックアップ先
3. 変更ファイル一覧
4. 既存ENTRY／SL／TPが不変である比較結果
5. RRテスト結果
6. 期待値テスト結果
7. 再ENTRYロックテスト結果
8. TP baseline／shadowの保存形式
9. Local Storageマイグレーション結果
10. 回帰確認結果
11. 生成JSONの追加フィールド例
12. 公開コミットSHA
13. GitHub Pages反映結果
14. `publish_auto.bat` 再実行後も修正が維持された証拠

完了条件を満たせない場合は、未完了項目と停止理由を明記する。迂回公開や旧版への直接変更は行わない。
