// 実行: node --test scripts/box/kaitoribase.test.js
// 買取BASE（kaitori-base.com）は、1ページに ONE PIECE→ドラゴンボール→遊戯王→ポケモンの順で<table>が並ぶ。
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../sites/kaitoribase.js');

const page = (tables) => `<html><body>${tables.map((rows) => `<table><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('')}</body></html>`;

test('parsePrice: 金額あり→price / 買取停止・要問合せ（未掲載）は、他の店の「〆切」と同じ closed に揃える', () => {
  assert.deepEqual(K.parsePrice('25,000'), { price: 25000, status: 'price' });
  assert.deepEqual(K.parsePrice('買取停止'), { price: null, status: 'closed' });
  assert.deepEqual(K.parsePrice('要問合せ'), { price: null, status: 'closed' });
  assert.deepEqual(K.parsePrice(''), { price: null, status: 'closed' });
});

test('見出し行（商品名…）と空行は無視し、状態はすべてBOX（ポケモン以外）', () => {
  const onepieceTable = [
    ['商品名（ONE PIECE）', '定価', '買取価格'],
    ['世界最強の戦士', '5,760', '10,300'],
    ['決戦の刻', '5,280', '要問合せ'],
    ['', '', ''],
  ];
  const html = page([onepieceTable, [], [], []]);
  const rows = K.load ? null : null; // load はHTTP経由なので、ここでは rowsFromTable を直接使う
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const out = K.rowsFromTable($, $('table').get(0), 'onepiece');
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].name, out[0].cond, out[0].price], ['世界最強の戦士', 'box', 10300]);
  assert.deepEqual([out[1].name, out[1].status], ['決戦の刻', 'closed']);
});

test('ポケモンだけは cond が shrink（価格帯が他店のシュリンク付きと揃うため）', () => {
  const cheerio = require('cheerio');
  const table = [
    ['商品名（ポケモン）', '定価', '買取価格'],
    ['30th CELEBRATION', '9,000', '26,800'],
  ];
  const html = `<table><tbody>${table.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const $ = cheerio.load(html);
  const out = K.rowsFromTable($, $('table').get(0), 'pokemon');
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].name, out[0].cond, out[0].price], ['30th CELEBRATION', 'shrink', 26800]);
});

test('ドラゴンボール: 商品ではない付属品（エナジーマーカー等）は除外する', () => {
  const cheerio = require('cheerio');
  const table = [
    ['商品名（ドラゴンボール）', '定価', '買取価格'],
    ['神龍への願い', '5,280', '21,000'],
    ['エナジーマーカー01', '', '買取停止'],
  ];
  const html = `<table><tbody>${table.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const $ = cheerio.load(html);
  const out = K.rowsFromTable($, $('table').get(0), 'dragonball');
  assert.equal(out.length, 1);
  assert.equal(out[0].name, '神龍への願い');
});

test('load: ページ内の表の並び順（onepiece→dragonball→yugioh→pokemon）どおりに、指定ゲームの表を読む', async () => {
  const mk = (name, price) => [name, '5,000', String(price)];
  const html = page([
    [['商品名（ONE PIECE）', '定価', '買取価格'], mk('ワンピ商品', 1000)],
    [['商品名（ドラゴンボール）', '定価', '買取価格'], mk('DB商品', 2000)],
    [['商品名（遊戯王）', '定価', '買取価格'], mk('遊戯王商品', 3000)],
    [mk('ポケカ商品', 4000)], // ポケモンの表だけ見出し行が無い（サイトの実際の作りと同じ）
  ]);
  const one = await K.load({ game: 'onepiece', url: 'https://kaitori-base.com/?p=9534' }, { data: html });
  const poke = await K.load({ game: 'pokemon', url: 'https://kaitori-base.com/?p=9534' }, { data: html });
  assert.equal(one[0].name, 'ワンピ商品');
  assert.equal(poke[0].price, 4000);
});

test('load: 表の並び順が想定と違うとき（見出しの文字が合わない）は、誤って別ゲームのデータを取り込まず止める', async () => {
  const mk = (name, price) => [name, '5,000', String(price)];
  // dragonball と yugioh の表を入れ替えてしまった状態を再現
  const html = page([
    [['商品名（ONE PIECE）', '定価', '買取価格'], mk('ワンピ商品', 1000)],
    [['商品名（遊戯王）', '定価', '買取価格'], mk('遊戯王商品', 3000)], // 本来はドラゴンボールの位置
    [['商品名（ドラゴンボール）', '定価', '買取価格'], mk('DB商品', 2000)],
    [mk('ポケカ商品', 4000)],
  ]);
  await assert.rejects(() => K.load({ game: 'dragonball', url: 'https://kaitori-base.com/?p=9534' }, { data: html }), /並び順/);
});
