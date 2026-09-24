// フラッグシップバトルの記念品カード、配布枚数の推定データを作る。
//   node scripts/flagship/build.js
// config/flagship.json（回・シリーズ・記念品と配布ルール）と data/flagship/<seriesId>.json（開催実績）から、
// docs/data/flagship.json を生成する。
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', '..', 'config', 'flagship.json');
const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'flagship');
const IMG_DIR = path.join(__dirname, '..', '..', 'docs', 'img', 'flagship');
const OUT = path.join(__dirname, '..', '..', 'docs', 'data', 'flagship.json');

// docs/img/flagship/round<id>-winner.* / round<id>-best8.* があれば、そのファイル名（拡張子込み）を返す
function findImage(id, key) {
  const hit = fs.readdirSync(IMG_DIR).find((f) => f.startsWith(`round${id}-${key}.`));
  return hit ? `img/flagship/${hit}` : null;
}

function loadSeries(seriesId) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${seriesId}.json`), 'utf8'));
}

// 定員(人数)ごとの開催数を数える。キャンセルされた回は、記念品が配られないので数えない
function tally(events) {
  const byCapacity = {};
  let canceled = 0;
  let active = 0;
  for (const e of events) {
    if (e.is_canceled) { canceled++; continue; }
    active++;
    const c = String(e.max_join_count);
    byCapacity[c] = (byCapacity[c] || 0) + 1;
  }
  return { total: events.length, canceled, active, byCapacity };
}

function estimate(byCapacity, rules) {
  let n = 0;
  for (const [cap, count] of Object.entries(byCapacity)) n += count * (rules[cap] ?? 0);
  return n;
}

function build() {
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const rounds = config.rounds.map((round) => {
    const series = round.series.map((s) => {
      const events = loadSeries(s.seriesId);
      const t = tally(events);
      const fetchedDates = events.map((e) => e.applicants_fetched_at).filter(Boolean).sort();
      return { ...s, ...t, fetchedAt: fetchedDates[fetchedDates.length - 1] || null };
    });
    const totals = { total: 0, canceled: 0, active: 0, byCapacity: {} };
    for (const s of series) {
      totals.total += s.total;
      totals.canceled += s.canceled;
      totals.active += s.active;
      for (const [cap, count] of Object.entries(s.byCapacity)) totals.byCapacity[cap] = (totals.byCapacity[cap] || 0) + count;
    }
    const prizes = round.prizes.map((p) => ({ ...p, estimate: estimate(totals.byCapacity, p.rules) }));
    return { id: round.id, label: round.label, period: round.period, series, totals, prizes };
  });
  rounds.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true })); // 新しい回が先

  // 歴代の記念品カード一覧（画像つき）。rounds に同じ id の推定データがあれば、そこから枚数を拾って添える
  const estimateByCode = new Map();
  for (const r of rounds) for (const p of r.prizes) estimateByCode.set(p.cardCode, p.estimate);
  const history = (config.history || []).map((h) => {
    const fill = (key, side) => ({ ...side, image: findImage(h.id, key), estimate: estimateByCode.has(side.cardCode) ? estimateByCode.get(side.cardCode) : null });
    return { id: h.id, period: h.period, winner: fill('winner', h.winner), best8: fill('best8', h.best8) };
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), rounds, history }));
  console.log(`docs/data/flagship.json を作成しました（推定 ${rounds.length}回ぶん、歴代一覧 ${history.length}回ぶん）`);
  for (const r of rounds) {
    console.log(`  ${r.label}: 開催 ${r.totals.active}件（キャンセル ${r.totals.canceled}件除く） / 定員内訳 ${JSON.stringify(r.totals.byCapacity)}`);
    for (const p of r.prizes) console.log(`    ${p.label}「${p.cardName}」推定 ${p.estimate.toLocaleString('ja-JP')}枚`);
  }
}

build();
