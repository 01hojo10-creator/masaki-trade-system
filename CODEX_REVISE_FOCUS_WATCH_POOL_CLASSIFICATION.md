# Codex修正依頼：Focus／Watch／Pool分類基準を実戦向けに再設計

## 0. 優先順位

この作業を、以下より先に実施する。

- `CODEX_ADD_RISK_EXPECTANCY_RULES.md`
- `CODEX_SIMPLIFY_VIRTUAL_TRADE_SUMMARY.md`

理由：まず銘柄分類の質を修正し、その後に資金管理・期待値・表示簡略化を追加する。

---

## 1. 目的

現在のFocus／Watch／Pool分類を、単純な総合点や上位件数中心ではなく、次の順序で判断する実戦型へ変更する。

1. データ正常性
2. 流動性
3. 除外条件
4. 地合いとの方向一致
5. 日足・確定済み1時間足の形
6. 値動きの強さ・出来高・初動／押し目
7. ENTRY準備度
8. RR・損失幅・上値余地
9. 総合点

狙いは次の2点。

- cis型：実際に強い銘柄、資金が入っている銘柄、トレンドが継続している銘柄を優先する
- テスタ型：ENTRYできてもリスクに対する利益余地が不足する銘柄はFocusへ入れない

---

## 2. 正本

GitHub上の旧HTMLを直接修正しない。

現在 `masaki-radar-latest.json` を生成しているPC正本を特定して修正する。

候補：

- `C:\Users\01hoj\OneDrive\デスクトップ\新しいフォルダー\Masaki_PC_latest.html`
- 関連JS／Python
- `masaki-radar-bridge\publish_to_github.py`

正本判定条件：

- `unifiedDecision`
- `marketRegime`
- `setupType`
- `focusReadiness`
- `hourlyRawBarsCount`
- `hourlyEvaluationBarsCount`
- `incompleteBarExcluded`
- `focusTrendGate`

が現行JSONと一致すること。

---

## 3. 基本原則

### 3.1 弱い候補で枠を埋めない

- Focus最大6件
- Watch最大15件

ただし、条件を満たす銘柄が少なければ、FocusやWatchを空欄のままにする。

禁止：

- Focusが6件未満だからWatch銘柄を自動昇格
- Watchが15件未満だからPool銘柄を自動昇格
- 総合点順だけで上位件数を切り出す

### 3.2 ハード条件とソフト条件を分離

ハード条件を1つでも失敗した銘柄は、総合点が高くてもFocusへ入れない。

総合点は、すべての上位ゲートを通過した後の順位付けにだけ使う。

### 3.3 形成途中足を使わない

日足・1時間足判定、ENTRY準備度、再分類には確定済みバーだけを使用する。

既存の形成途中1時間足除外ロジックを維持する。

---

## 4. 分類定義

### 4.1 Focus

意味：

- 売買判断の準備が整っている
- ENTRY成立中、または次の確定確認でENTRYになり得る
- リスクと利益余地が釣り合う

Focusへ入れるには、以下をすべて満たす。

#### A. データ・流動性

- データ鮮度PASS
- 必要バー数PASS
- 異常値なし
- 流動性PASS
- 取得失敗・scan_onlyではない

#### B. 除外条件

以下がすべてfalse。

- データ異常
- 流動性不足
- 過熱しすぎ
- チャート形状崩れ
- テーマ失効
- 高値追い危険が強い
- 長期トレンド逆行

#### C. 長期・中期方向

LONG：

- `marketRegime = UPTREND`
- `focusTrendGate = true`
- EMA75長期上昇、または少なくとも下降していない
- 価格が長期EMA上
- `REVERSAL_WATCH` はFocus禁止

SHORT：

- `marketRegime = DOWNTREND`
- SHORT用トレンドゲートPASS
- 価格が長期EMA下

TRANSITIONは原則Watchまで。

既存ロジックに明確な例外セットアップがある場合のみ、例外理由をJSONへ出してFocusを許可する。

#### D. 確定済み1時間足

最低条件：

- hourly.available = true
- hourly.pass = true
- hourly.entryAllowed = true
- hourly.hardFail = false
- 1時間足の構造が方向と一致
- EMA9／EMA21の向きが方向と一致
- 高値・安値構造が崩れていない

#### E. 実際の強さ

次のいずれかを満たす。

- 初動スコアが現行ENTRY基準以上
- 押し目スコアが現行ENTRY基準以上
- 出来高増加を伴うブレイク準備
- 高値圏で出来高を維持しつつ収縮

単なる材料あり、テーマ一致、ニュースありだけではFocusにしない。

#### F. ENTRY準備度

Focusは以下のどちらか。

1. `ENTRY_READY`
   - 現行ENTRY条件成立
   - ENTRY帯内

2. `ENTRY_NEAR`
   - ENTRY帯までの距離が現行上限以内
   - 不足条件は最大1個
   - 不足条件が「価格待ち」または「出来高最終確認」などのソフト条件

ENTRYまで遠い銘柄はWatch。

#### G. リスク条件

現行ENTRY／SL／TPから判定する。

最低条件：

- riskPerShare > 0
- rewardPerShare > 0
- RR >= 1.5
- リスク幅 <= 2.5%
- 上値余地 >= 1.5%

既存定数がある場合は次を再利用する。

- `SIGNAL_ENTRY_DISTANCE_MAX`
- `SIGNAL_UPSIDE_ROOM_MIN`
- `SIGNAL_RISK_WIDTH_MAX`

閾値を二重定義しない。

#### H. 総合点

上記をすべて通過した後に、現行スコア最低基準を適用する。

目安：65以上。

既存の正式閾値が別にある場合は、現在のENTRY基準と矛盾しない方を使用する。

---

### 4.2 Watch

意味：

- 有望だが、今すぐ売買準備完了ではない
- 1～2個の条件待ち

Watch条件：

- データ・流動性にハード失敗なし
- 除外対象ではない
- 日足または1時間足に一定の方向性あり
- 不足条件が1～2個
- ENTRYまで遠すぎない、または次の数本で準備可能
- RRが未確定、または軽微に不足
- TRANSITION
- REVERSAL_WATCH
- ブレイク待ち
- 押し目形成待ち

Watchへ残してよい不足例：

- ENTRY帯未到達
- 出来高確認待ち
- 上値余地回復待ち
- 1時間足の次の確定待ち
- 初動／押し目スコアが少し不足

Watchへ残してはいけない例：

- 流動性不足
- データ異常
- 長期トレンドが明確に逆
- 形状崩れ
- 過熱しすぎ

これらはExcludedまたはPoolへ送る。

Watch最低目安スコア：50以上。

---

### 4.3 Pool

意味：

- 監視対象ではあるが、売買準備段階ではない

Pool条件：

- ハード除外までは該当しない
- Watch条件を満たさない
- 不足条件が3個以上
- ENTRYまで遠い
- 日足と1時間足が不一致
- トレンドが弱い
- 出来高不足
- スコアがWatch基準未満
- scan_only
- テーマだけで価格反応がない

PoolからWatchへの昇格には、新しい確定データで不足条件が2個以下になることを必須とする。

---

### 4.4 Excluded

画面に分類表示しない、または除外一覧へ送る。

条件：

- データ古い／欠損／異常
- 流動性不足
- 過熱形状
- チャート形状崩れ
- テーマ失効
- 取引停止等
- 長期トレンドと明確に逆行し、例外セットアップでもない

除外理由は必ず1件以上出力する。

---

## 5. 分類順序

必ず以下の順で判定する。

```text
DATA_CHECK
→ LIQUIDITY_CHECK
→ EXCLUSION_CHECK
→ MARKET_CONTEXT_CHECK
→ DAILY_LONG_TREND_CHECK
→ COMPLETED_HOURLY_CHECK
→ PRICE_VOLUME_STRENGTH_CHECK
→ ENTRY_READINESS_CHECK
→ RISK_REWARD_CHECK
→ SCORE_RANKING
→ CAPACITY_LIMIT
```

総合点から先に分類してはいけない。

---

## 6. ランキング

### Focus候補の順位

1. ENTRY_READY
2. ENTRY_NEAR
3. RRが高い
4. ENTRY帯への距離が近い
5. 上値余地が大きい
6. 初動／押し目／出来高が強い
7. 1時間足グレード
8. 総合点

### Watch候補の順位

1. 不足条件数が少ない
2. ENTRY帯への距離が近い
3. トレンド一致度
4. RR回復余地
5. 初動／押し目／出来高
6. 総合点

### 枠超過

Focus適格が7件以上の場合：

- 上位6件をFocus
- 7件目以降はWatch
- 理由：`capacity_overflow_from_focus`
- `underlyingClassification = focus_eligible`

Watch適格が16件以上の場合：

- 上位15件をWatch
- 超過分はPool
- 理由：`capacity_overflow_from_watch`
- `underlyingClassification = watch_eligible`

弱い銘柄を昇格させて枠を埋めない。

---

## 7. JSON追加

各銘柄に以下を追加する。

```json
{
  "classificationPolicyVersion": "focus_watch_pool_v2",
  "classificationAudit": {
    "finalClassification": "focus",
    "underlyingClassification": "focus_eligible",
    "readiness": "ENTRY_READY",
    "hardGatePassed": true,
    "hardFailReasons": [],
    "softMissingConditions": [],
    "softMissingCount": 0,
    "entryDistancePct": 0.3,
    "riskWidthPct": 1.8,
    "upsideRoomPct": 3.2,
    "riskReward": 1.78,
    "capacityAdjusted": false,
    "rankReasons": [
      "entry_ready",
      "uptrend_aligned",
      "hourly_pass",
      "volume_confirmed",
      "rr_pass"
    ]
  }
}
```

既存の以下は削除しない。

- `unifiedDecision`
- `focusTier`
- `focusLabel`
- `focusReadiness`
- `missingConditions`
- `promotionHint`

新旧の理由が矛盾しないよう同期する。

---

## 8. 旧分類との比較

実装後5営業日分、監査用に旧分類も並行計算する。

```json
{
  "classificationComparison": {
    "previousClassification": "watch",
    "newClassification": "focus",
    "changed": true,
    "changeReasons": ["rr_pass", "entry_ready"]
  }
}
```

実画面と通知には新分類を使用する。

旧分類は監査JSONだけに残す。

---

## 9. 通知・ビューアーへの反映

- Focus／Watch／Pool一覧は新分類を使用
- ENTRY判定そのものは既存条件を維持
- FocusでもENTRY未成立ならENTRYとは表示しない
- Watch／PoolをENTRY扱いにしない
- 通知ビューアーv9のニュース・TradingView機能を壊さない

---

## 10. テストケース

### ケース1：強い上昇＋ENTRY成立＋RR良好

期待：Focus

- UPTREND
- EMA75上向き
- hourly pass
- ENTRY帯内
- RR 1.8
- リスク幅2.0%
- 出来高増加

### ケース2：強いがENTRYまで遠い

期待：Watch

- UPTREND
- hourly pass
- RR良好
- ENTRY距離上限超過

### ケース3：材料ありだが値動き弱い

期待：Pool

- テーマ一致
- 出来高なし
- hourly弱い
- 不足条件3個以上

### ケース4：高得点だがRR不足

期待：WatchまたはPool

- 総合点80
- RR 0.9
- Focus禁止

### ケース5：下降トレンドの逆張りLONG

期待：Watch以下

- DOWNTREND
- REVERSAL_WATCH
- Focus禁止

### ケース6：データ異常

期待：Excluded

- 総合点が高くても除外

### ケース7：Focus適格2件だけ

期待：Focusは2件

- 6件まで無理に埋めない

### ケース8：Focus適格8件

期待：

- 上位6件Focus
- 残り2件Watch
- capacity overflow理由あり

---

## 11. 回帰確認

- 形成途中1時間足除外が維持
- EMA75ゲートが維持
- ENTRY／SL／TP価格は今回変更しない
- 既存Local Storageを消さない
- 仮想売買履歴を消さない
- JSON利用側でエラーなし
- Focus／Watch／Poolの重複0
- 全銘柄がFocus／Watch／Pool／Excludedのいずれか1つだけ
- 同一runId内で分類が不安定に揺れない

---

## 12. バックアップ

変更前にPC正本と関連ファイルをバックアップする。

例：

`backup_focus_watch_pool_v2_YYYYMMDD-HHMMSS`

含める：

- 正本HTML／JS／Python
- `publish_to_github.py`
- 現行 `masaki-radar-latest.json`
- 現行 `chatgpt-radar-report.json`
- 現行分類件数の監査JSON

---

## 13. 完了報告

必ず以下を報告する。

1. 正本ファイルパス
2. バックアップ先
3. 変更ファイル一覧
4. 新分類ポリシーバージョン
5. 変更前後のFocus／Watch／Pool件数
6. 分類変更した銘柄と理由
7. Focusを枠数まで無理に埋めていない証拠
8. 8つのテストケース結果
9. ENTRY／SL／TPが不変である比較
10. JSON追加例
11. Consoleエラー結果
12. 公開コミットSHA
13. GitHub Pages反映結果
14. `publish_auto.bat`再実行後も維持された証拠

未完了項目がある場合は、停止理由を明記する。
