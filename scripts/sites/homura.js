// 買取ホムラ (kaitori-homura.com) のトレカ買取価格。
//
// 注意: このサイトは、Node の fetch（TLSの接続方式の違いとみられる）だとボット判定されて、
// 商品が1件も入っていない空のページが返ってくる。curl だと正常に取得できるため、
// lib/common.js の fetchWithCurl（curl をサブプロセスで呼ぶ）を使う。
//
// 状態（シュリンク有り/無し・未開封カートン・白箱など）ごとに、別々のURL（サブカテゴリ）がある。
// 商品名の先頭にも【BOX】【シュリンク無しBOX】【カートン】【白箱】のような印が付いているので、
// 印があればそれを優先し、無ければURL（サブカテゴリ）の状態を使う。
// ページ送りは ?page=N。1ページ目の「対象商品：N件」から、必要なページ数を計算する。
const cheerio = require('cheerio');
const Expo = require('../../docs/admin/expo-parser.js');
const { fetchWithCurl, sleep } = require('../lib/common');

const BASE = 'https://kaitori-homura.com/products';
const CATEGORY_ID = 14; // トレカ
const PAGE_SIZE = 20;
const MAX_PAGES = 20; // 想定外に大きい値が出たときの安全弁

function pageUrl(subId, page) {
  return `${BASE}?q%5Bproduct_sub_category_id_eq%5D=${subId}&q%5Bproduct_sub_category_product_category_id_eq%5D=${CATEGORY_ID}${page > 1 ? `&page=${page}` : ''}`;
}

// 商品名の先頭の印から状態を判定する。印が無い／分からないときは null（呼び出し側でURLの状態を使う）
function tagCond(tag, game) {
  if (!tag) return null;
  if (tag.includes('カートン')) return 'carton';
  if (tag.includes('シュリンク無し')) return 'noshrink';
  if (tag.includes('白箱')) return 'whitebox';
  if (tag.includes('BOX') || tag.includes('ボックス')) return game === 'pokemon' ? 'shrink' : 'box';
  return null;
}

// 印が無い商品は「ポケモンカードゲーム MEGA スタートデッキ100 …」のように、ゲーム名がそのまま付いていることがある
const PREFIX = {
  pokemon: /^(?:ポケモンカードゲーム\s*)+(?:MEGA\s+)?/,
  onepiece: /^(?:ONE ?PIECE\s*カードゲーム\s*)+/i,
  yugioh: /^(?:遊戯王\s*(?:オフィシャルカードゲーム|OCG)?\s*(?:デュエルモンスターズ)?\s*)+/,
  dragonball: /^(?:ドラゴンボール\s*スーパーカードゲーム\s*(?:フュージョンワールド)?\s*)+/,
};

// 商品名の行 → { name, cond }
function parseName(raw, game, fallbackCond) {
  const n = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const m = n.match(/^【([^】]*)】\s*/);
  const cond = (m && tagCond(m[1], game)) || fallbackCond;
  const rest = (m ? n.slice(m[0].length) : n).replace(PREFIX[game] || /^$/, '');
  const c = Expo.cleanName(rest, { baseCondition: cond });
  return { name: c.name, cond: c.cond || cond };
}

// 1ページぶんのHTML → 行。同じ商品カードがモバイル/デスクトップ用に重複して出ることがあるので、リンク先(商品ID)で重複を除く
function parseCards(html, game, fallbackCond, pack) {
  const $ = cheerio.load(html);
  const rows = [];
  const seen = new Set();
  $('h5').each((_, h5) => {
    const $h5 = $(h5);
    const link = $h5.closest('a[href^="/products/"]');
    if (!link.length) return;
    const href = link.attr('href');
    if (seen.has(href)) return;
    seen.add(href);
    const card = link.parent();
    const { name, cond } = parseName($h5.text(), game, fallbackCond);
    if (!name) return;
    const priceSpan = card.find('span').filter((i, s) => /¥/.test($(s).text())).first();
    const price = Number((priceSpan.text().match(/[\d,]+/) || [''])[0].replace(/,/g, ''));
    const img = card.find('img').first().attr('src') || null;
    rows.push({ name, cond, price: price > 0 ? price : null, status: price > 0 ? 'price' : 'unknown', siteDate: null, imageUrl: img, pack: pack || '', meta: '' });
  });
  return rows;
}

// 「対象商品：N件」を読む。無ければ、サイトの構造が変わった／ブロックされたとみなして例外
function readTotal(html) {
  const m = cheerio.load(html)('body').text().match(/対象商品[：:]\s*(\d+)件/);
  if (!m) throw new Error('「対象商品：N件」が見つかりません（サイトの構造が変わったか、取得がブロックされた可能性）');
  return Number(m[1]);
}

async function fetchSubcategory(sub, game, pack, { fetcher, pages } = {}) {
  const get = fetcher || fetchWithCurl;
  const htmls = pages || [await get(pageUrl(sub.id, 1))];
  const total = readTotal(htmls[0]);
  const pageCount = Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE) || 1);
  while (!pages && htmls.length < pageCount) {
    await sleep(400);
    htmls.push(await get(pageUrl(sub.id, htmls.length + 1)));
  }
  return htmls.flatMap((html) => parseCards(html, game, sub.cond, pack));
}

// src: { game, group, subcategories: [{ id, cond, group? }] }（サブカテゴリごとに区分(group)を変えたいときは sub.group）
// ctx.data（テスト用）: { [subcategoryId]: [html1ページ目, html2ページ目, ...] }
async function load(src, ctx = {}) {
  const rows = [];
  for (const sub of src.subcategories) {
    const pages = ctx.data ? ctx.data[sub.id] : undefined;
    if (ctx.data && !pages) continue; // テストで一部のサブカテゴリだけ渡した場合はスキップ
    rows.push(...(await fetchSubcategory(sub, src.game, sub.group || src.group, { fetcher: ctx.fetcher, pages })));
    if (!pages) await sleep(300);
  }
  return rows;
}

module.exports = { load, parseName, parseCards, readTotal, pageUrl, tagCond };
