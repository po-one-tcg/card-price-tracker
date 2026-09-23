// BOXトラッカーのデータ読み書き（state / products / decisions / 履歴 / バックアップ）。
const fs = require('fs');
const path = require('path');
const P = require('./paths');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data, indent = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, indent) + '\n');
}

function appendLines(file, objs) {
  if (!objs.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const sortKeys = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));

const loadState = () => readJson(P.STATE, { version: 1, meta: {}, entries: {} });
const saveState = (s) => writeJson(P.STATE, { ...s, entries: sortKeys(s.entries) });
const loadProducts = () => readJson(P.PRODUCTS, {});
const saveProducts = (p) => writeJson(P.PRODUCTS, sortKeys(p));
const loadDecisions = () => readJson(P.DECISIONS, { decisions: [] });
const saveDecisions = (d) => writeJson(P.DECISIONS, d);
const loadRestocks = () => readJson(P.RESTOCKS, { restocks: [] });
const saveRestocks = (d) => writeJson(P.RESTOCKS, d);

function loadHistory() {
  let files = [];
  try {
    files = fs.readdirSync(P.HISTORY_DIR).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {}
  return files.flatMap((f) => readLines(path.join(P.HISTORY_DIR, f)));
}

// ---- バックアップ（仕様書10章）----
// 更新の直前に、状態・商品・管理者の判断・当日の履歴をまとめて日付つきで保存する。
// 履歴は追記のみなので全量は含めない（Gitの履歴にも残る）。古いものは間引く。
function makeBackup(now) {
  if (!fs.existsSync(P.STATE)) return null;
  const stampName = now.stamp.slice(0, 16).replace('T', '_').replace(':', '');
  const file = path.join(P.BACKUP_DIR, `${stampName}_before-update.json`);
  const todayHistory = readLines(path.join(P.HISTORY_DIR, `${now.date}.jsonl`));
  writeJson(
    file,
    { createdAt: now.stamp, state: loadState(), products: loadProducts(), decisions: loadDecisions(), historyToday: todayHistory },
    0
  );
  pruneBackups(now.date);
  return file;
}

// 直近7日はすべて残す。8日〜90日は1日1つ（最後のもの）。90日より古いものは削除。
function pruneBackups(today) {
  let files = [];
  try {
    files = fs.readdirSync(P.BACKUP_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}_\d{4}_before-update\.json$/.test(f)).sort();
  } catch {
    return;
  }
  const dayNum = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);
  const todayNum = dayNum(today);
  const lastOfDay = new Map();
  for (const f of files) lastOfDay.set(f.slice(0, 10), f);
  for (const f of files) {
    const age = todayNum - dayNum(f.slice(0, 10));
    const remove = age > 90 || (age > 7 && lastOfDay.get(f.slice(0, 10)) !== f);
    if (remove) fs.unlinkSync(path.join(P.BACKUP_DIR, f));
  }
}

module.exports = {
  readJson, writeJson, appendLines, readLines,
  loadState, saveState, loadProducts, saveProducts, loadDecisions, saveDecisions, loadRestocks, saveRestocks, loadHistory,
  makeBackup, pruneBackups,
};
