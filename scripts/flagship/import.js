// C:\optcg\scrape.js が出した生データ（output/<seriesId>.json）を、必要な項目だけに絞って取り込む。
//   node scripts/flagship/import.js <seriesId> [<seriesId> ...]
// 生データは C:\optcg\output\<seriesId>.json から読み、data/flagship/<seriesId>.json に保存する
// （店舗名・住所・緯度経度などは使わないので持ち込まない。集計に使う項目だけ残す）。
const fs = require('fs');
const path = require('path');

const SRC_DIR = 'C:/optcg/output';
const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'flagship');

function importSeries(seriesId) {
  const srcFile = path.join(SRC_DIR, `${seriesId}.json`);
  const raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  const trimmed = raw.map((e) => ({
    max_join_count: e.max_join_count,
    is_canceled: Boolean(e.is_canceled),
    start_datetime: e.start_datetime,
    applicants_fetched_at: e.applicants_fetched_at,
  }));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${seriesId}.json`), JSON.stringify(trimmed) + '\n');
  console.log(`${seriesId}: ${trimmed.length}件 取り込み（キャンセル ${trimmed.filter((e) => e.is_canceled).length}件）`);
}

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('使い方: node scripts/flagship/import.js <seriesId> [<seriesId> ...]');
  process.exit(1);
}
for (const id of ids) importSeries(id);
