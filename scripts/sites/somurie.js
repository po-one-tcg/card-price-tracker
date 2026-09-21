// 買取ソムリエ (somurie-kaitori.com) の買取商品一覧。ページのHTML（サーバー側で作られた1ページ目）から読み取る。
// 商品名に状態（シュリンク付き／なし／カートン）が入っている。載っていれば買取中、無ければ停止（PRICE BASE と同じ考え方）。
// カテゴリごとに URL があり、1つの取得元(src)に複数の URL（urls）を指定できる。
const cheerio = require('cheerio');
const Expo = require('../../docs/admin/expo-parser.js');

const PREFIX = {
  pokemon: /^(?:ポケモンカード(?:ゲーム)?\s*)+/,
  yugioh: /^(?:遊戯王\s*(?:オフィシャルカードゲーム|OCG)?\s*(?:デュエルモンスターズ)?\s*)+/,
  onepiece: /^(?:ONE ?PIECE\s*カードゲーム\s*)+/i,
  dragonball: /^(?:ドラゴンボール\s*スーパーカードゲーム\s*(?:フュージョンワールド)?\s*)+/,
};

// 状態を名前から取り出し、名前を整える
function parseName(raw, game) {
  let n = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  let cond = null;
  if (/シュリンクなし/.test(n)) cond = 'noshrink';
  else if (/シュリンク付き?/.test(n)) cond = 'shrink';
  n = n.replace(/シュリンクなし|シュリンク付き?/g, ' ').replace(/ボックス$/, '');
  n = n.replace(PREFIX[game] || /^$/, '');
  if (game === 'pokemon') n = n.replace(/^MEGA\s+/, '');
  n = n.replace(/\s*\((?:M\d+[A-Z]?|SV\d+[a-z]?|S\d+[a-z]?)\)\s*/gi, ' '); // 「（M6）」などの略称
  n = n.replace(/\s+/g, ' ').trim();
  const c = Expo.cleanName(n, { baseCondition: cond || 'box' }); // 名前の末尾の「カートン」を状態にする
  const suffix = n.match(/\s+(box)$/i); // cleanName は末尾の BOX を外すが、表示名では残す（照合は BOX を無視する）
  if (suffix && !/\sbox$/i.test(c.name)) c.name = `${c.name} ${suffix[1]}`;
  if (game === 'yugioh') c.name = '遊戯王 ' + c.name;
  return { name: c.name, cond: cond || c.cond };
}

// HTML → 行。src.minPrice 未満（バラのレート表示など）は BOX ではないので除く
function parse(html, src = {}) {
  const $ = cheerio.load(html);
  // サイトの作りが変わって読めなくなったのと、単にカテゴリが空なのを区別する（空でもタイトルとメニューはある）
  if (!/買取ソムリエ/.test($('title').text()) || !html.includes('買取商品一覧')) {
    throw new Error('買取ソムリエのページとして読み取れません（サイトの作りが変わった可能性があります）');
  }
  // ページが複数あるときは、2ページ目以降をここでは取れない。取れない分を「消滅」と誤判定しないよう、止める
  if ($('.ant-pagination-item').length > 1) throw new Error('商品が複数ページに分かれています（2ページ目以降は取得できません）');
  const rows = [];
  $('.ant-card-body').each((_, e) => {
    const c = $(e);
    const name = c.find('p.font-bold').first().text().trim();
    const price = Number(c.find('.text-price-red').first().text().replace(/[^\d]/g, ''));
    if (!name || !c.find('img[alt]').length) return;
    if (!(price > 0) || price < (src.minPrice || 0)) return;
    const img = (c.find('img').attr('src') || '').match(/url=([^&]+)/);
    const { name: n, cond } = parseName(name, src.game);
    rows.push({ name: n, cond, price, status: 'price', siteDate: null, imageUrl: img ? decodeURIComponent(img[1]) : null, pack: src.group || '', meta: '' });
  });
  return rows;
}

async function load(src, { fetchWithRetry, data } = {}) {
  const pages = data ? [].concat(data) : [];
  if (!data) for (const url of src.urls || [src.url]) pages.push(await fetchWithRetry(url));
  return pages.flatMap((html) => parse(html, src));
}

module.exports = { load, parse, parseName };
