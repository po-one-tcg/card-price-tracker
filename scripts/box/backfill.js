// 過去の日付ぶんのデータを、履歴（グラフ）にだけ追加する。
// 「今の状態」（state.json の confirmed/shown・出現/消滅の判定）には一切触れない。
// 新しい日から古い日へ遡って、どの順番で何回実行しても結果が変わらない（各日付は独立に履歴へ積むだけ）。
//
// 対応しているのは「区分（✅見出し）ごとの全商品リスト」のみ（買取EXPO・コレクトの通常の投稿の書式）。
// 「価格変更のお知らせ」（update区分）は対象外（過去のどの状態と比べて変更なのかが決められないため）。
//
// 商品は、現在の商品マスタ（data/box/products.json）に登録済みのものだけを対象にする（対応表 config/product-aliases.json で同一判定）。
// 新しい商品を作ったり、商品マスタ・state.json を書き換えたりはしない。
const Expo = require('../../docs/admin/expo-parser.js');

function backfill({ config, products, state, aliases, text, date, time = '13:00:00' }) {
  const stores = config.stores.filter((s) => s.type === 'manual');
  const sections = stores.flatMap((s) => s.sections.map((x) => ({ ...x, storeId: s.id })));
  const parsed = Expo.parse(text, sections);
  const resolve = Expo.makeResolver(aliases);
  const condIds = new Set(config.conditions.map((c) => c.id));
  const gameIds = new Set(config.games.map((g) => g.id));

  const index = new Map();
  for (const p of Object.values(products)) {
    const k = `${p.game}|${resolve(p.game, p.name)}`;
    if (!index.has(k)) index.set(k, p.id);
  }

  const stamp = `${date}T${time}+09:00`;
  const historyRows = [];
  const runLines = [];
  const reports = [];
  const problems = [];

  for (const b of parsed.blocks) {
    if (b.unknown) {
      problems.push(`見出しを認識できません（取り込みません）: 「${b.heading}」`);
      continue;
    }
    if (b.skipped) {
      reports.push({ sectionId: b.sectionId, skipped: true });
      continue;
    }
    if (b.kind !== 'full' || !b.section) continue; // 価格変更のお知らせは対象外
    const section = b.section;
    const store = stores.find((s) => s.id === section.storeId);
    let matched = 0;
    const unmatched = [];
    const noEntry = [];
    for (const it of b.items) {
      if (!it.name || !condIds.has(it.cond) || !gameIds.has(it.game) || !(it.closed === true || (Number.isInteger(it.price) && it.price > 0))) continue;
      const k = `${it.game}|${resolve(it.game, it.name)}`;
      const pid = index.get(k);
      if (!pid) {
        unmatched.push(it.name);
        continue;
      }
      const key = `${store.id}|${pid}|${it.cond}`;
      if (!state.entries[key]) noEntry.push(it.name);
      historyRows.push({ t: stamp, k: key, st: it.closed ? 'none' : 'value', v: it.closed ? null : it.price });
      matched++;
    }
    if (matched) runLines.push({ t: stamp, store: store.id, src: section.id, ok: true, count: matched });
    reports.push({ sectionId: section.id, matched, unmatched, noEntry });
  }
  return { date, stamp, historyRows, runLines, reports, problems };
}

module.exports = { backfill };
