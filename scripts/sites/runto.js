// RUNTO (runto666.com) の買取価格。WooCommerce の公開API（Store API）から取得する。
//   商品: GET /wp-json/wc/store/v1/products?per_page=100&page=N
//   状態(シュリンク有/無・カートンなど)ごとの価格・在庫: GET .../products?type=variation
// 「在庫あり」= 買取中、「在庫なし」= 買取停止（EXPOの〆切と同じ扱い）。
// 全部で API 4回ほど（商品2ページ + バリエーション2ページ）。取得した内容は1回の実行の間だけ使い回す。
const cheerio = require('cheerio');
const Expo = require('../../docs/admin/expo-parser.js');

const decode = (s) => cheerio.load(`<p>${s}</p>`).text();

// ---- 状態（バリエーションの属性）→ このツールの状態ID ----
// 属性名:値 で判定する（「2」「3」などの値は属性ごとに意味が違うため）。
const COND = {
  'シュリンク:ari': 'shrink',
  'シュリンク:nashi': 'noshrink',
  'シュリンク:case': 'carton',
  'シュリンク:5': 'tapecut', // テープカット
  'シュリンク:パックサーチ痕跡買取不可': 'pack',
  'シュリンク:peripri': 'shrink', // 新:ペリペリ・シュリンク有
  'シュリンク:peripri-2': 'noshrink', // 新:ペリペリ・シュリンク無
  'デッキ:1': 'carton',
  'デッキ:2': 'whitebox', // 白箱
  'デッキ:3': 'box',
  'カートン:unopened': 'carton',
  // 対象外: 'シュリンク:2'（ぺりぺり無し・サーチ買取不可）, 'シュリンク:シュリンク：有'（旧）, 'セット:3'（5枚セット）
};
// 主な状態（同じ状態が重複したときは、こちらを優先）
const PRIMARY = new Set(['シュリンク:ari', 'シュリンク:nashi', 'シュリンク:case', 'デッキ:3']);
// ゲームごとの上書き: ワンピース・ドラゴンボールは「シュリンク」ではなく「テープ」表記（EXPO・コレクトに合わせる）。
// 遊戯王はポケモンと同じくシュリンク表記のため、上書きなし（COND のシュリンク有/無をそのまま使う）。
const GAME_COND_OVERRIDE = {
  onepiece: { 'シュリンク:ari': 'tape', 'シュリンク:peripri': 'tape', 'シュリンク:nashi': 'tapecut', 'シュリンク:peripri-2': 'tapecut' },
  dragonball: { 'シュリンク:ari': 'tape', 'シュリンク:peripri': 'tape', 'シュリンク:nashi': 'tapecut', 'シュリンク:peripri-2': 'tapecut' },
};

// ---- 商品名の整理: 他の店の表記に揃える ----
const TYPE_WORDS = '(?:拡張パック|強化拡張パック|ハイクラスパック|ブースターパック|エクストラブースター|プレミアムブースター|コンセプトパック)';
const PREFIX = {
  pokemon: /^(?:ポケモンカードゲーム\s*)+/,
  onepiece: /^(?:ONE ?PIECE\s*カードゲーム\s*)+/i,
  dragonball: /^(?:ドラゴンボール\s*スーパーカードゲーム\s*(?:フュージョンワールド)?\s*)+/,
  yugioh: /^(?:遊?戯王\s*(?:OCG)?\s*(?:デュエルモンスターズ)?\s*)+/i,
};

function cleanTitle(raw, game) {
  let n = decode(raw).normalize('NFKC').replace(/\s+/g, ' ').trim();
  let code = null;
  const cm = n.match(/【\s*([A-Za-z]+-?\d+)\s*】/);
  if (cm) {
    code = cm[1].toUpperCase();
    n = n.replace(cm[0], ' ');
  }
  n = n.replace(PREFIX[game] || /^$/, '');
  if (game === 'pokemon') {
    // 「拡張パック「ストームエメラルダ」」→ ストームエメラルダ（種類の語の直後の「」だけ中身を取り出す）
    const q = n.match(new RegExp(`${TYPE_WORDS}\\s*「([^」]+)」`));
    if (q) {
      n = q[1]; // 中身はそのまま（「MEGAドリームex」の MEGA は商品名の一部）
    } else {
      // 時代（シリーズ）を表す言葉を取り除く。MEGA は先頭にあるときだけ（「MEGAドリームex」の MEGA は商品名）
      n = n.replace(/^MEGA\s+/, '').replace(/スカーレット&バイオレット|ソード&シールド|サン&ムーン|XY BREAK|^BW\s/g, ' ').replace(/スペシャルBOX/g, ' ');
      n = n.replace(new RegExp(`^\\s*${TYPE_WORDS}\\s*`), '');
      n = n.replace(/\s+ボックス$/, ''); // 旧弾の「〜 ボックス」は商品名の一部ではない
    }
  } else {
    n = n.replace(new RegExp(`^\\s*${TYPE_WORDS}\\s*`), '');
  }
  n = n.replace(/[「」]/g, '').replace(/\s+/g, ' ').trim();
  if (game === 'yugioh') n = '遊戯王 ' + n.replace(/^(?:遊?戯王\s*)/, '').replace(/ ?[–—-] ?/g, ' ').replace(/\s+/g, ' ').trim();
  if (code) n = `${code} ${n}`.trim();
  return n;
}

// 商品名から名前と状態（「カートン」など名前に入っているもの）を取り出す
function nameAndCond(raw, game) {
  const title = cleanTitle(raw, game);
  const c = Expo.cleanName(title, { baseCondition: 'box' });
  // cleanName は末尾の「BOX」を取り除くが、この店の表示名では残す（「〜FUTURISTIC BOX」など。照合は BOX を無視するので影響しない）
  const suffix = title.match(/\s+(box)$/i);
  return { name: suffix && !/\sbox$/i.test(c.name) ? `${c.name} ${suffix[1]}` : c.name, nameCond: c.cond };
}

// ---- API ----
async function fetchAll(base, query, fetchWithRetry) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const text = await fetchWithRetry(`${base}/products?${query}per_page=100&page=${page}`);
    const list = JSON.parse(text);
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

let cache = null; // 1回の実行の間だけ使い回す（ゲームごとの取得元が複数あっても、APIは4回だけ）
async function loadAll(src, fetchWithRetry) {
  if (cache && cache.key === src.url) return cache.value;
  const base = new URL(src.url).origin + '/wp-json/wc/store/v1';
  const parents = await fetchAll(base, '', fetchWithRetry);
  const variations = await fetchAll(base, 'type=variation&', fetchWithRetry);
  cache = { key: src.url, value: { parents, variations } };
  return cache.value;
}

// 商品1つ → 行（状態ごとに1行）
function rowsFromProduct(p, varById, game) {
  const { name, nameCond } = nameAndCond(p.name, game);
  const image = (p.images && p.images[0] && (p.images[0].thumbnail || p.images[0].src)) || null;
  const pack = game === 'onepiece' ? (/^(?:OP|EB|PRB)-?\d/i.test(name) ? 'BOX・カートン' : 'その他（プロモ・セット等）') : { pokemon: 'ボックス', dragonball: 'ドラゴンボール', yugioh: '遊戯王' }[game] || '';
  const mk = (cond, priceStr, inStock) => {
    const price = Number(priceStr);
    return { name, cond, price: price > 0 ? price : null, status: !inStock ? 'closed' : price > 0 ? 'price' : 'unknown', siteDate: null, imageUrl: image, pack, meta: '' };
  };
  if (p.type !== 'variable') return [mk(nameCond, p.prices && p.prices.price, p.is_in_stock)];

  const override = GAME_COND_OVERRIDE[game] || {};
  const rows = new Map();
  const skipped = [];
  for (const v of p.variations || []) {
    const variation = varById.get(v.id);
    const at = (v.attributes || [])[0];
    if (!variation || !at) continue;
    const key = `${at.name}:${decodeURIComponent(at.value)}`;
    const cond = override[key] || COND[key];
    if (!cond) {
      skipped.push(key);
      continue;
    }
    const row = mk(cond, variation.prices && variation.prices.price, variation.is_in_stock);
    if (!rows.has(cond) || PRIMARY.has(key)) rows.set(cond, row); // 同じ状態が重複したら主な方を採用
  }
  const out = [...rows.values()];
  if (!out.length && !skipped.length) return [mk(nameCond, p.prices && p.prices.price, p.is_in_stock)];
  out.skipped = skipped;
  return out;
}

// 取得元(src): { game, category, url }。category は RUNTO のカテゴリ（card / onepiece / yugioh / dg）
async function load(src, { fetchWithRetry, data } = {}) {
  const { parents, variations } = data || (await loadAll(src, fetchWithRetry));
  const varById = new Map(variations.map((v) => [v.id, v]));
  const rows = [];
  let skipped = 0;
  for (const p of parents) {
    if (!(p.categories || []).some((c) => c.slug === src.category)) continue;
    const r = rowsFromProduct(p, varById, src.game);
    skipped += (r.skipped || []).length;
    rows.push(...r);
  }
  rows.skippedVariations = skipped;
  return rows;
}

module.exports = { load, cleanTitle, nameAndCond, rowsFromProduct, COND };
