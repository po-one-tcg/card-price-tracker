// PRICE BASE (price-base.com) の買取表パーサー。
// 構造: div.pack-section > ul.price-list > li
//   li 内: p.price-list-title / p.price-list-meta / img / p.price-list-price / p.price-list-date
// 画像は lazy-load のため src がダミーGIF。本物のURLは data-src-img に入っている。
const cheerio = require('cheerio');

function parsePrice(text) {
  const m = text.match(/[￥¥]\s*([\d,]+)/);
  if (m) return { price: Number(m[1].replace(/,/g, '')), status: 'price' };
  if (text.includes('価格更新中')) return { price: null, status: 'updating' };
  if (text.includes('買取中')) return { price: null, status: 'buying' };
  return { price: null, status: 'unknown' };
}

function parseSiteDate(text) {
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function pickImageUrl($img, pageUrl) {
  if (!$img.length) return null;
  const candidates = [$img.attr('data-src-img'), $img.attr('data-src'), $img.attr('src')];
  const raw = candidates.find((u) => u && !u.startsWith('data:'));
  if (!raw) return null;
  try {
    return new URL(raw, pageUrl).href; // 相対パス → 絶対URL
  } catch {
    return null;
  }
}

// HTML → [{ name, meta, price, status, siteDate, imageUrl, pack }]
function parse(html, pageUrl) {
  const $ = cheerio.load(html);
  const rows = [];
  $('ul.price-list > li').each((_, li) => {
    const $li = $(li);
    const name = $li.children('.price-list-title').text().trim();
    if (!name) return;
    const { price, status } = parsePrice($li.children('.price-list-price').text());
    rows.push({
      name,
      meta: $li.children('.price-list-meta').text().trim(),
      price,
      status,
      siteDate: parseSiteDate($li.children('.price-list-date').text()),
      imageUrl: pickImageUrl($li.children('img').first(), pageUrl),
      pack: $li.closest('.pack-section').attr('data-pack') || '',
    });
  });
  return rows;
}

module.exports = { parse };
