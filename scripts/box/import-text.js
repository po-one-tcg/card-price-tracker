// 手入力店舗（買取EXPO・コレクト）の内容を、テキストから取り込みデータにして data/box/manual/inbox/ に置く。
// 管理画面の「読み取る → 確定して取り込む」と同じ処理を、コマンドで行う（Claude Code から毎日取り込むときに使う）。
//   node scripts/box/import-text.js <テキストファイル> [--confirm-drop]
//     --confirm-drop : 前回の6割未満の区分でも、貼り忘れではないと確認したうえで取り込む
// 置いたあとは `node scripts/box/run.js --game none --no-images` で反映される（Actions の次の更新でも反映される）。
const fs = require('fs');
const path = require('path');
const Expo = require('../../docs/admin/expo-parser.js');
const P = require('./paths');
const S = require('./store');
const { jstNow } = require('../lib/common');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const confirmDrop = args.includes('--confirm-drop');
if (!file) {
  console.error('使い方: node scripts/box/import-text.js <テキストファイル> [--confirm-drop]');
  process.exit(1);
}

const config = S.readJson(P.CONFIG, null);
const stores = config.stores.filter((s) => s.type === 'manual');
const sections = stores.flatMap((s) => s.sections.map((x) => ({ ...x, storeId: s.id })));
const updateStore = stores.find((s) => s.updatePosts) || stores[0];
const text = fs.readFileSync(file, 'utf8');
const parsed = Expo.parse(text, sections);

let problems = 0;
for (const b of parsed.blocks) {
  if (b.unknown) {
    console.error(`  ! 見出しを認識できません（取り込みません）: 「${b.heading}」`);
    problems++;
  } else if (b.skipped) console.log(`  - 対象外の区分: 「${b.heading}」`);
  else if (b.warnings.length) console.warn(`  ! ${b.heading}: ${b.warnings.join(' / ')}`);
}

const now = jstNow();
const stamp = now.stamp.replace(/[-:T+]/g, '').slice(0, 14);
const rand = () => Math.random().toString(36).slice(2, 8);
fs.mkdirSync(P.INBOX_DIR, { recursive: true });
let written = 0;
for (const st of stores) {
  const blocks = parsed.blocks
    .filter((b) => !b.unknown && !b.skipped && b.items.length)
    .map((b) => ({ ...b, storeId: b.section ? b.section.storeId : updateStore.id }))
    .filter((b) => b.storeId === st.id);
  const fulls = blocks.filter((b) => b.kind === 'full');
  const ups = blocks.filter((b) => b.kind === 'update');
  const base = { store: st.id, createdAt: now.stamp, rawText: text };
  if (fulls.length) {
    const sub = { ...base, id: rand(), type: 'full', blocks: fulls.map((b) => ({ sectionId: b.sectionId, ...(confirmDrop ? { confirmedDrop: true } : {}), items: b.items.map(({ name, cond, price, closed, game }) => ({ name, cond, price, closed, game })) })) };
    fs.writeFileSync(path.join(P.INBOX_DIR, `${stamp}-full-${st.id}-${rand()}.json`), JSON.stringify(sub) + '\n');
    console.log(`${st.name} 全商品リスト: ${fulls.map((b) => `${b.section.label} ${b.items.length}件`).join(' / ')}`);
    written++;
  }
  if (ups.length) {
    const sub = { ...base, id: rand(), type: 'update', blocks: ups.map((b) => ({ items: b.items.map(({ name, cond, price }) => ({ name, cond, price })) })) };
    fs.writeFileSync(path.join(P.INBOX_DIR, `${stamp}-update-${st.id}-${rand()}.json`), JSON.stringify(sub) + '\n');
    console.log(`${st.name} 価格変更: ${ups.reduce((n, b) => n + b.items.length, 0)}件`);
    written++;
  }
}
if (!written) {
  console.error('取り込める内容がありません（「✅…」の見出しが無い、または見出しを認識できませんでした）');
  process.exit(1);
}
console.log(`取り込みデータを ${written} 件、data/box/manual/inbox/ に置きました。${problems ? `（認識できない見出し ${problems} 件は除外）` : ''}`);
