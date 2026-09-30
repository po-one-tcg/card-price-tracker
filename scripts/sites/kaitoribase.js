// 買取BASE（kaitori-base.com、Xの「買取BASE@トレカ」＝@KaitoriBase3 のトレカ専用価格表ページ）。
// 1つのページ（?p=9534）に、ONE PIECE→ドラゴンボール→遊戯王→ポケモンの順で<table>が並んでいる（表の並び順は固定）。
// 商品コード（OP-17 等）は付かず、店の言い方の商品名のみ。同じ商品として結びつける対応は
// config/product-aliases.json 側で行う（見出し行・空行はここで無視する）。
// 状態（シュリンク有無・カートン等）の区別は無く、どの商品も1本の価格。
// ポケモンだけ、価格帯が他店の「シュリンク付き」と揃う（シュリンク無しより高い）ため cond を shrink として扱う。
// 他のゲーム（ワンピース・ドラゴンボール・遊戯王）はシュリンクの概念が無いため box のまま。
//
// 似た名前の「PRICE BASE (price-base.com)」は無関係の別会社で、そちらは「独自調査による取引相場の目安」
// （実際の買取価格ではない）と明記されたページのため、このツールでは使わない。
const cheerio = require('cheerio');

const TABLE_ORDER = ['onepiece', 'dragonball', 'yugioh', 'pokemon']; // ページ内の<table>の出現順
// 商品名だけでは本物のBOXと分からない付属品・アクセサリ類（ゲームごとに除外する語）
const EXCLUDE = { dragonball: [/エナジーマーカー/] };
// 3ゲームの表には見出し行「商品名（ゲーム名）」が付く（ポケモンの表だけ見出しが無く、いきなり商品名から始まる）。
// この見出しの文字で、表の並び順が想定どおりか確認する（サイトが表の順番を変えても、誤って別ゲームのデータを取り込まないため）
const HEADER_HINT = { onepiece: 'ONE PIECE', dragonball: 'ドラゴンボール', yugioh: '遊戯王' };

// 「買取価格」列の文字 → 価格・状態
function parsePrice(text) {
  const t = (text || '').replace(/\s+/g, '').trim();
  if (/^[0-9,]+$/.test(t) && t) return { price: Number(t.replace(/,/g, '')), status: 'price' };
  if (t.includes('停止')) return { price: null, status: 'closed' }; // 買取停止
  // 「要問合せ」など、金額が公開されていないもの。他の店の「〆切」と同じ「取扱なし」（—）に揃える
  // （「未確認」は、サイトの取得に失敗した時など「本当は確認できるはずが今回だけ見れなかった」場合の表示のため）
  return { price: null, status: 'closed' };
}

// <table> 1つ（1ゲームぶん）→ 行。1列目=商品名、3列目=買取価格（2列目の「定価」、4列目の「備考」は使わない）
function rowsFromTable($, table, game) {
  const exclude = EXCLUDE[game] || [];
  const rows = [];
  $(table)
    .find('tr')
    .each((_, tr) => {
      const tds = $(tr).find('td');
      const name = tds.eq(0).text().trim().replace(/\s+/g, ' ');
      if (!name || /^商品名/.test(name)) return; // 見出し行
      if (exclude.some((re) => re.test(name))) return;
      const { price, status } = parsePrice(tds.eq(2).text());
      const cond = game === 'pokemon' ? 'shrink' : 'box';
      rows.push({ name, cond, price, status, siteDate: null, imageUrl: null, pack: '', meta: '' });
    });
  return rows;
}

let cache = null; // 1回の実行の間だけ使い回す（4ゲームぶんで同じページを2回以上取りに行かない）

// src: { game, url }。ctx.data（テスト用）: ページのHTML文字列
async function load(src, ctx = {}) {
  const get = ctx.fetcher || ctx.fetchWithRetry;
  let html = ctx.data;
  if (html == null) {
    if (cache && cache.url === src.url) html = cache.html;
    else {
      html = await get(src.url);
      cache = { url: src.url, html };
    }
  }
  const $ = cheerio.load(html);
  const tables = $('table');
  const i = TABLE_ORDER.indexOf(src.game);
  if (i < 0 || i >= tables.length) return [];
  const hint = HEADER_HINT[src.game];
  if (hint && !$(tables.get(i)).find('tr').first().text().includes(hint)) {
    // ページの表の並び順が想定と変わっている（誤って他のゲームのデータを取り込まないよう止める）
    throw new Error(`kaitoribase: ${src.game}の表のはずが見出し「${hint}」が見つかりません（ページの並び順が変わった可能性）`);
  }
  return rowsFromTable($, tables.get(i), src.game);
}

module.exports = { load, parsePrice, rowsFromTable, TABLE_ORDER, HEADER_HINT };
