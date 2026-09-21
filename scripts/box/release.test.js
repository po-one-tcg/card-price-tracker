// 実行: node --test scripts/box/release.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./release');

const lookup = R.buildLookup();
const rel = (game, name) => R.releaseFor(lookup, game, name);

test('ポケモン: 弾の名前どおりのものは発売日が引ける', () => {
  assert.equal(rel('pokemon', 'ストームエメラルダ'), '2026-07-31');
  assert.equal(rel('pokemon', '30th CELEBRATION BOX'), '2026-09-16');
  assert.equal(rel('pokemon', 'MEGAドリームex'), '2025-11-28');
});

test('ポケモン: 表記の違い（ex の有無・ペリペリ付・アクセント）を吸収する', () => {
  assert.equal(rel('pokemon', 'スカーレット'), rel('pokemon', 'スカーレットex')); // 店によって ex が付く/付かない
  assert.equal(rel('pokemon', 'ロストアビス ペリペリ付'), rel('pokemon', 'ロストアビス'));
  assert.equal(rel('pokemon', 'Pokemon GO'), '2022-06-17'); // 発売日の表は "Pokémon GO"
});

test('ポケモン: 別名の対応表（151 など）', () => {
  assert.equal(rel('pokemon', 'ポケモンカード151'), '2023-06-16');
  assert.equal(rel('pokemon', 'ポケモン151'), '2023-06-16');
  assert.equal(rel('pokemon', '151'), '2023-06-16');
  assert.equal(rel('pokemon', '仰天のボルテッカー'), '2020-09-18');
});

test('ワンピース: 型番で発売日が引ける（店ごとに名前が違っても）', () => {
  assert.equal(rel('onepiece', 'OP-17 世界最強の戦士'), '2026-08-22');
  assert.equal(rel('onepiece', 'OP-01 Romance Dawn'), '2022-07-22');
  assert.equal(rel('onepiece', 'OP-01 ロマンスドーン'), '2022-07-22');
  assert.equal(rel('onepiece', 'EB-02 Anime 25th collection'), '2025-01-25');
  assert.equal(rel('onepiece', 'PRB-01 THE BEST'), '2024-07-27');
});

test('発売日が分からない商品は null（別のゲームの表は使わない）', () => {
  assert.equal(rel('pokemon', 'ゴールデンボックス'), null);
  assert.equal(rel('pokemon', 'OP-01 Romance Dawn'), null);
  assert.equal(rel('yugioh', '30th CELEBRATION'), null);
});

test('並び順: 区分の順 → 発売日の新しい順 → 発売日なしは最後（型番の新しい順、次に名前順）', () => {
  const groupOrder = { pokemon: ['新', '旧'] };
  const products = [
    { game: 'pokemon', group: '旧', name: 'C', release: '2010-01-01' },
    { game: 'pokemon', group: '新', name: 'Z不明', release: null },
    { game: 'pokemon', group: '新', name: 'A古い', release: '2020-01-01' },
    { game: 'pokemon', group: '新', name: 'B新しい', release: '2025-01-01' },
    { game: 'pokemon', group: '新', name: 'A不明', release: null },
    { game: 'pokemon', group: '未登録の区分', name: 'X', release: '2030-01-01' },
  ];
  const names = products.sort(R.compareProducts(groupOrder)).map((p) => p.name);
  assert.deepEqual(names, ['B新しい', 'A古い', 'A不明', 'Z不明', 'C', 'X']);
});

test('並び順: 発売日が同じなら名前順、型番だけある商品は新しい型番が上', () => {
  const cmp = R.compareProducts({});
  const list = [
    { game: 'dragonball', group: 'DB', name: 'FB02 烈火の闘気', release: null },
    { game: 'dragonball', group: 'DB', name: 'FB11 BRIGHTNESS OF HOPE', release: null },
    { game: 'dragonball', group: 'DB', name: 'FB09 DUAL EVOLUTION', release: null },
    { game: 'pokemon', group: 'G', name: 'ブラックボルト', release: '2025-06-06' },
    { game: 'pokemon', group: 'G', name: 'ホワイトフレア', release: '2025-06-06' },
  ].sort(cmp).map((p) => p.name);
  assert.deepEqual(list, ['FB11 BRIGHTNESS OF HOPE', 'FB09 DUAL EVOLUTION', 'FB02 烈火の闘気', 'ブラックボルト', 'ホワイトフレア']);
});
