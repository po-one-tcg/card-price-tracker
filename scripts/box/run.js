// BOX価格トラッカーの収集。各店舗のページを取得 → 出現/消滅/異常を判定 → data/box/ に保存。
//   node scripts/box/run.js                     全店舗を収集して保存
//   node scripts/box/run.js --dry-run           保存せず判定結果だけ表示
//   node scripts/box/run.js --file p.html --game pokemon   保存済みHTMLで動作確認（テスト用）
//   node scripts/box/run.js --no-images         画像を保存しない
// 環境変数 OUT_ROOT で保存先を、NOW_ISO で現在時刻を差し替えられる（テスト用）。
const fs = require('fs');
const path = require('path');
const { jstNow, fetchWithRetry, norm, shortHash, sleep, downloadImage } = require('../lib/common');
const { step, applyDecision } = require('../lib/detect');
const P = require('./paths');
const S = require('./store');
const { processInbox } = require('./manual');
const { reconcile } = require('./merge');
const Expo = require('../../docs/admin/expo-parser.js');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const option = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : null;
};
const DRY_RUN = flag('dry-run');
const NO_IMAGES = flag('no-images');
const MIN_KEEP_RATIO = 0.6; // 前回の6割未満しか取れなかったら「消滅」ではなく取得不良とみなして無効にする

const yen = (n) => (n == null ? '-' : `¥${n.toLocaleString('ja-JP')}`);
const EVENT_LABEL = { appear: '🆕 出現', disappear: '✕ 消滅', anomaly: '⚠ 要確認(保留)', approved: '✔ 承認', corrected: '✎ 修正', dismissed: '✔ 据え置き' };

// 観測（ページの1行）→ detect.js に渡す観測へ
function toObservation(row) {
  if (row.status === 'price') return { kind: 'value', price: row.price };
  if (row.status === 'closed') return { kind: 'absent' }; // 買取停止（在庫なし）。掲載なしと同じ扱い
  return { kind: 'unknown' };
}

async function runSource(store, src, ctx) {
  const { now, state, products, config } = ctx;
  const metaKey = `${store.id}|${src.game}`;
  const localFile = option('file');
  const mod = require(`../sites/${src.parser}.js`);
  let rows;
  if (mod.load) {
    // API から取得するタイプ（RUNTO など）。--file には取得済みの JSON（{ parents, variations }）を渡せる
    rows = await mod.load(src, { fetchWithRetry, data: localFile ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : undefined });
  } else {
    const html = localFile ? fs.readFileSync(localFile, 'utf8') : await fetchWithRetry(src.url);
    rows = mod.parse(html, src.url);
  }
  console.log(`ページ全体: ${rows.length} 行${rows.skippedVariations ? `（対象外の状態 ${rows.skippedVariations} 件は除外）` : ''}`);
  if (rows.length < (src.minRows || 1)) {
    throw new Error(`抽出が ${rows.length} 行しかありません（最低 ${src.minRows}）。サイトの構造が変わった可能性があります`);
  }

  // 商品の照合: 名前の表記ゆれ（全角半角・空白・BOX の有無など）と、対応表（config/product-aliases.json）を見て、
  // すでに登録済みの同じ商品があればその商品IDを使う
  const resolve = Expo.makeResolver(S.readJson(P.ALIASES, {}));
  const index = ctx.productIndex || (ctx.productIndex = new Map());
  if (!ctx.productIndexBuilt) {
    for (const p of Object.values(products)) if (!index.has(`${p.game}|${resolve(p.game, p.name)}`)) index.set(`${p.game}|${resolve(p.game, p.name)}`, p.id);
    ctx.productIndexBuilt = true;
  }
  const pidFor = (row) => {
    const k = `${src.game}|${resolve(src.game, row.name)}`;
    if (!index.has(k)) index.set(k, `${src.game}_${shortHash(norm(row.name))}`);
    return index.get(k);
  };

  // 同じ商品が複数の区分に載っている場合は最初の区分に寄せる。1商品に複数の状態（シュリンク有/無など）があってもよい
  const seen = new Map(); // 商品ID → { pid, row, groups }
  const rowsByKey = new Map(); // "商品ID|状態" → row
  for (const row of rows) {
    const pid = pidFor(row);
    const cond = row.cond || src.condition;
    const rk = `${pid}|${cond}`;
    if (rowsByKey.has(rk)) continue; // 同じ商品・同じ状態が重複していたら最初の行を採用
    rowsByKey.set(rk, { ...row, cond, pid });
    const prev = seen.get(pid);
    if (prev) {
      if (row.pack && !prev.groups.includes(row.pack)) prev.groups.push(row.pack);
      continue;
    }
    seen.set(pid, { pid, row, groups: row.pack ? [row.pack] : [] });
  }

  const prevCount = state.meta[metaKey]?.lastCount;
  if (prevCount && rowsByKey.size < prevCount * MIN_KEEP_RATIO) {
    throw new Error(`商品数が前回 ${prevCount} → 今回 ${rowsByKey.size} に急減しました。誤って「消滅」と判定しないよう、この回は無効にします`);
  }

  const baseline = Boolean(state.meta[metaKey]?.lastOkAt);
  const t = { now: now.stamp, baseline, thresholdPct: config.thresholdPct };
  const historyRows = [];
  const events = [];
  const record = (key, ref, result) => {
    state.entries[key] = { ...result.entry, ref };
    for (const r of result.rows) historyRows.push({ t: r.t, k: key, st: r.st, v: r.v });
    for (const ev of result.events) {
      events.push({ ...ev, k: key, store: ref.store, game: ref.game, pid: ref.pid, name: products[ref.pid]?.name || seen.get(ref.pid)?.row.name });
    }
  };

  // 商品マスタ更新（先に登録して、イベントに名前を付けられるようにする）
  for (const { pid, row, groups } of seen.values()) {
    const ex = products[pid];
    products[pid] = {
      id: pid,
      game: src.game,
      name: row.name,
      group: ex?.group || groups[0] || '',
      groups: [...new Set([...(ex?.groups || []), ...groups])],
      imageUrl: row.imageUrl || ex?.imageUrl || null,
      image: ex?.image || null,
      firstSeen: ex?.firstSeen || now.date,
      lastSeen: now.date,
    };
  }

  // 今回ページにある商品
  const presentKeys = new Set();
  for (const row of rowsByKey.values()) {
    const key = `${store.id}|${row.pid}|${row.cond}`;
    presentKeys.add(key);
    const ref = { store: store.id, game: src.game, pid: row.pid, cond: row.cond };
    record(key, ref, step(state.entries[key], toObservation(row), t));
  }
  // 以前は載っていたのに今回ページに無い商品 = 掲載なし（取得に成功した回だけここに来る）
  // 1つの取得元に状態が複数ある店舗(rowConditions)は、状態を問わず同じ店舗・ゲームのものを対象にする
  for (const [key, entry] of Object.entries(state.entries)) {
    const r = entry.ref;
    if (r.store !== store.id || r.game !== src.game || presentKeys.has(key)) continue;
    if (!src.rowConditions && r.cond !== src.condition) continue;
    record(key, r, step(entry, { kind: 'absent' }, t));
  }

  state.meta[metaKey] = { lastOkAt: now.stamp, lastCount: rowsByKey.size };
  const counts = { present: rowsByKey.size, unknown: [...rowsByKey.values()].filter((r) => r.status === 'unknown').length, closed: [...rowsByKey.values()].filter((r) => r.status === 'closed').length };
  return { metaKey, historyRows, events, counts, baseline, pids: [...seen.keys()] };
}

async function fetchMissingImages(products, pids) {
  const out = { saved: 0, failed: 0 };
  for (const pid of pids) {
    const p = products[pid];
    if (p.image || !p.imageUrl) continue;
    try {
      const file = await downloadImage(p.imageUrl, P.IMG_DIR, pid);
      p.image = `img/box/${file}`;
      out.saved++;
    } catch (e) {
      console.warn(`  ! 画像保存失敗 ${p.name}: ${e.message}（次回また試します）`);
      out.failed++;
    }
    await sleep(300);
  }
  return out;
}

function applyPendingDecisions(state, products, now, allHistory, allEvents) {
  const file = S.loadDecisions();
  let applied = 0;
  for (const d of file.decisions) {
    if (d.appliedAt) continue;
    try {
      const entry = state.entries[d.key];
      const res = applyDecision(entry, d, now.stamp);
      state.entries[d.key] = { ...res.entry, ref: entry.ref };
      for (const r of res.rows) allHistory.push({ t: r.t, k: d.key, st: r.st, v: r.v });
      for (const ev of res.events) allEvents.push({ ...ev, k: d.key, store: entry.ref.store, game: entry.ref.game, pid: entry.ref.pid, name: products[entry.ref.pid]?.name });
      d.appliedAt = now.stamp;
      applied++;
    } catch (e) {
      d.appliedAt = now.stamp;
      d.error = e.message;
      console.warn(`  ! 管理者の判断を反映できませんでした (${d.key}): ${e.message}`);
    }
  }
  if (applied || file.decisions.some((d) => d.error && d.appliedAt === now.stamp)) S.saveDecisions(file);
  return applied;
}

async function main() {
  const config = S.readJson(P.CONFIG, null);
  if (!config) throw new Error('config/box-targets.json を読み込めません');
  const now = jstNow();
  const state = S.loadState();
  const products = S.loadProducts();

  const backupFile = DRY_RUN ? null : S.makeBackup(now);
  if (backupFile) console.log(`バックアップ作成: ${path.relative(P.ROOT, backupFile)}`);

  const allHistory = [];
  const allEvents = [];
  const runLines = [];
  const errors = [];
  const summaries = [];

  // 同じ商品の別表記（config/product-aliases.json）が別商品として入っていたら、1つに統合する
  const merged = reconcile(config, state, products, { dryRun: DRY_RUN });
  for (const p of merged.plans) console.log(`商品を統合${DRY_RUN ? '(予定)' : ''}: 「${p.name}」に ${p.drop.length} 件をまとめました`);
  for (const s of merged.skipped) console.warn(`  ! 商品を統合できません: ${s.names.join(' / ')}（${s.reason}）`);

  const applied = applyPendingDecisions(state, products, now, allHistory, allEvents);
  if (applied) console.log(`管理者の判断を ${applied} 件反映しました`);

  for (const store of config.stores) {
    for (const src of store.sources || []) {
      if (src.enabled === false) continue;
      if (option('game') && src.game !== option('game')) continue;
      console.log(`\n=== ${store.name} / ${src.game} (${src.url}) ===`);
      try {
        const res = await runSource(store, src, { now, state, products, config });
        allHistory.push(...res.historyRows);
        allEvents.push(...res.events);
        runLines.push({ t: now.stamp, store: store.id, game: src.game, ok: true, count: res.counts.present });
        let images = null;
        if (!DRY_RUN && !NO_IMAGES) {
          const need = res.pids.filter((pid) => !products[pid].image && products[pid].imageUrl);
          console.log(`画像の未保存商品: ${need.length} 件`);
          images = await fetchMissingImages(products, need);
          if (need.length) console.log(`画像: 保存 ${images.saved} / 失敗 ${images.failed}`);
        }
        console.log(`商品 ${res.counts.present} 件（うち金額なし・未確認 ${res.counts.unknown} 件）${res.baseline ? '' : ' ※初回のため基準データとして保存（出現/消滅は判定しません）'}`);
        summaries.push({ store: store.name, game: src.game, ...res.counts, images, baseline: res.baseline });
      } catch (e) {
        console.error(`ERROR: ${e.message}`);
        errors.push(e);
        runLines.push({ t: now.stamp, store: store.id, game: src.game, ok: false, error: e.message });
      }
    }
  }

  // 手動入力店舗（買取EXPOなど）: 管理画面から届いた取り込みデータを反映
  const manual = processInbox({ config, state, products, now, dryRun: DRY_RUN });
  allHistory.push(...manual.historyRows);
  allEvents.push(...manual.events);
  runLines.push(...manual.runLines);
  if (manual.reports.length) console.log('\n=== 手動入力の取り込み ===');
  for (const r of manual.reports) {
    if (!r.ok) {
      console.error(`ERROR ${r.file}: ${r.error}`);
      continue;
    }
    if (r.type === 'full') {
      for (const b of r.blocks) {
        if (b.rejected) console.log(`  ✕ ${b.sectionId}: ${b.reason}`);
        else if (b.skipped) console.log(`  - ${b.sectionId}: 対象外`);
        else console.log(`  ✓ ${b.sectionId}: ${b.items}件（〆切${b.closed} / 新規商品${b.newProducts} / 掲載なし${b.absent}）${b.baseline ? '' : ' ※初回のため基準データ'}`);
      }
    }
    if (r.type === 'update') for (const b of r.blocks) console.log(`  ✓ 価格変更 ${b.updated}件${b.unmatched.length ? ' / 該当なし: ' + b.unmatched.join(', ') : ''}`);
    if (r.type === 'paused') console.log(`  ✓ 本日休止 ${r.paused}件`);
  }
  for (const m of manual.errors) errors.push(new Error(m));

  // 結果の表示
  console.log('\n--- 今回の検知 ---');
  const byType = {};
  for (const ev of allEvents) byType[ev.type] = (byType[ev.type] || 0) + 1;
  if (!allEvents.length) console.log('変化なし（出現・消滅・異常はありません）');
  for (const ev of allEvents) {
    const detail = ev.type === 'anomaly' ? `${yen(ev.from)} → ${yen(ev.to)}` : ev.type === 'disappear' ? `（直前 ${yen(ev.from)}）` : yen(ev.to);
    console.log(`${EVENT_LABEL[ev.type] || ev.type}: [${ev.store}] ${ev.name} ${detail}`);
  }
  const pendingNow = Object.values(state.entries).filter((e) => e.pending).length;
  console.log(`保留中（要確認）: ${pendingNow} 件`);

  if (DRY_RUN) {
    console.log('(dry-run: 保存はしません)');
  } else {
    if (runLines.some((r) => r.ok) || manual.reports.some((r) => r.ok) || merged.moved) {
      S.saveState(state);
      S.saveProducts(products);
    }
    S.appendLines(path.join(P.HISTORY_DIR, `${now.date}.jsonl`), allHistory);
    S.appendLines(P.EVENTS, allEvents);
    S.appendLines(P.RUNS, runLines);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    let md = `## BOX価格トラッカー (${now.stamp})\n\n`;
    for (const s of summaries) md += `- ${s.store} / ${s.game}: 商品 ${s.present} 件（未確認 ${s.unknown}）${s.baseline ? '' : ' ※初回基準'}\n`;
    md += `\n検知: ${Object.entries(byType).map(([k, v]) => `${EVENT_LABEL[k] || k} ${v}`).join(' / ') || 'なし'}　保留中: ${pendingNow} 件\n`;
    for (const ev of allEvents) md += `- ${EVENT_LABEL[ev.type] || ev.type}: ${ev.name}\n`;
    for (const e of errors) md += `\n**エラー**: ${e.message}\n`;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
  if (errors.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
