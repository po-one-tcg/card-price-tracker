// 実行: node --test scripts/box/merge.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { planMerges, applyPlans } = require('./merge');
const Expo = require('../../docs/admin/expo-parser.js');

const aliases = { pokemon: { テラスタルフェス: 'テラスタルフェスex' } };
const entry = (store, pid, cond) => ({ ref: { store, game: 'pokemon', pid, cond }, shown: { state: 'value', price: 1000 }, confirmed: { state: 'value', price: 1000 } });
const prod = (id, name, firstSeen = '2026-09-21') => ({ id, game: 'pokemon', name, groups: ['g'], firstSeen, image: null });
const auto = new Set(['pricebase']);

function fixture() {
  return {
    state: { entries: {
      'pricebase|A|box': entry('pricebase', 'A', 'box'),
      'expo|B|shrink': entry('expo', 'B', 'shrink'),
      'expo|B|noshrink': entry('expo', 'B', 'noshrink'),
    } },
    products: { A: prod('A', 'テラスタルフェスex'), B: prod('B', 'テラスタルフェス', '2026-09-20') },
  };
}

test('別表記の商品を1つに統合する計画を作る（自動取得の店舗にある方を残す）', () => {
  const { state, products } = fixture();
  const { plans, skipped } = planMerges(state, products, aliases, auto);
  assert.deepEqual(plans, [{ game: 'pokemon', keep: 'A', drop: ['B'], name: 'テラスタルフェスex' }]);
  assert.equal(skipped.length, 0);
});

test('統合すると、データのキー・商品IDが付け替わり、古い商品は消える', () => {
  const { state, products } = fixture();
  const { plans } = planMerges(state, products, aliases, auto);
  const keyMap = applyPlans(state, products, plans);
  assert.deepEqual([...keyMap.entries()].sort(), [['expo|B|noshrink', 'expo|A|noshrink'], ['expo|B|shrink', 'expo|A|shrink']]);
  assert.deepEqual(Object.keys(state.entries).sort(), ['expo|A|noshrink', 'expo|A|shrink', 'pricebase|A|box']);
  assert.equal(state.entries['expo|A|shrink'].ref.pid, 'A');
  assert.equal(products.B, undefined);
  assert.equal(products.A.firstSeen, '2026-09-20'); // 古い方の初出日を引き継ぐ
});

test('同じ店舗・状態のデータが両方にあるときは統合しない（履歴が混ざるため）', () => {
  const { state, products } = fixture();
  state.entries['expo|A|shrink'] = entry('expo', 'A', 'shrink'); // 同じ店(expo)が両方の名前で載せている
  const { plans, skipped } = planMerges(state, products, aliases, auto);
  assert.equal(plans.length, 0);
  assert.equal(skipped.length, 1);
});

test('対応表が無ければ何も統合しない / 統合後にもう一度計画しても何も出ない（繰り返し安全）', () => {
  const { state, products } = fixture();
  assert.equal(planMerges(state, products, {}, auto).plans.length, 0);
  const { plans } = planMerges(state, products, aliases, auto);
  applyPlans(state, products, plans);
  assert.equal(planMerges(state, products, aliases, auto).plans.length, 0);
});

test('別商品（プレミアムトレーナーボックスの ex / MEGA / Vstar）は、対応表に無ければ統合されない', () => {
  const products = { X: prod('X', 'プレミアムトレーナーボックスex'), Y: prod('Y', 'プレミアムトレーナーボックスMEGA'), Z: prod('Z', 'プレミアムトレーナーボックスVstar') };
  const state = { entries: { 'expo|X|box': entry('expo', 'X', 'box'), 'expo|Y|box': entry('expo', 'Y', 'box'), 'expo|Z|box': entry('expo', 'Z', 'box') } };
  assert.equal(planMerges(state, products, aliases, auto).plans.length, 0);
});

test('別表記の判定キー: 連鎖・メモ行・別ゲームへの影響', () => {
  const r = Expo.makeResolver({ _readme: 'メモ', pokemon: { A: 'B', B: 'C' } });
  assert.equal(r('pokemon', 'A'), Expo.canon('C'));
  assert.equal(r('onepiece', 'A'), Expo.canon('A')); // 他のゲームには効かない
});
