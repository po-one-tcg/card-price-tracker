// 実行: node --test scripts/box/somurie.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../sites/somurie.js');

const card = (name, price) => `<div class="ant-card-body"><div><img alt="${name}" src="/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fp%2F1.jpg&amp;w=640"></div><div><p class="font-bold text-lg">${name}</p><div><p class="text-price-red"><span>${price}</span></p></div></div></div>`;
const page = (cards, extra = '') => `<html><head><title>商品一覧 | 買取ソムリエ</title></head><body>買取商品一覧${cards.join('')}${extra}</body></html>`;

test('商品名から状態と名前を取り出す（ポケモン）', () => {
  assert.deepEqual(S.parseName('ポケモンカードゲーム 30th CELEBRATION シュリンクなしボックス', 'pokemon'), { name: '30th CELEBRATION', cond: 'noshrink' });
  assert.deepEqual(S.parseName('ポケモンカードゲーム ストームエメラルダ （M6）シュリンク付き', 'pokemon'), { name: 'ストームエメラルダ', cond: 'shrink' });
  assert.deepEqual(S.parseName('ポケモンカードゲーム MEGA ニンジャスピナー（M4） シュリンク付きボックス', 'pokemon'), { name: 'ニンジャスピナー', cond: 'shrink' });
  assert.deepEqual(S.parseName('ポケモンカードゲーム MEGAドリームex シュリンク付き', 'pokemon'), { name: 'MEGAドリームex', cond: 'shrink' }); // MEGA は商品名の一部
  assert.deepEqual(S.parseName('ポケモンカードゲーム MEGA 30th CELEBRATION FUTURISTIC BOX', 'pokemon'), { name: '30th CELEBRATION FUTURISTIC BOX', cond: 'box' });
});

test('遊戯王: 先頭を「遊戯王 」に揃え、名前の末尾の「カートン」を状態にする', () => {
  assert.deepEqual(S.parseName('遊戯王オフィシャルカードゲーム デュエルモンスターズ デッキビルドパック グロリアス・ヴィクターズ カートン', 'yugioh'), { name: '遊戯王 デッキビルドパック グロリアス・ヴィクターズ', cond: 'carton' });
});

test('HTMLから行を作る: 金額・状態・画像URL。1000円未満（バラのレート）は除く', () => {
  const html = page([card('ポケモンカードゲーム アビスアイ シュリンク付き', '7,000'), card('ポケモンカード GYMジム プロモパック', '180')]);
  const rows = S.parse(html, { game: 'pokemon', minPrice: 1000 });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].name, rows[0].cond, rows[0].price, rows[0].status], ['アビスアイ', 'shrink', 7000, 'price']);
  assert.equal(rows[0].imageUrl, 'https://cdn.example.com/p/1.jpg');
});

test('商品が0件のカテゴリは、エラーではなく空（あとで買取を始めたら「出現」になる）', () => {
  assert.deepEqual(S.parse(page([]), { game: 'onepiece' }), []);
});

test('サイトの作りが変わった（別のページ）ときと、複数ページに分かれたときは、止める（誤って消滅にしない）', () => {
  assert.throws(() => S.parse('<html><head><title>メンテナンス</title></head><body></body></html>', { game: 'pokemon' }));
  const twoPages = page([card('ポケモンカードゲーム アビスアイ シュリンク付き', '7,000')], '<li class="ant-pagination-item">1</li><li class="ant-pagination-item">2</li>');
  assert.throws(() => S.parse(twoPages, { game: 'pokemon' }), /複数ページ/);
});
