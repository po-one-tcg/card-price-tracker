// 収集スクリプト共通の部品。
const crypto = require('crypto');

const USER_AGENT = 'card-price-tracker/1.0 (+https://github.com/po-one-tcg/card-price-tracker)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 日本時間の現在時刻。環境変数 NOW_ISO（例 2026-09-22T11:00:00+09:00）でテスト用に固定できる。
function jstNow() {
  const base = process.env.NOW_ISO ? new Date(process.env.NOW_ISO) : new Date();
  const iso = new Date(base.getTime() + 9 * 3600 * 1000).toISOString();
  return { date: iso.slice(0, 10), stamp: iso.slice(0, 19) + '+09:00' };
}

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

// curl経由での取得。一部のサイト（買取ホムラ）は、Node の fetch（TLSの接続方式の違いとみられる）だと
// ボット判定されて空のページが返るが、curl では正常に取得できるため、そのサイト専用に使う。
// GitHub Actions（ubuntu-latest）・通常のパソコンには、curl が標準で入っている。
async function fetchWithCurl(url, { tries = 3 } = {}) {
  const { execFile } = require('child_process');
  const run = () =>
    new Promise((resolve, reject) => {
      execFile(
        'curl',
        ['-sS', '-m', '30', '-H', `User-Agent: ${USER_AGENT}`, '-H', 'Accept-Language: ja,en-US;q=0.9', url],
        { maxBuffer: 20 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
    });
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const text = await run();
      if (!text) throw new Error('空の応答');
      return text;
    } catch (e) {
      lastErr = e;
      if (i < tries) await sleep(2000 * i);
    }
  }
  throw new Error(`${url} の取得に失敗(curl): ${lastErr.message}`);
}

// 全角半角・空白の揺れを吸収した比較用文字列
const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '');

const shortHash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);

// 画像URL → ファイル名の本体（拡張子とサイズ接尾辞 -215x300 を除く）
function imageStem(url) {
  if (!url) return '';
  const file = decodeURIComponent(new URL(url).pathname.split('/').pop());
  return file.replace(/\.[a-z0-9]+$/i, '').replace(/-\d+x\d+$/, '');
}

function extFromResponse(url, type) {
  const m = new URL(url).pathname.match(/\.(png|jpe?g|webp|gif)$/i);
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
}

// 画像を取得して指定フォルダに保存し、保存したファイル名を返す。失敗時は例外。
async function downloadImage(url, dir, baseName) {
  const fs = require('fs');
  const path = require('path');
  const { buf, type } = await fetchWithRetry(url, { as: 'buffer' });
  if (!/^image\//.test(type) || buf.length < 100) throw new Error(`画像ではない応答 (${type}, ${buf.length}B)`);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${baseName}.${extFromResponse(url, type)}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return file;
}

module.exports = { USER_AGENT, sleep, jstNow, fetchWithRetry, fetchWithCurl, norm, shortHash, imageStem, extFromResponse, downloadImage };
