# トレカ価格自動追跡ツール

PRICE BASE のワンピースカード買取表から、対象キャラの買取価格を1日3回（JST 11:00 / 15:00 / 18:00）自動収集します。

## 今すぐ更新したいとき

GitHub のリポジトリを開き、**Actions** タブ → 左の「買取価格の収集」 → 右の **Run workflow** ボタン → 緑の **Run workflow**。
1〜2分で終わり、実行画面の下部（Summary）にキャラ別の件数が表示されます。赤（失敗）になった場合は、サイトの作りが変わった可能性があります。

## 保存されるデータ

```
data/
  history/YYYY-MM-DD.jsonl   その日の全取得結果（1行1件・実行のたびに追記。過去分は上書きしない）
  cards.json                 見つかった全カードの一覧（名前・型番・初出日・画像パスなど）
  images/<カードID>.<拡張子>  カード画像（そのカードを初めて見つけた時に1回だけ保存）
```

- カードID = `サイト_型番_ハッシュ`。**名前+型番表記+画像名**の3点から作るので、同名異絵柄や「未開封/開封済」は別カードになります。
- history の1行: `{"t":"取得日時","id":"カードID","price":買取価格,"status":"price|updating|buying","siteDate":"サイト表示日"}`
  - `updating` = 「価格更新中」、`buying` = 「買取中！」（金額表示なし）。どちらも `price` は `null`。

## 対象を増やす

`config/targets.json` を編集するだけです。

- **キャラを増やす**: `characters` に `{ "id": "sanji", "label": "サンジ", "keywords": ["サンジ"], "exclude": [] }` を1行足す
- **拾いすぎたカードを除外したい**: そのキャラの `exclude` に名前の一部を入れる（例: ゾロの `"exclude": ["ゾロ十郎"]`）
- **サイトを増やす**: `scripts/sites/` にそのサイト用のパーサーを追加し、`sites` に1件足す（`pricebase.js` が見本）

## パソコンで手動実行（任意）

```
npm install
npm run scrape:dry   # 保存せず件数だけ確認
npm run scrape       # 実際に data/ へ保存
```
