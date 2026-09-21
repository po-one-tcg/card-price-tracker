// 買取価格の収集スクリプト。
//   node scripts/scrape.js                 全サイトを収集して data/ に保存
//   node scripts/scrape.js --dry-run       保存せず件数だけ確認
//   node scripts/scrape.js --site pricebase  指定サイトだけ
//   node scripts/scrape.js --file page.html  ローカルHTMLで動作確認（--site 必須）
//   node scripts/scrape.js --no-images     画像を保存しない
// 環境変数 DATA_DIR で保存先を変更できる（テスト用）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const IMAGES_DIR = path.join(DATA_DIR, 'images');

const USER_AGENT = 'card-price-tracker/1.0 (+https://github.com/PO-1-TCG/card-price-tracker)';
const MIN_ROWS = 100; // これより少ない場合はサイト構造が変わったとみなして中断
const IMAGE_DELAY_MS = 300;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const DRY_RUN = flag('dry-run');
const NO_IMAGES = flag('no-images');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 日時（日本時間） ----------
function jstNow() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const iso = jst.toISOString(); // 2026-09-21T02:58:00.123Z をJSTにずらしたもの
  return { date: iso.slice(0, 10), stamp: iso.slice(0, 19) + '+09:00' };
}

// ---------- 取得 ----------
async function fetchWithRetry(url, { as = 'text', tries = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (as === 'buffer') {
        return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < tries) await sleep(2000 * i);
    }
  }
  throw new Error(`${url} の取得に失敗: ${lastErr.message}`);
}

// ---------- カード識別 ----------
const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '');

function imageStem(url) {
  if (!url) return '';
  const file = decodeURIComponent(new URL(url).pathname.split('/').pop());
  return file.replace(/\.[a-z0-9]+$/i, '').replace(/-\d+x\d+$/, ''); // 拡張子とサイズ接尾辞を除去
}

// 型番（OP13-118 など）を meta から、無ければ名前から探す。
// 空白は消さずに判定する（消すと "SEC/SP OP13-118" が "SEC/SPOP13-118" になり抽出できない）。
function cardNumber(meta, name = '') {
  const re = /(?<![A-Z0-9])[A-Z]{1,6}\d{0,3}-\d{2,4}(?!\d)/;
  const m = meta.normalize('NFKC').match(re) || name.normalize('NFKC').match(re);
  return m ? m[0] : 'nocode';
}

// 名前+型番表記+画像名 の3点で識別する（同名異絵柄・未開封/開封済を区別するため）。
function cardId(siteId, row) {
  const key = [norm(row.name), norm(row.meta), imageStem(row.imageUrl)].join('|');
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
  return `${siteId}_${cardNumber(row.meta, row.name)}_${hash}`;
}

// ---------- 保存 ----------
function loadCards() {
  try {
    return JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCards(cards) {
  const sorted = Object.fromEntries(Object.keys(cards).sort().map((k) => [k, cards[k]]));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CARDS_FILE, JSON.stringify(sorted, null, 1) + '\n');
}

function extFromResponse(url, type) {
  const m = new URL(url).pathname.match(/\.(png|jpe?g|webp|gif)$/i);
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
}

async function saveMissingImages(cards, ids) {
  const result = { saved: 0, failed: 0, none: 0 };
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  for (const id of ids) {
    const card = cards[id];
    if (card.image) continue; // 保存済みなら二度と取得しない
    if (!card.imageUrl) {
      result.none++;
      continue;
    }
    try {
      const { buf, type } = await fetchWithRetry(card.imageUrl, { as: 'buffer' });
      if (!/^image\//.test(type) || buf.length < 100) throw new Error(`画像ではない応答 (${type}, ${buf.length}B)`);
      const file = `${id}.${extFromResponse(card.imageUrl, type)}`;
      fs.writeFileSync(path.join(IMAGES_DIR, file), buf);
      card.image = `images/${file}`;
      result.saved++;
    } catch (e) {
      console.warn(`  ! 画像保存失敗 ${id}: ${e.message}（次回また試します）`);
      result.failed++;
    }
    await sleep(IMAGE_DELAY_MS);
  }
  return result;
}

// ---------- サイトごとの処理 ----------
function matchCharacters(row, characters) {
  const title = row.name.normalize('NFKC');
  return characters
    .filter((c) => c.keywords.some((k) => title.includes(k.normalize('NFKC'))))
    .filter((c) => !(c.exclude || []).some((k) => title.includes(k.normalize('NFKC'))))
    .map((c) => c.id);
}

async function runSite(site, cards, now) {
  console.log(`\n=== ${site.name} (${site.url}) ===`);
  const localFile = option('file');
  const html = localFile ? fs.readFileSync(localFile, 'utf8') : await fetchWithRetry(site.url);
  const rows = require(`./sites/${site.parser}.js`).parse(html, site.url);
  console.log(`ページ全体: ${rows.length} 件`);
  if (rows.length < MIN_ROWS) {
    throw new Error(`${site.name}: 抽出件数が ${rows.length} 件しかありません。サイトの構造が変わった可能性があります。`);
  }

  // 対象キャラのカードだけ残し、同一カードの重複掲載（高額カード欄など）をまとめる
  const found = new Map();
  for (const row of rows) {
    const characters = matchCharacters(row, site.characters);
    if (!characters.length) continue;
    const id = cardId(site.id, row);
    const prev = found.get(id);
    if (prev) {
      if (row.pack && !prev.packs.includes(row.pack)) prev.packs.push(row.pack);
      if (prev.row.price !== row.price) console.warn(`  ! 同一カードで価格が食い違い: ${row.name} (${prev.row.price} / ${row.price})`);
      continue;
    }
    found.set(id, { id, row, characters, packs: row.pack ? [row.pack] : [] });
  }

  // 集計表示
  const perChar = {};
  for (const c of site.characters) perChar[c.label] = 0;
  for (const { characters } of found.values()) {
    for (const cid of characters) perChar[site.characters.find((c) => c.id === cid).label]++;
  }
  console.log('キャラ別 抽出件数（重複除去後）:');
  for (const [label, n] of Object.entries(perChar)) console.log(`  ${label}: ${n}`);
  console.log(`  合計（ユニークカード数）: ${found.size}`);
  for (const [label, n] of Object.entries(perChar)) {
    if (n === 0) console.warn(`  ! ${label} が0件です。キーワードかサイト構造を確認してください`);
  }

  // cards.json 更新 & 履歴行の作成
  const historyLines = [];
  let newCards = 0;
  for (const { id, row, characters, packs } of found.values()) {
    const existing = cards[id];
    if (!existing) newCards++;
    cards[id] = {
      id,
      site: site.id,
      game: site.game,
      name: row.name,
      meta: row.meta,
      cardNo: cardNumber(row.meta, row.name),
      characters,
      packs,
      imageUrl: row.imageUrl || existing?.imageUrl || null,
      image: existing?.image || null,
      firstSeen: existing?.firstSeen || now.date,
      lastSeen: now.date,
    };
    historyLines.push(JSON.stringify({ t: now.stamp, id, price: row.price, status: row.status, siteDate: row.siteDate }));
  }
  const noPrice = [...found.values()].filter((f) => f.row.price === null).length;
  console.log(`新規カード: ${newCards} 件 / 価格なし(更新中・買取中): ${noPrice} 件`);

  if (DRY_RUN) {
    console.log('(dry-run: 保存はしません)');
    return { site: site.name, perChar, total: found.size, newCards, images: null };
  }

  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.appendFileSync(path.join(HISTORY_DIR, `${now.date}.jsonl`), historyLines.join('\n') + '\n');

  let images = { saved: 0, failed: 0, none: 0 };
  if (!NO_IMAGES) {
    const pending = [...found.keys()].filter((id) => !cards[id].image && cards[id].imageUrl);
    console.log(`画像の未保存カード: ${pending.length} 件 → 取得します`);
    images = await saveMissingImages(cards, pending);
    console.log(`画像: 保存 ${images.saved} / 失敗 ${images.failed} / 画像なし ${images.none}`);
  }
  return { site: site.name, perChar, total: found.size, newCards, images };
}

function writeStepSummary(results, now) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  let md = `## 収集結果 (${now.stamp})\n\n`;
  for (const r of results) {
    md += `### ${r.site}\n\n| キャラ | 件数 |\n|---|---|\n`;
    for (const [label, n] of Object.entries(r.perChar)) md += `| ${label} | ${n} |\n`;
    md += `\nユニークカード ${r.total} 件 / 新規カード ${r.newCards} 件`;
    if (r.images) md += ` / 画像保存 ${r.images.saved} 件（失敗 ${r.images.failed}）`;
    md += '\n\n';
  }
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'targets.json'), 'utf8'));
  const only = option('site');
  const sites = config.sites.filter((s) => s.enabled !== false && (!only || s.id === only));
  if (!sites.length) throw new Error('対象サイトがありません（--site の指定や config/targets.json を確認）');

  const now = jstNow();
  const cards = loadCards();
  const results = [];
  const errors = [];
  for (const site of sites) {
    try {
      results.push(await runSite(site, cards, now));
    } catch (e) {
      console.error(`\nERROR: ${e.message}`);
      errors.push(e);
    }
  }
  if (!DRY_RUN && results.length) saveCards(cards); // 1サイトが失敗しても、成功した分は保存する
  writeStepSummary(results, now);
  if (errors.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
