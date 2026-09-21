// 手動入力店舗（買取EXPOなど）の取り込み。
// 管理画面が data/box/manual/inbox/*.json に置いた「取り込みデータ」を読み、判定にかけて state に反映する。
// 処理した取り込みデータは data/box/manual/done/ に移す（結果つき）。
//
// 取り込みデータ:
//   { id, store, type: 'full'|'update'|'paused', createdAt, rawText?,
//     blocks: [{ sectionId, items: [{ name, cond, price|null, closed, game }], confirmedDrop? }],   // full
//     blocks: [{ items: [{ name, cond|null, price }] }],                                            // update
//     sections?: ['pokemon-box', ...] }                                                             // paused（省略で全区分）
//
//  full   : 区分（✅見出し）ごとの「全商品リスト」。載っていない既存商品は「掲載なし」（消滅）になる。
//           ただし前回の6割未満しか載っていない場合は、貼り忘れの可能性があるので取り込まない（確認済みの印があれば取り込む）
//  update : 価格変更のお知らせ。載っている商品の金額だけを更新する（他は触らない）
//  paused : 本日休止。既存商品をすべて「休止」にする（出現・消滅にはカウントしない）
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const S = require('./store');
const { step } = require('../lib/detect');
const { shortHash, norm } = require('../lib/common');
const Expo = require('../../docs/admin/expo-parser.js');

const MIN_KEEP_RATIO = 0.6;
const MIN_GUARD_COUNT = 10; // これ未満の小さな区分ではガードしない

function listInbox() {
  try {
    return fs.readdirSync(P.INBOX_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

// 処理済みの取り込みデータは60日で削除する（内容は Git の履歴にも残る）。ファイル名の先頭が日付のものだけ対象
function pruneDone(todayDate) {
  let files = [];
  try {
    files = fs.readdirSync(P.DONE_DIR);
  } catch {
    return;
  }
  const dayNum = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);
  for (const f of files) {
    const m = f.match(/^(\d{4})(\d{2})(\d{2})/);
    if (m && dayNum(todayDate) - dayNum(`${m[1]}-${m[2]}-${m[3]}`) > 60) fs.unlinkSync(path.join(P.DONE_DIR, f));
  }
}

function processInbox(ctx) {
  const out = { historyRows: [], events: [], runLines: [], reports: [], errors: [] };
  if (!ctx.dryRun) pruneDone(ctx.now.date);
  for (const file of listInbox()) {
    const full = path.join(P.INBOX_DIR, file);
    const report = { file };
    let sub = null;
    try {
      sub = JSON.parse(fs.readFileSync(full, 'utf8'));
      Object.assign(report, applySubmission(sub, ctx, out), { ok: true });
    } catch (e) {
      report.ok = false;
      report.error = e.message;
      out.errors.push(`${file}: ${e.message}`);
    }
    out.reports.push(report);
    if (!ctx.dryRun) {
      fs.mkdirSync(P.DONE_DIR, { recursive: true });
      fs.writeFileSync(path.join(P.DONE_DIR, file), JSON.stringify({ ...(sub || { raw: 'unreadable' }), result: { ...report, at: ctx.now.stamp } }) + '\n');
      fs.unlinkSync(full);
    }
  }
  return out;
}

function applySubmission(sub, ctx, out) {
  const { config, state, products, now } = ctx;
  const store = config.stores.find((s) => s.id === sub.store && s.type === 'manual');
  if (!store) throw new Error(`手動入力の店舗ではありません: ${sub.store}`);
  const condIds = new Set(config.conditions.map((c) => c.id));
  const gameIds = new Set(config.games.map((g) => g.id));

  // 商品の同一判定用の索引（ゲーム + 正規化した名前 → 商品ID）
  const index = new Map();
  const resolve = Expo.makeResolver(S.readJson(P.ALIASES, {})); // config/product-aliases.json（同じ商品の別表記）
  for (const p of Object.values(products)) if (!index.has(`${p.game}|${resolve(p.game, p.name)}`)) index.set(`${p.game}|${resolve(p.game, p.name)}`, p.id);

  const record = (key, ref, result) => {
    state.entries[key] = { ...result.entry, ref };
    for (const r of result.rows) out.historyRows.push({ t: r.t, k: key, st: r.st, v: r.v });
    for (const ev of result.events) out.events.push({ ...ev, k: key, store: ref.store, game: ref.game, pid: ref.pid, name: products[ref.pid]?.name });
  };
  const stepCtx = (baseline) => ({ now: now.stamp, baseline, thresholdPct: config.thresholdPct });
  const entriesOf = (predicate) => Object.entries(state.entries).filter(([, e]) => e.ref.store === store.id && predicate(e.ref));

  function findOrCreateProduct(game, name, section) {
    const k = `${game}|${resolve(game, name)}`;
    let pid = index.get(k);
    let created = false;
    if (!pid) {
      pid = `${game}_${shortHash(norm(name))}`;
      products[pid] = { id: pid, game, name, group: section.group || '', groups: [section.group || ''], imageUrl: null, image: null, firstSeen: now.date, lastSeen: now.date };
      index.set(k, pid);
      created = true;
    } else {
      products[pid].lastSeen = now.date;
      if (section.group && !products[pid].groups.includes(section.group)) products[pid].groups.push(section.group);
    }
    return { pid, created };
  }

  // ---- 全商品リスト（✅見出しごと）----
  function applyFull(block) {
    const section = store.sections.find((s) => s.id === block.sectionId);
    if (!section) return { sectionId: block.sectionId, rejected: true, reason: '設定にない区分です' };
    if (section.kind === 'skip') return { sectionId: section.id, skipped: true };
    for (const it of block.items) {
      if (!it.name || !condIds.has(it.cond) || !gameIds.has(it.game) || !(it.closed === true || (Number.isInteger(it.price) && it.price > 0))) {
        throw new Error(`区分「${section.label}」に不正な項目があります: ${JSON.stringify(it)}`);
      }
    }
    const prevEntries = entriesOf((r) => r.src === section.id);
    if (prevEntries.length >= MIN_GUARD_COUNT && block.items.length < prevEntries.length * MIN_KEEP_RATIO && !block.confirmedDrop) {
      return { sectionId: section.id, rejected: true, reason: `商品数が前回 ${prevEntries.length} → 今回 ${block.items.length} に急減。貼り忘れの可能性があるため取り込みませんでした（内容を確認して「確認済み」にして再送してください）` };
    }
    const baseline = Boolean(state.meta[`${store.id}|${section.id}`]?.lastOkAt);
    const touched = new Set();
    const counts = { items: block.items.length, closed: 0, newProducts: 0, absent: 0 };
    for (const it of block.items) {
      const { pid, created } = findOrCreateProduct(it.game, it.name, section);
      if (created) counts.newProducts++;
      const key = `${store.id}|${pid}|${it.cond}`;
      touched.add(key);
      const ref = { store: store.id, game: it.game, pid, cond: it.cond, src: section.id };
      const obs = it.closed ? { kind: 'absent' } : { kind: 'value', price: it.price };
      if (it.closed) counts.closed++;
      record(key, ref, step(state.entries[key], obs, stepCtx(baseline)));
    }
    for (const [key, e] of prevEntries) {
      if (touched.has(key)) continue;
      counts.absent++;
      record(key, e.ref, step(e, { kind: 'absent' }, stepCtx(baseline)));
    }
    state.meta[`${store.id}|${section.id}`] = { lastOkAt: now.stamp, lastCount: block.items.length };
    out.runLines.push({ t: now.stamp, store: store.id, src: section.id, ok: true, count: block.items.length });
    return { sectionId: section.id, ...counts, baseline };
  }

  // ---- 価格変更のお知らせ ----
  function applyUpdate(block) {
    const counts = { updated: 0, unmatched: [] };
    for (const it of block.items) {
      if (!it.name || !(Number.isInteger(it.price) && it.price > 0)) throw new Error(`価格変更に不正な項目があります: ${JSON.stringify(it)}`);
      const cands = entriesOf((r) => resolve(r.game, products[r.pid]?.name || '') === resolve(r.game, it.name) && (!it.cond || r.cond === it.cond));
      const pick = cands.find(([, e]) => e.ref.cond === 'shrink') || cands.find(([, e]) => e.ref.cond === 'box') || cands[0];
      if (!pick) {
        counts.unmatched.push(it.name);
        continue;
      }
      record(pick[0], pick[1].ref, step(pick[1], { kind: 'value', price: it.price }, stepCtx(true)));
      counts.updated++;
    }
    return counts;
  }

  // ---- 本日休止 ----
  function applyPaused() {
    const ids = sub.sections?.length ? sub.sections : store.sections.filter((s) => s.kind !== 'skip').map((s) => s.id);
    let paused = 0;
    for (const sid of ids) {
      const entries = entriesOf((r) => r.src === sid);
      if (!entries.length) continue;
      for (const [key, e] of entries) {
        record(key, e.ref, step(e, { kind: 'paused' }, stepCtx(true)));
        paused++;
      }
      // 「本日は休止」と確認できたので、この区分は最新（未確認ではない）扱いにする
      state.meta[`${store.id}|${sid}`] = { ...(state.meta[`${store.id}|${sid}`] || {}), lastOkAt: now.stamp };
      out.runLines.push({ t: now.stamp, store: store.id, src: sid, ok: true, count: entries.length, paused: true });
    }
    return { paused };
  }

  if (sub.type === 'full') return { type: 'full', blocks: (sub.blocks || []).map(applyFull) };
  if (sub.type === 'update') return { type: 'update', blocks: (sub.blocks || []).map(applyUpdate) };
  if (sub.type === 'paused') return { type: 'paused', ...applyPaused() };
  throw new Error(`不明な種類: ${sub.type}`);
}

module.exports = { processInbox };
