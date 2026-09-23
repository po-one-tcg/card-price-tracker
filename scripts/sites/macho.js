// 買取マッチョ (kaitori.alc-japan.co.jp) の買取価格。
//
// このサイトは Next.js で、ページのHTMLの中に、商品の配列がJSON文字列として（1回分エスケープされた形で）
// そのまま埋め込まれている（`"rows":[{"id":...,"name":...,"game":...,"kaitori_price":...}, ...]`）。
// DOMを読み取るのではなく、このJSON文字列を取り出して直接パースする。
//
// 夜間などは、価格が「調整中」になり、全商品の kaitori_price が null になる（hidden_label に文言が入る）。
// これは PRICE BASE の「価格更新中」と同じ「未確認」（前日の価格を引き継がない）として扱う。
//
// ゲームは URL の ?game=pokemon / ?game=onepiece などで切り替える。ページ送りは ?page=N（「次へ」リンクの有無で判定）。
const cheerio = require('cheerio');

const BASE = 'https://kaitori.alc-japan.co.jp/buyback-prices';
const MAX_PAGES = 15;

// 状態（condition）の対応。ゲームによって同じ言葉の意味が違うことがある（Pack など）ので、ゲームごとに持つ。
// 表に無い/未知の状態は、baseCondition（呼び出し側で決める既定値）を使う。
const COND = {
  pokemon: { Shrink: 'shrink', 'No shrink': 'noshrink', 'No shrink/Pull tab': 'noshrink', Carton: 'carton', 'Unified pack': 'pack', Pack: 'pack' },
  onepiece: { Tape: 'tape', 'Tape cut': 'tapecut', Carton: 'carton', Pack: 'pack' },
};

// 商品の区分（product_type）: package/set は対象、single/bulk（シングルカードのレート）は対象外
const GROUP = {
  pokemon: { package: 'ボックス', set: 'その他（セット・プロモ等）' },
  onepiece: { package: 'BOX・カートン', set: 'その他（プロモ・セット等）' },
};

function pageUrl(game, page) {
  return `${BASE}?game=${encodeURIComponent(game)}${page > 1 ? `&page=${page}` : ''}`;
}

// ページのHTMLから、埋め込まれた "rows":[...] のJSON配列を、見つかった数ぶんすべて取り出す
function extractRows(html) {
  const marker = String.raw`\"rows\":[`;
  const out = [];
  let from = 0;
  while (true) {
    const at = html.indexOf(marker, from);
    if (at === -1) break;
    const arrStart = at + marker.length - 1; // "[" の位置
    let depth = 0;
    let end = -1;
    for (let i = arrStart; i < html.length; i++) {
      const c = html[i];
      if (c === '\\') {
        i++; // エスケープされた次の1文字（\" や \\ など）は読み飛ばす
        continue;
      }
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    const raw = html.slice(arrStart, end + 1);
    try {
      // raw は「1回エスケープされたJSON文字列の中身」。実在のJSON文字列として解いてから、もう一度パースする
      out.push(...JSON.parse(JSON.parse(`"${raw}"`)));
    } catch {
      /* このブロックはたまたま rows という名前の別データだった可能性。無視する */
    }
    from = end + 1;
  }
  return out;
}

function hasNextPage(html) {
  const $ = cheerio.load(html);
  return $('a').filter((_, e) => $(e).text().includes('次へ')).length > 0;
}

// 商品1件 → 行。対象外（シングル/バラ）は null
function toRow(item, game) {
  const group = GROUP[game]?.[item.product_type];
  if (!group) return null; // single/bulk など、BOXではないもの
  const cond = COND[game]?.[item.condition] || 'box';
  const price = Number(item.kaitori_price);
  return {
    name: item.name.normalize('NFKC').replace(/\s+/g, ' ').trim(),
    cond,
    price: price > 0 ? price : null,
    status: price > 0 ? 'price' : 'unknown', // 「調整中」等は未確認（前日の価格を引き継がない）
    siteDate: null,
    imageUrl: item.image_url || null,
    pack: group,
    meta: item.model_number || '',
  };
}

// src: { game }。ctx.data（テスト用）: [html1ページ目, html2ページ目, ...]
async function load(src, ctx = {}) {
  const get = ctx.fetcher || ctx.fetchWithRetry;
  const htmls = ctx.data || [await get(pageUrl(src.game, 1))];
  while (!ctx.data && htmls.length < MAX_PAGES && hasNextPage(htmls[htmls.length - 1])) {
    htmls.push(await get(pageUrl(src.game, htmls.length + 1)));
  }
  const seen = new Set();
  const rows = [];
  for (const html of htmls) {
    for (const item of extractRows(html)) {
      if (seen.has(item.id)) continue; // 商品IDが同じもの（重複掲載）は最初の1件だけ
      seen.add(item.id);
      const row = toRow(item, src.game);
      if (row) rows.push(row);
    }
  }
  return rows;
}

module.exports = { load, extractRows, toRow, pageUrl, hasNextPage, COND, GROUP };
