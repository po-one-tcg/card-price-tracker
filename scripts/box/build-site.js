// 公開ページ用のデータ（docs/data/box.json）を data/box/ から生成する。
//   node scripts/box/build-site.js
//
// 守っているルール（仕様書 5・8章）:
//  - 最新の巡回に成功していない（freshHours を超えた）店舗のセルは「未確認」とし、価格を引き継いで表示しない
//  - 日次の値は「その日の最後の成功した巡回」の時点の公開状態。巡回に成功しなかった日は空白（前日の値で埋めない）
//  - 平均は、その日に金額が付いている店舗だけで計算する（空欄を0円として含めない）
const fs = require('fs');
const path = require('path');
const { jstNow } = require('../lib/common');
const P = require('./paths');
const S = require('./store');

const PERIODS = [1, 7, 14, 30, 90, 180];
const KEEP_DAYS = 190;
const DAY = 86400000;

const dayNum = (d) => Math.floor(Date.parse(d.slice(0, 10) + 'T00:00:00Z') / DAY);
const numToDate = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const ms = (stamp) => Date.parse(stamp);

function build() {
  const config = S.readJson(P.CONFIG, null);
  const now = jstNow();
  const state = S.loadState();
  const products = S.loadProducts();
  const history = S.loadHistory().sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const runs = S.readLines(P.RUNS);
  const events = S.readLines(P.EVENTS);
  const today = now.date;
  const todayNum = dayNum(today);

  // ---- 店舗×ゲームの巡回状況 ----
  const okRuns = runs.filter((r) => r.ok);
  const sourceStatus = {};
  for (const r of runs) {
    const k = `${r.store}|${r.game}`;
    const s = (sourceStatus[k] ??= { lastRunAt: null, lastRunOk: null, lastOkAt: null });
    if (!s.lastRunAt || r.t > s.lastRunAt) {
      s.lastRunAt = r.t;
      s.lastRunOk = r.ok;
      if (r.ok) delete s.lastError;
      else s.lastError = r.error;
    }
    if (r.ok && (!s.lastOkAt || r.t > s.lastOkAt)) s.lastOkAt = r.t;
  }
  for (const s of Object.values(sourceStatus)) {
    s.fresh = s.lastOkAt ? ms(now.stamp) - ms(s.lastOkAt) <= config.freshHours * 3600 * 1000 : false;
    s.staleDays = s.lastOkAt ? Math.max(0, todayNum - dayNum(s.lastOkAt)) : null;
  }

  // ---- 日ごとの「最後の成功した巡回」----
  const lastRunOfDay = {}; // "store|game" -> { date: stamp }
  for (const r of okRuns) {
    const m = (lastRunOfDay[`${r.store}|${r.game}`] ??= {});
    const d = r.t.slice(0, 10);
    if (!m[d] || r.t > m[d]) m[d] = r.t;
  }

  // ---- 履歴をキーごとにまとめる ----
  const rowsByKey = {};
  for (const r of history) (rowsByKey[r.k] ??= []).push(r);

  // key -> { date: {st, v} }（その日の最後の成功巡回の時点の公開状態）
  const dailyByKey = {};
  for (const [key, entry] of Object.entries(state.entries)) {
    const { store, game } = entry.ref;
    const days = lastRunOfDay[`${store}|${game}`] || {};
    const rows = rowsByKey[key] || [];
    const out = {};
    for (const [date, stamp] of Object.entries(days)) {
      if (todayNum - dayNum(date) > KEEP_DAYS) continue;
      let cur = null;
      for (const r of rows) {
        if (r.t <= stamp) cur = r;
        else break;
      }
      if (cur) out[date] = { st: cur.st, v: cur.v };
    }
    dailyByKey[key] = out;
  }

  // ---- 商品ごとに組み立て ----
  const eventCutoff = todayNum - config.eventDays;
  const outProducts = [];
  const byProduct = {};
  for (const [key, entry] of Object.entries(state.entries)) (byProduct[entry.ref.pid] ??= []).push([key, entry]);

  for (const [pid, list] of Object.entries(byProduct)) {
    const p = products[pid];
    if (!p) continue;
    const cells = [];
    for (const [key, entry] of list) {
      const { store, game, cond } = entry.ref;
      const status = sourceStatus[`${store}|${game}`];
      const fresh = status?.fresh ?? false;
      const ev = entry.lastEvent && dayNum(entry.lastEvent.at) >= eventCutoff ? entry.lastEvent : null;
      const sh = entry.shown || { state: 'unknown', price: null };
      // 最新の巡回に成功していなければ「未確認」。価格は出さない
      cells.push(
        fresh
          ? { store, cond, state: sh.state, price: sh.price, since: sh.since, event: ev }
          : { store, cond, state: 'stale', price: null, since: sh.since, event: null, staleDays: status?.staleDays ?? null }
      );
    }

    // 状態ごとの日次系列と統計
    const conds = [...new Set(list.map(([, e]) => e.ref.cond))];
    const series = {};
    const stats = {};
    for (const cond of conds) {
      const keys = list.filter(([, e]) => e.ref.cond === cond);
      const dates = [...new Set(keys.flatMap(([k]) => Object.keys(dailyByKey[k] || {})))].sort();
      const avg = [];
      const n = [];
      const perStore = Object.fromEntries(keys.map(([, e]) => [e.ref.store, []]));
      for (const d of dates) {
        const vals = [];
        for (const [k, e] of keys) {
          const cell = dailyByKey[k]?.[d];
          const v = cell && cell.st === 'value' ? cell.v : null;
          perStore[e.ref.store].push(v);
          if (v !== null) vals.push(v);
        }
        avg.push(vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null);
        n.push(vals.length);
      }
      series[cond] = { dates, avg, n, stores: perStore };

      // 期間別の差額・変化率
      let li = -1;
      for (let i = avg.length - 1; i >= 0; i--) if (avg[i] !== null) { li = i; break; }
      const periods = {};
      if (li >= 0) {
        const latestNum = dayNum(dates[li]);
        for (const days of PERIODS) {
          const target = latestNum - days;
          let best = -1;
          for (let i = 0; i < dates.length; i++) {
            if (avg[i] === null) continue;
            const dist = Math.abs(dayNum(dates[i]) - target);
            if (dist <= 1 && (best < 0 || dist < Math.abs(dayNum(dates[best]) - target))) best = i;
          }
          periods[days] =
            best >= 0 && best !== li
              ? { base: avg[best], baseDate: dates[best], baseN: n[best], diff: avg[li] - avg[best], pct: ((avg[li] - avg[best]) / avg[best]) * 100 }
              : null;
        }
      }
      stats[cond] = { now: li >= 0 ? avg[li] : null, nowN: li >= 0 ? n[li] : 0, nowDate: li >= 0 ? dates[li] : null, periods };
    }

    outProducts.push({ id: pid, game: p.game, name: p.name, group: p.group, image: p.image, cells, series, stats });
  }
  outProducts.sort((a, b) => (a.group + a.name).localeCompare(b.group + b.name, 'ja'));

  // ---- 公開する出現・消滅の一覧（直近30日）----
  const feedCutoff = todayNum - 30;
  const feed = events
    .filter((e) => (e.type === 'appear' || e.type === 'disappear') && dayNum(e.t) >= feedCutoff)
    .map((e) => ({ t: e.t, type: e.type, store: e.store, game: e.game, pid: e.pid, name: e.name, price: e.type === 'appear' ? e.to : e.from }))
    .sort((a, b) => (a.t < b.t ? 1 : -1))
    .slice(0, 100);

  const out = {
    generatedAt: now.stamp,
    today,
    freshHours: config.freshHours,
    eventDays: config.eventDays,
    periods: PERIODS,
    games: config.games,
    conditions: config.conditions,
    stores: config.stores.map((s) => ({ id: s.id, name: s.name, type: s.type })),
    sourceStatus,
    products: outProducts,
    feed,
  };
  fs.mkdirSync(path.join(P.DOCS_DIR, 'data'), { recursive: true });
  fs.writeFileSync(path.join(P.DOCS_DIR, 'data', 'box.json'), JSON.stringify(out));

  // 管理者画面用: 要確認リスト
  const pending = Object.entries(state.entries)
    .filter(([, e]) => e.pending)
    .map(([key, e]) => ({ key, store: e.ref.store, game: e.ref.game, pid: e.ref.pid, name: products[e.ref.pid]?.name, prevPrice: e.pending.prevPrice, price: e.pending.price, since: e.pending.since }));
  fs.writeFileSync(path.join(P.DOCS_DIR, 'data', 'pending.json'), JSON.stringify({ generatedAt: now.stamp, pending }));

  console.log(`公開データを生成: 商品 ${outProducts.length} 件 / 出現・消滅の通知 ${feed.length} 件 / 要確認 ${pending.length} 件`);
  const size = fs.statSync(path.join(P.DOCS_DIR, 'data', 'box.json')).size;
  console.log(`docs/data/box.json: ${(size / 1024).toFixed(0)} KB`);
}

build();
