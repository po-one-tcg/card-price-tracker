// 過去の日付ぶんの買取EXPO・コレクトの投稿を取り込み、履歴（グラフ）にだけ反映する。
// 「今の価格」「出現・消滅の判定」には触れない（backfill.js 参照）ので、新しい日から遡って何日分入れてもよい。
//   node scripts/box/import-history.js <テキストファイル> <日付 YYYY-MM-DD> [--time HH:MM]
// 取り込んだあとは `node scripts/box/build-site.js` を実行すると公開ページ（グラフ）に反映される。
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const S = require('./store');
const { backfill } = require('./backfill');

const args = process.argv.slice(2);
const timeIdx = args.indexOf('--time');
const timeOpt = timeIdx >= 0 ? args[timeIdx + 1] : null;
const positional = args.filter((a, i) => a !== '--time' && (timeIdx < 0 || i !== timeIdx + 1));
const [posFile, date] = positional;
const time = timeOpt ? `${timeOpt}:00` : '13:00:00';

if (!posFile || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('使い方: node scripts/box/import-history.js <テキストファイル> <日付 YYYY-MM-DD> [--time HH:MM]');
  process.exit(1);
}

const config = S.readJson(P.CONFIG, null);
const products = S.loadProducts();
const state = S.loadState();
const aliases = S.readJson(P.ALIASES, {});
const text = fs.readFileSync(posFile, 'utf8');

const result = backfill({ config, products, state, aliases, text, date, time });

for (const m of result.problems) console.error(`  ! ${m}`);
for (const r of result.reports) {
  if (r.skipped) {
    console.log(`  - 対象外の区分: 「${r.sectionId}」`);
    continue;
  }
  let line = `  ✓ ${r.sectionId}: ${r.matched}件`;
  if (r.unmatched.length) line += ` / 商品マスタに無いため対象外: ${r.unmatched.join(', ')}`;
  if (r.noEntry.length) line += ` / 今は扱っていない状態のためグラフに出ない可能性: ${r.noEntry.join(', ')}`;
  console.log(line);
}

if (!result.historyRows.length) {
  console.error('取り込める内容がありませんでした（見出しの書き間違い、または対象の商品が商品マスタに無い可能性）');
  process.exit(1);
}

S.appendLines(path.join(P.HISTORY_DIR, `${date}.jsonl`), result.historyRows);
S.appendLines(P.RUNS, result.runLines);
console.log(`${date} の履歴に ${result.historyRows.length} 件を追加しました（今の価格・state.json は変更していません）。`);
console.log('公開ページに反映するには node scripts/box/build-site.js を実行してください。');
