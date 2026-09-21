// ポケモンカードの弾ごとの発売日を、参考ページから取得して config/release-dates.json に反映する。
//   node scripts/box/update-release-dates.js            取得して更新
//   node scripts/box/update-release-dates.js --dry-run  取得だけして件数を表示
// 新しい弾が出たら、これをもう一度実行する（または Claude に「発売日を更新して」と頼む）。
// ワンピースなど他のゲームの発売日は、config/release-dates.json に手で書いてある（このスクリプトは触らない）。
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchWithRetry } = require('../lib/common');

const SOURCE = 'https://learn-book.com/pokemon-rekidai-pack/';
const FILE = path.join(__dirname, '..', '..', 'config', 'release-dates.json');

function parsePacks(html) {
  const $ = cheerio.load(html);
  const dates = {};
  $('h3.wp-block-heading').each((_, h3) => {
    const $h = $(h3);
    const m = $h.text().match(/「([^」]+)」/);
    if (!m) return;
    const col = $h.parent();
    const p = col.find('p').filter((i, e) => $(e).find('strong').text().includes('発売日')).first();
    const d = p.text().match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (d) dates[m[1].trim()] = `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}`;
  });
  return dates;
}

async function main() {
  const html = await fetchWithRetry(SOURCE);
  const dates = parsePacks(html);
  const n = Object.keys(dates).length;
  if (n < 100) throw new Error(`取得できた弾が ${n} 件しかありません。ページの作りが変わった可能性があります（更新しません）`);
  const newest = Object.entries(dates).sort((a, b) => (a[1] < b[1] ? 1 : -1))[0];
  console.log(`取得: ${n} 件（最新: ${newest[1]} ${newest[0]}）`);
  if (process.argv.includes('--dry-run')) return;

  const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const before = Object.keys(cfg.pokemon?.dates || {}).length;
  cfg.pokemon = { ...(cfg.pokemon || {}), source: SOURCE, fetchedAt: new Date().toISOString().slice(0, 10), dates };
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 1) + '\n');
  console.log(`config/release-dates.json を更新しました（${before} → ${n} 件）`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
module.exports = { parsePacks };
