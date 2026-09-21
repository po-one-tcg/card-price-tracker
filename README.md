# トレカ価格自動追跡ツール

1日3回（JST 11:00 / 15:00 / 18:00）GitHub Actions が自動で動き、次の2つを記録します。

1. **BOX価格トラッカー**（本命）: BOXの買取の**出現・消滅**を検知し、価格推移を公開ページに表示する
2. **カード価格の収集**: PRICE BASE のワンピースカード買取表から、指定キャラ（ルフィ・ゾロ・ナミ・ハンコック）のカード価格を記録する

## 今すぐ更新したいとき

GitHub のリポジトリ → **Actions** タブ → 左の「買取価格の収集」 → 右の **Run workflow** → 緑の **Run workflow**。
1〜3分で終わります。実行画面の下部（Summary）に件数と、出現・消滅・要確認の一覧が出ます。赤（失敗）の場合は、サイトの作りが変わった可能性があります（そのとき既存データは壊れません）。

## 公開ページ（GitHub Pages）

初回だけ設定が必要です: リポジトリの **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / フォルダ `/docs` → Save**。
数分後に `https://po-one-tcg.github.io/card-price-tracker/` で見られます（スマホ対応）。

- ホーム: 直近30日の出現・消滅の一覧、ゲーム一覧
- ゲームの価格表: 店舗が横に並ぶ表（店舗名の行は固定）。🆕出現 / ✕取扱終了 を強調表示
- 商品ページ: 価格推移グラフ、前日・1週間・2週間・1ヶ月・3ヶ月・半年の差額と変化率
- 値動きランキング: 期間ごとに、いま一番動いている商品

## BOXトラッカーの判定ルール

店舗×商品ごとに、前回と今回を比べます。

| 前回 → 今回 | 扱い |
|---|---|
| 取扱なし → 金額あり | **出現**。すぐ公開に反映 |
| 金額あり → 取扱なし | **消滅**。すぐ公開に反映 |
| 金額あり → 金額あり | 変化率が **±50%超**（0円・桁間違いを含む）なら**保留**（公開は前の価格のまま）。それ以下は通常反映 |
| 金額が確認できない（「買取中！」「価格更新中」） | **未確認**。前日の価格は引き継がず、検知にも使わない |

- **取得失敗は「消滅」にしません。** ページが取得できない／構造が変わって0件／商品数が前回の6割未満に急減、のときはその回を丸ごと無効にして、データを変えません（実行ログに失敗として残ります）。
- 直近の成功から30時間以上たった店舗は、公開ページで価格を出さず「未確認（最終更新 n日前）」と表示します。
- 各店舗の**初回**の巡回は基準データづくりで、出現・消滅は判定しません。

### 保留（要確認）の項目を処理する

保留中の一覧を見る:

```
node scripts/box/review.js list
```

判断を記録（次回の収集の最初に反映されます）:

```
node scripts/box/review.js approve  <商品名の一部>          # 正しい → 公開に反映
node scripts/box/review.js set      <商品名の一部> <価格>   # 間違い → 正しい価格に修正して反映
node scripts/box/review.js dismiss  <商品名の一部>          # 間違い → 前の価格のまま据え置き
```

`set` / `dismiss` の後、サイトが同じ誤った値を出し続けても、再び保留にはなりません。

## 保存されるデータ

```
data/box/state.json           店舗×商品ごとの現在の状態（確定済み価格・保留中・直近の出現/消滅）
data/box/products.json        商品の一覧（名前・区分・画像）
data/box/history/日付.jsonl   公開状態が変わったときだけ記録する履歴
data/box/runs.jsonl           巡回の成功/失敗ログ（日次の推移の復元に使う）
data/box/events.jsonl         出現・消滅・保留などのイベント記録
data/box/decisions.json       管理者の判断（保留の処理）
backups/                      更新の直前に自動で取る日付つきバックアップ（直近7日は全部、以降は1日1つ、90日で削除）
docs/                         公開ページ本体（docs/data/box.json は自動生成、docs/img/box/ は商品画像）

data/history/日付.jsonl       カード価格の全取得結果（追記式）
data/cards.json               カードの一覧、data/images/ にカード画像（初出のときだけ保存）
```

## 対象を増やす

- **BOXの店舗・ゲーム**: `config/box-targets.json` の `stores` に書き足します（`scripts/sites/pricebase.js` が見本のパーサー）。同じ店舗に `sources` を足せばゲームを増やせます。
- **カードのキャラ**: `config/targets.json` の `characters` に1行足します。拾いすぎたカードは `exclude` に名前の一部を入れて除外します。

## パソコンで手動実行・テスト（任意）

```
npm install
npm run scrape:dry                     # カード: 保存せず件数だけ確認
node scripts/box/run.js --dry-run      # BOX: 保存せず判定結果だけ確認
node --test scripts/lib/detect.test.js # 判定ロジックのテスト
node scripts/serve.js docs             # 公開ページを手元で確認（http://localhost:8123）
```
