/**
 * PRICE BASE（price-base.com）のワンピースカード買取表から、
 * 指定したキャラクターのカードだけを抽出して記録するスクリプト。
 *
 * 対象キャラ（TARGET_NAMESで変更可）: ルフィ, ゾロ, ナミ, ハンコック
 *
 * 出力:
 *   data/history/YYYY-MM-DD.jsonl … その日の全取得結果を1行1件で追記
 *   data/cards.json               … 見つかった全カードの最新状態（一覧）
 *   data/images/<code>.<ext>      … カードごとの画像（初回のみ保存）
 *
 * 注意:
 *   PRICE BASE側のHTML構造が変わると、抽出がうまくいかなくなることがあります。
 *   その場合は下記 parseCards() 関数の調整が必要です。
 *   実行結果は必ずログ（run summary）で件数を確認してください。
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const SOURCE_URL = 'https://price-base.com/useful/onepiece-kaitorilist';
const TARGET_NAMES = ['ルフィ', 'ゾロ', 'ナミ', 'ハンコック'];

const DATA_DIR = path.join(__dirname, '..', 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const CARDS_MANIFEST = path.join(DATA_DIR, 'cards.json');

function todayStr() {
  const d = new Date();
  // JST基準の日付にする
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.text();
}

/**
 * ページのHTMLからカード情報を抽出する。
 * PRICE BASEの買取表は「カード名 → 型番 → 画像 → 価格 → 更新日」の
 * まとまりが繰り返される構造になっている想定で、複数の抽出戦略を試す。
 */
function parseCards(html) {
  const $ = cheerio.load(html);
  const results = [];

  // 戦略1: 価格らしきテキスト（￥, 価格更新中, 買取中！）を含む要素を起点に、
  // その祖先ブロック内から名前・型番・画像を探す
  const priceRegex = /(￥[\d,]+|価格更新中|買取中！)/;

  $('*').each((_, el) => {
    const $el = $(el);
    // 子要素を持たない最小単位のテキストノードだけを対象にして重複を避ける
    if ($el.children().length > 0) return;
    const text = $el.text().trim();
    if (!priceRegex.test(text)) return;
    if (text.length > 30) return; // 価格以外の長文は除外

    // 近い祖先（カードのまとまりと思われるブロック）を探す
    let block = $el;
    for (let i = 0; i < 6 && block.length; i++) {
      const blockText = block.text();
      if (blockText.length > 20 && blockText.length < 400) break;
      block = block.parent();
    }
    if (!block || !block.length) return;

    const blockText = block.text().replace(/\s+/g, ' ').trim();

    // 型番らしきパターン: 英大文字/数字+ハイフンを含む (例: SR OP16-032, SEC/SP OP13-118)
    const codeMatch = blockText.match(
      /([A-Z]{1,4}(?:[-/][A-Z]{1,4})*\s*(?:\([^)]*\))?\s*[A-Z]{1,6}\d{2}-\d{2,3}(?:\[[A-Z0-9]+\])?)/
    );
    const priceMatch = blockText.match(priceRegex);
    const img = block.find('img').first();
    const imgSrc = img.attr('src') || img.attr('data-src') || null;

    // 名前らしき部分: ブロック先頭〜型番の手前
    let name = blockText;
    if (codeMatch) name = blockText.slice(0, blockText.indexOf(codeMatch[0]));
    name = name.replace(/\s+/g, ' ').trim();

    if (!name || !priceMatch) return;

    const matchedTarget = TARGET_NAMES.find((t) => name.includes(t));
    if (!matchedTarget) return;

    results.push({
      target: matchedTarget,
      name,
      code: codeMatch ? codeMatch[0].trim() : null,
      price_raw: priceMatch[0],
      image_url: imgSrc,
    });
  });

  // 重複除去（同じ name+code+price の組み合わせ）
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const key = `${r.name}|${r.code}|${r.price_raw}|${r.image_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped;
}

function parsePrice(priceRaw) {
  if (!priceRaw) return null;
  if (priceRaw === '価格更新中' || priceRaw === '買取中！') return null;
  const n = priceRaw.replace(/[￥,]/g, '');
  const v = parseInt(n, 10);
  return Number.isFinite(v) ? v : null;
}

function loadManifest() {
  if (!fs.existsSync(CARDS_MANIFEST)) return {};
  try {
    return JSON.parse(fs.readFileSync(CARDS_MANIFEST, 'utf8'));
  } catch {
    return {};
  }
}

function saveManifest(manifest) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CARDS_MANIFEST, JSON.stringify(manifest, null, 2), 'utf8');
}

function cardKey(card) {
  // codeがあればそれを識別子に、無ければ name をそのまま使う
  return card.code || card.name;
}

async function downloadImage(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

function guessExt(url) {
  const m = url.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i);
  return m ? m[1].toLowerCase() : 'jpg';
}

async function main() {
  console.log(`取得中: ${SOURCE_URL}`);
  const html = await fetchHtml(SOURCE_URL);
  const cards = parseCards(html);

  console.log(`抽出件数: ${cards.length}`);
  for (const t of TARGET_NAMES) {
    const n = cards.filter((c) => c.target === t).length;
    console.log(`  ${t}: ${n}件`);
  }

  if (cards.length === 0) {
    console.warn(
      '警告: 1件も抽出できませんでした。PRICE BASEのHTML構造が想定と違う可能性があります。'
    );
  }

  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const manifest = loadManifest();
  const date = todayStr();
  const timestamp = new Date().toISOString();
  const historyPath = path.join(HISTORY_DIR, `${date}.jsonl`);
  const historyLines = [];

  for (const card of cards) {
    const key = cardKey(card);
    const price = parsePrice(card.price_raw);

    // 初めて見るカードなら画像を保存し、マニフェストに登録
    if (!manifest[key]) {
      manifest[key] = {
        target: card.target,
        name: card.name,
        code: card.code,
        first_seen: timestamp,
        image_path: null,
      };
      if (card.image_url) {
        try {
          const ext = guessExt(card.image_url);
          const safeKey = key.replace(/[^\w-]/g, '_');
          const imgPath = path.join(IMAGES_DIR, `${safeKey}.${ext}`);
          await downloadImage(card.image_url, imgPath);
          manifest[key].image_path = path.relative(DATA_DIR, imgPath);
          console.log(`画像保存: ${key} -> ${manifest[key].image_path}`);
        } catch (e) {
          console.warn(`画像保存失敗 (${key}): ${e.message}`);
        }
      }
    }

    historyLines.push(
      JSON.stringify({
        date,
        timestamp,
        target: card.target,
        name: card.name,
        code: card.code,
        price,
        price_raw: card.price_raw,
      })
    );
  }

  fs.appendFileSync(historyPath, historyLines.join('\n') + (historyLines.length ? '\n' : ''), 'utf8');
  saveManifest(manifest);

  console.log(`保存完了: ${historyPath}`);
  console.log(`カード種類数（累計）: ${Object.keys(manifest).length}`);
}

main().catch((err) => {
  console.error('エラー:', err);
  process.exitCode = 1;
});
