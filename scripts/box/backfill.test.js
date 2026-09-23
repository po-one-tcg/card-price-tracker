// 実行: node --test scripts/box/backfill.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { backfill } = require('./backfill');

const config = {
  conditions: [{ id: 'shrink' }, { id: 'noshrink' }, { id: 'box' }],
  games: [{ id: 'pokemon' }, { id: 'onepiece' }],
  stores: [
    {
      id: 'collect',
      type: 'manual',
      sections: [
        { id: 'collect-pokemon-box', headings: ['コレクト ポケカ BOX'], game: 'pokemon', baseCondition: 'shrink' },
        { id: 'collect-rates', headings: ['コレクト ポケカシングルレート'], kind: 'skip' },
        { id: 'collect-update', headings: ['コレクト 価格変更'], kind: 'update' },
      ],
    },
  ],
};
const products = { p1: { id: 'p1', game: 'pokemon', name: '30th CELEBRATION' } };
const state = { entries: { 'collect|p1|shrink': { ref: { store: 'collect', game: 'pokemon', pid: 'p1', cond: 'shrink' } } } };

test('全商品リストを、指定した日付の履歴として追加する（state.json には触れない）', () => {
  const stateCopy = structuredClone(state);
  const text = '✅コレクト ポケカ BOX\n30th CELEBRATION 20000円\n30th CELEBRATIONシュリ無 18000円\n';
  const res = backfill({ config, products, state: stateCopy, aliases: {}, text, date: '2026-09-15' });
  assert.deepEqual(res.historyRows, [
    { t: '2026-09-15T13:00:00+09:00', k: 'collect|p1|shrink', st: 'value', v: 20000 },
    { t: '2026-09-15T13:00:00+09:00', k: 'collect|p1|noshrink', st: 'value', v: 18000 },
  ]);
  assert.deepEqual(res.runLines, [{ t: '2026-09-15T13:00:00+09:00', store: 'collect', src: 'collect-pokemon-box', ok: true, count: 2 }]);
  assert.deepEqual(stateCopy, state); // state は変更しない
});

test('対象外の区分（シングルレート）は取り込まない', () => {
  const text = '✅コレクト ポケカシングルレート\n（対象外）\n';
  const res = backfill({ config, products, state, aliases: {}, text, date: '2026-09-15' });
  assert.equal(res.historyRows.length, 0);
  assert.deepEqual(res.reports, [{ sectionId: 'collect-rates', skipped: true }]);
});

test('価格変更のお知らせ（update区分）は対象外', () => {
  const text = '✅コレクト 価格変更\n30th CELEBRATION 21000円\n';
  const res = backfill({ config, products, state, aliases: {}, text, date: '2026-09-15' });
  assert.equal(res.historyRows.length, 0);
  assert.equal(res.runLines.length, 0);
});

test('商品マスタに無い商品は unmatched として除外する', () => {
  const text = '✅コレクト ポケカ BOX\n未登録の商品 5000円\n未登録の商品シュリ無 4500円\n';
  const res = backfill({ config, products, state, aliases: {}, text, date: '2026-09-15' });
  assert.equal(res.historyRows.length, 0);
  assert.equal(res.reports[0].unmatched.length, 2);
});

test('〆切は st: none, v: null として履歴に入る', () => {
  const text = '✅コレクト ポケカ BOX\n30th CELEBRATION 〆切\n30th CELEBRATIONシュリ無 〆切\n';
  const res = backfill({ config, products, state, aliases: {}, text, date: '2026-09-15' });
  assert.deepEqual(res.historyRows, [
    { t: '2026-09-15T13:00:00+09:00', k: 'collect|p1|shrink', st: 'none', v: null },
    { t: '2026-09-15T13:00:00+09:00', k: 'collect|p1|noshrink', st: 'none', v: null },
  ]);
});

test('--time を指定すると、その時刻のタイムスタンプになる', () => {
  const text = '✅コレクト ポケカ BOX\n30th CELEBRATION 20000円\n30th CELEBRATIONシュリ無 18000円\n';
  const res = backfill({ config, products, state, aliases: {}, text, date: '2026-09-15', time: '09:30:00' });
  assert.equal(res.historyRows[0].t, '2026-09-15T09:30:00+09:00');
});

test('見出しを認識できないものは problems に出る', () => {
  const text = '✅知らない見出し\n何か 100円\n';
  const res = backfill({ config, products, state, aliases: {}, text, date: '2026-09-15' });
  assert.equal(res.problems.length, 1);
  assert.equal(res.historyRows.length, 0);
});
