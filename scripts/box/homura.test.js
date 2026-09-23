// 実行: node --test scripts/box/homura.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../sites/homura.js');

// 実物のカード（2026-09-23 取得）を元にした、最小限のHTML
const card = (tag, title, id, price) => `
  <div>
    <a href="/products/${id}?q%5B..%5D=1"><h5 class="text-sm">${tag ? `【${tag}】` : ''}${title}</h5></a>
    <div><span>${id}</span></div>
    <div><span class="text-xs">買取金額（税込）</span><span>¥ ${price}</span></div>
    <img src="https://cdn.kaitori-homura.com/uploads/${id}.jpg">
  </div>`;
const page = (total, cards) => `<html><body>対象商品：${total}件 ${cards.join('')}</body></html>`;

test('商品名の印から状態を判定する（ポケモン）', () => {
  assert.deepEqual(H.parseName('【BOX】30th CELEBRATION', 'pokemon', 'box'), { name: '30th CELEBRATION', cond: 'shrink' });
  assert.deepEqual(H.parseName('【シュリンク無しBOX】30th CELEBRATION', 'pokemon', 'box'), { name: '30th CELEBRATION', cond: 'noshrink' });
  assert.deepEqual(H.parseName('【カートン】ニンジャスピナー', 'pokemon', 'box'), { name: 'ニンジャスピナー', cond: 'carton' });
  assert.deepEqual(H.parseName('【白箱】ポケモンカードゲーム MEGA スタートデッキ100 バトルコレクション', 'pokemon', 'box'), { name: 'スタートデッキ100 バトルコレクション', cond: 'whitebox' });
});

test('印がない商品は、呼び出し側（URLの状態）を使う。ゲーム名の接頭辞（ポケモンカードゲーム MEGA など）は外す', () => {
  assert.deepEqual(H.parseName('ポケモンカードゲーム MEGA スタートデッキ100 バトルコレクション', 'pokemon', 'box'), { name: 'スタートデッキ100 バトルコレクション', cond: 'box' });
  // 全角の＆は、他の店（EXPO・コレクト）と同じく半角に揃う
  assert.deepEqual(H.parseName('スターターセットex　ニャオハ＆マスカーニャex', 'pokemon', 'box'), { name: 'スターターセットex ニャオハ&マスカーニャex', cond: 'box' });
});

test('ワンピース・遊戯王は【BOX】が box（ポケモンのようなシュリンクの区別はない）', () => {
  assert.deepEqual(H.parseName('【BOX】OP-17 世界最強の戦士', 'onepiece', 'box'), { name: 'OP-17 世界最強の戦士', cond: 'box' });
  assert.deepEqual(H.parseName('【カートン】OP-17 世界最強の戦士', 'onepiece', 'carton'), { name: 'OP-17 世界最強の戦士', cond: 'carton' });
});

test('対象商品：N件 を読む。見つからなければ例外（サイトの構造が変わった/ブロックされたとみなす）', () => {
  assert.equal(H.readTotal(page(83, [])), 83);
  assert.throws(() => H.readTotal('<html><body>メンテナンス中</body></html>'));
});

test('HTMLから行を作る: 金額・状態・画像URL', () => {
  const html = page(2, [card('BOX', 'アビスアイ', 6733, '8,000'), card(null, 'アビスアイ', 6733, '8,000')]); // 同じ商品IDの重複は除く
  const rows = H.parseCards(html, 'pokemon', 'shrink', 'ボックス');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].name, rows[0].cond, rows[0].price, rows[0].status], ['アビスアイ', 'shrink', 8000, 'price']);
  assert.equal(rows[0].imageUrl, 'https://cdn.kaitori-homura.com/uploads/6733.jpg');
  assert.equal(rows[0].pack, 'ボックス');
});

test('load(): 複数サブカテゴリ・複数ページを1つの取得元としてまとめる（テスト用データを渡す）', async () => {
  const src = {
    game: 'pokemon',
    group: 'ボックス',
    subcategories: [
      { id: 128, cond: 'shrink' },
      { id: 129, cond: 'noshrink' },
    ],
  };
  const data = {
    128: [page(1, [card('BOX', '30th CELEBRATION', 1, '25,500')])],
    129: [page(1, [card('シュリンク無しBOX', '30th CELEBRATION', 2, '21,000')])],
  };
  const rows = await H.load(src, { data });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.name, r.cond, r.price]).sort(), [['30th CELEBRATION', 'noshrink', 21000], ['30th CELEBRATION', 'shrink', 25500]]);
});

test('load(): テストデータに無いサブカテゴリは取得しない（ネットワークに出ない）', async () => {
  const src = { game: 'yugioh', group: '遊戯王', subcategories: [{ id: 159, cond: 'box' }, { id: 172, cond: 'carton' }] };
  const rows = await H.load(src, { data: { 159: [page(0, [])] } });
  assert.deepEqual(rows, []);
});
