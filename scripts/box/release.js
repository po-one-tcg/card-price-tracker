// 商品名 → 発売日 の照合と、BOXの並べ替え（区分の中で新しい順）。
// 発売日の表は config/release-dates.json（ポケモンは scripts/box/update-release-dates.js が自動更新）。
const fs = require('fs');
const path = require('path');
const Expo = require('../../docs/admin/expo-parser.js');

const FILE = path.join(__dirname, '..', '..', 'config', 'release-dates.json');

// 照合用のキー: 商品の同一判定(canon)に、アクセント記号(é→e)の違いも吸収する
const key = (name) => Expo.canon(name.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC'));

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

// ゲームごとに「キー → 発売日」の索引を作る
function buildLookup(cfg = loadConfig()) {
  const byGame = {};
  for (const [game, block] of Object.entries(cfg)) {
    if (!block || !block.dates) continue;
    const map = (byGame[game] = new Map());
    // manualDates: 手で書いた発売日（自動更新の update-release-dates.js では消えない。同じ名前があればこちらを優先）
    for (const [name, date] of Object.entries({ ...block.dates, ...(block.manualDates || {}) })) {
      const noParen = name.replace(/[（(][^）)]*[）)]/g, '');
      for (const v of [name, noParen]) {
        const k = key(v);
        map.set(k, date);
        if (k.endsWith('ex')) map.set(k.slice(0, -2), map.get(k.slice(0, -2)) ?? date); // 「スカーレットex」と「スカーレット」
      }
    }
  }
  const aliases = {};
  for (const [game, pairs] of Object.entries(cfg.aliases || {})) aliases[game] = new Map(Object.entries(pairs).map(([from, to]) => [key(from), key(to)]));
  return { byGame, aliases };
}

function releaseFor(lookup, game, name) {
  const map = lookup.byGame[game];
  if (!map) return null;
  const base = key(name.replace(/\s*ペリペリ付/g, '').trim());
  if (map.has(base)) return map.get(base);
  const via = lookup.aliases[game]?.get(base);
  if (via && map.has(via)) return map.get(via);
  return null;
}

// 型番（FB11 / OP-05 など）の数字。発売日が無い商品を、新しい型番が上になるように並べるのに使う
function codeNumber(name) {
  const n = name.normalize('NFKC').trim();
  const m = n.match(/^(?:op|eb|prb|fb|sb|st)-?(\d{2})(?!\d)/i) || n.match(/\[(?:op|eb|prb|fb|sb|st)-?(\d{2})\]$/i);
  return m ? Number(m[1]) : null;
}

// 並び順: 区分の順(ゲームごとの groupOrder) → 区分の中は 発売日が新しい順 → 発売日なしは最後（型番の新しい順、次に名前順）
function compareProducts(groupOrder = {}) {
  const rank = (p) => {
    const order = groupOrder[p.game] || [];
    const i = order.indexOf(p.group);
    return i < 0 ? order.length : i;
  };
  return (a, b) => {
    if (a.game !== b.game) return a.game < b.game ? -1 : 1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.group !== b.group) return a.group.localeCompare(b.group, 'ja');
    if (a.release && b.release) {
      if (a.release !== b.release) return a.release < b.release ? 1 : -1;
      return a.name.localeCompare(b.name, 'ja');
    }
    if (a.release) return -1;
    if (b.release) return 1;
    const ca = codeNumber(a.name), cb = codeNumber(b.name);
    if (ca !== null && cb !== null && ca !== cb) return cb - ca;
    return a.name.localeCompare(b.name, 'ja');
  };
}

module.exports = { loadConfig, buildLookup, releaseFor, compareProducts, codeNumber };
