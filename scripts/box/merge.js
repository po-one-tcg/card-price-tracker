// 商品の統合。config/product-aliases.json に「同じ商品」と書かれた商品が、すでに別々の商品として
// 入っている場合に、1つにまとめる（価格の履歴・イベントも引き継ぐ）。収集の最初に自動で行う。
//   node scripts/box/merge.js            統合の予定を表示するだけ
//   node scripts/box/merge.js --apply    実際に統合して保存する
//
// 統合しない場合: 同じ「店舗×状態」のデータが両方の商品にある（＝同じ店が両方の名前で載せている）ときは、
// 履歴が混ざってしまうため統合せず、警告だけ出す。
const fs = require('fs');
const path = require('path');
const Expo = require('../../docs/admin/expo-parser.js');
const P = require('./paths');
const S = require('./store');

// state / products から、統合の計画を作る（副作用なし）
//   戻り値: { plans: [{ game, keep, drop: [pid...], name }], skipped: [{ game, pids, reason }] }
function planMerges(state, products, aliases, autoStoreIds = new Set()) {
  const resolve = Expo.makeResolver(aliases);
  const groups = {};
  for (const p of Object.values(products)) (groups[`${p.game}|${resolve(p.game, p.name)}`] ??= []).push(p);

  const entriesOf = (pid) => Object.entries(state.entries).filter(([, e]) => e.ref.pid === pid);
  const plans = [];
  const skipped = [];
  for (const [gkey, list] of Object.entries(groups)) {
    if (list.length < 2) continue;
    // 残す商品: 対応表で「正とする表記」になっている名前の商品を最優先、次に自動取得の店舗（PRICE BASE など）に載っている商品、次に先に見つかった商品
    const isCanonical = (p) => (Expo.canon(p.name) === gkey.slice(gkey.indexOf('|') + 1) ? 0 : 1);
    const score = (p) => (entriesOf(p.id).some(([, e]) => autoStoreIds.has(e.ref.store)) ? 0 : 1);
    list.sort((a, b) => isCanonical(a) - isCanonical(b) || score(a) - score(b) || (a.firstSeen || '').localeCompare(b.firstSeen || '') || a.id.localeCompare(b.id));
    const [keep, ...drop] = list;
    // 衝突の確認: 残す側と同じ「店舗|状態」が、統合される側にもあるか
    const taken = new Set(entriesOf(keep.id).map(([, e]) => `${e.ref.store}|${e.ref.cond}`));
    const ok = [];
    for (const d of drop) {
      const mine = entriesOf(d.id).map(([, e]) => `${e.ref.store}|${e.ref.cond}`);
      if (mine.some((k) => taken.has(k))) {
        skipped.push({ game: keep.game, pids: [keep.id, d.id], names: [keep.name, d.name], reason: '同じ店舗・状態のデータが両方の商品にあるため統合しません' });
        continue;
      }
      mine.forEach((k) => taken.add(k));
      ok.push(d.id);
    }
    if (ok.length) plans.push({ game: keep.game, keep: keep.id, drop: ok, name: keep.name });
  }
  return { plans, skipped };
}

// 計画を state / products に反映する。戻り値: 付け替えたキーの対応表 Map(旧キー → 新キー)
function applyPlans(state, products, plans) {
  const keyMap = new Map();
  for (const plan of plans) {
    const keep = products[plan.keep];
    for (const oldPid of plan.drop) {
      for (const [key, entry] of Object.entries(state.entries)) {
        if (entry.ref.pid !== oldPid) continue;
        const newKey = `${entry.ref.store}|${plan.keep}|${entry.ref.cond}`;
        state.entries[newKey] = { ...entry, ref: { ...entry.ref, pid: plan.keep } };
        delete state.entries[key];
        keyMap.set(key, newKey);
      }
      const old = products[oldPid];
      if (old) {
        keep.groups = [...new Set([...(keep.groups || []), ...(old.groups || [])])];
        keep.firstSeen = [keep.firstSeen, old.firstSeen].filter(Boolean).sort()[0] || keep.firstSeen;
        if (!keep.image && old.image) {
          keep.image = old.image;
          keep.imageUrl = keep.imageUrl || old.imageUrl;
        }
        delete products[oldPid];
      }
    }
  }
  return keyMap;
}

// 履歴・イベントのキーを付け替える（jsonl を書き換える）
function rewriteFiles(keyMap, pidMap) {
  let changed = 0;
  const fix = (obj) => {
    let hit = false;
    if (obj.k && keyMap.has(obj.k)) {
      obj.k = keyMap.get(obj.k);
      hit = true;
    }
    if (obj.pid && pidMap.has(obj.pid)) {
      obj.pid = pidMap.get(obj.pid);
      hit = true;
    }
    return hit;
  };
  const rewrite = (file) => {
    const rows = S.readLines(file);
    const hits = rows.filter(fix).length;
    if (hits) {
      fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      changed += hits;
    }
  };
  let files = [];
  try {
    files = fs.readdirSync(P.HISTORY_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(P.HISTORY_DIR, f));
  } catch {}
  files.forEach(rewrite);
  if (fs.existsSync(P.EVENTS)) rewrite(P.EVENTS);
  // まだ反映されていない管理者の判断のキーも付け替える
  const dec = S.loadDecisions();
  let decChanged = false;
  for (const d of dec.decisions) if (keyMap.has(d.key)) { d.key = keyMap.get(d.key); decChanged = true; }
  if (decChanged) S.saveDecisions(dec);
  return changed;
}

// 収集の最初に呼ぶ。統合が必要なら実行して、結果を返す
function reconcile(config, state, products, { dryRun = false } = {}) {
  const aliases = S.readJson(P.ALIASES, {});
  const autoStoreIds = new Set(config.stores.filter((s) => s.type !== 'manual').map((s) => s.id));
  const { plans, skipped } = planMerges(state, products, aliases, autoStoreIds);
  const result = { plans, skipped, moved: 0, rewritten: 0 };
  if (!plans.length || dryRun) return result;
  const pidMap = new Map(plans.flatMap((p) => p.drop.map((d) => [d, p.keep])));
  const keyMap = applyPlans(state, products, plans);
  result.moved = keyMap.size;
  result.rewritten = rewriteFiles(keyMap, pidMap);
  return result;
}

module.exports = { planMerges, applyPlans, rewriteFiles, reconcile };

if (require.main === module) {
  const config = S.readJson(P.CONFIG, null);
  const state = S.loadState();
  const products = S.loadProducts();
  const apply = process.argv.includes('--apply');
  const r = reconcile(config, state, products, { dryRun: !apply });
  if (!r.plans.length && !r.skipped.length) console.log('統合が必要な商品はありません');
  for (const p of r.plans) console.log(`統合${apply ? '' : '予定'}: [${p.game}] 「${p.name}」に ${p.drop.map((d) => products[d]?.name || d).join(' / ')} をまとめる`);
  for (const s of r.skipped) console.warn(`  ! ${s.names.join(' / ')}: ${s.reason}`);
  if (apply && r.plans.length) {
    S.saveState(state);
    S.saveProducts(products);
    console.log(`保存しました（データ ${r.moved} 件を付け替え、履歴・イベント ${r.rewritten} 行を更新）`);
  }
}
