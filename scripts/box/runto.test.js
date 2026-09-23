// 実行: node --test scripts/box/runto.test.js
// RUNTO の実際のAPIデータ（fixtures/runto-sample.json: 14商品）を使ったテスト。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../sites/runto.js');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'runto-sample.json'), 'utf8'));
const load = (game, category) => R.load({ game, category }, { data });

test('商品名を、他のお店の表記に揃える（ポケモン）', async () => {
  const names = new Set((await load('pokemon', 'card')).map((r) => r.name));
  for (const n of ['30th CELEBRATION', '30th CELEBRATION FUTURISTIC BOX', 'ストームエメラルダ', 'MEGAドリームex', 'ロケット団の栄光', 'レイジングサーフ', 'ポケモンセンターフクオカ', 'スタートデッキ100 バトルコレクション']) {
    assert.ok(names.has(n), `「${n}」がありません: ${[...names].join(' / ')}`);
  }
});

test('商品名: HTMLの記号（&#038; など）を元に戻す', () => {
  assert.equal(R.cleanTitle('ポケモンカードゲーム スカーレット&#038;バイオレット拡張パック 「ロケット団の栄光」', 'pokemon'), 'ロケット団の栄光');
});

test('商品名: ワンピース・ドラゴンボールは【型番】を先頭に付ける（型番で他店と同じ商品になる）', () => {
  assert.equal(R.cleanTitle('ONE PIECEカードゲーム ブースターパック 世界最強の戦士【OP-17】', 'onepiece'), 'OP-17 世界最強の戦士');
  assert.equal(R.cleanTitle('ドラゴンボールスーパーカードゲーム フュージョンワールド BRIGHTNESS OF HOPE【FB11】', 'dragonball'), 'FB11 BRIGHTNESS OF HOPE');
});

test('商品名: 遊戯王は先頭を「遊戯王 」に揃え、記号を整える', () => {
  assert.equal(R.cleanTitle('遊戯王 OCG デュエルモンスターズ LIMIT OVER COLLECTION &#8211; THE HEROES', 'yugioh'), '遊戯王 LIMIT OVER COLLECTION THE HEROES');
});

test('状態ごとに1行: シュリンク有=shrink / 無=noshrink / カートン=carton（ポケモン）', async () => {
  const rows = (await load('pokemon', 'card')).filter((r) => r.name === '30th CELEBRATION');
  const conds = Object.fromEntries(rows.map((r) => [r.cond, r]));
  assert.ok(conds.shrink && conds.noshrink && conds.carton);
  assert.ok(conds.shrink.price > 0 && conds.shrink.status === 'price');
  const st = (await load('pokemon', 'card')).filter((r) => r.name === 'ストームエメラルダ');
  assert.deepEqual(st.map((r) => r.cond).sort(), ['noshrink', 'shrink']);
  assert.ok(st.find((r) => r.cond === 'shrink').price > st.find((r) => r.cond === 'noshrink').price);
});

test('ワンピース・ドラゴンボールは、シュリンク有無をテープ付き/テープカットにする（EXPO・コレクトの表記に合わせる）', async () => {
  const rows = (await load('onepiece', 'onepiece')).filter((r) => r.name === 'OP-17 世界最強の戦士');
  assert.ok(rows.some((r) => r.cond === 'tape' && r.status === 'price'));
  assert.equal(rows.some((r) => r.cond === 'shrink' || r.cond === 'box'), false);
});

test('遊戯王はポケモンと同じくシュリンク有無のまま（上書きしない）', async () => {
  const rows = await load('yugioh', 'yugioh');
  const heroes = rows.filter((r) => /HEROES/.test(r.name));
  assert.ok(heroes.some((r) => r.cond === 'shrink' || r.cond === 'noshrink'), heroes.map((r) => r.cond).join(','));
  assert.equal(heroes.some((r) => r.cond === 'tape' || r.cond === 'box'), false);
});

test('単品の商品は box、在庫なしは closed（買取停止）', async () => {
  const rows = await load('pokemon', 'card');
  const fut = rows.find((r) => r.name === '30th CELEBRATION FUTURISTIC BOX');
  assert.deepEqual([fut.cond, fut.price, fut.status], ['box', 55000, 'price']);
  const out = rows.find((r) => r.name === 'レイジングサーフ');
  assert.equal(out.status, 'closed');
});

test('名前が「〜 カートン」の商品は、状態 carton（名前からカートンを外す）', async () => {
  const r = (await load('yugioh', 'yugioh')).find((x) => /ANIMATION CHRONICLE/.test(x.name));
  assert.equal(r.cond, 'carton');
  assert.equal(r.name, '遊戯王 デュエルモンスターズ ANIMATION CHRONICLE'.replace('デュエルモンスターズ ', ''));
});

test('カテゴリで絞り込む（別のカテゴリの商品は混ざらない）', async () => {
  assert.equal((await load('dragonball', 'dg')).every((r) => /^FB11/.test(r.name)), true);
  assert.equal((await load('pokemon', 'card')).some((r) => /OP-17|FB11/.test(r.name)), false);
});

test('別の属性（デッキ: BOX/カートン/白箱）も状態に対応づける', async () => {
  const rows = (await load('pokemon', 'card')).filter((r) => /スタートデッキ100/.test(r.name));
  assert.ok(rows.length >= 1);
  for (const r of rows) assert.ok(['box', 'carton', 'whitebox'].includes(r.cond), r.cond);
});
