// 実行: node --test scripts/box/manual.test.js
// 「本日休止」が、手入力店舗（区分ごと）と自動取得の店舗（ゲームごと）の両方で正しく動くかを確認する。
const test = require('node:test');
const assert = require('node:assert/strict');
const { applySubmission } = require('./manual');

const T = '2026-09-24T13:00:00+09:00';
const entry = (store, game, pid, cond, src) => [`${store}|${pid}|${cond}`, { ref: { store, game, pid, cond, ...(src ? { src } : {}) }, shown: { state: 'value', price: 1000 }, confirmed: { state: 'value', price: 1000 }, pending: null, ignored: null, lastEvent: null }];

const config = {
  thresholdPct: 50,
  conditions: [{ id: 'box' }, { id: 'shrink' }],
  games: [{ id: 'pokemon' }, { id: 'onepiece' }],
  stores: [
    { id: 'collect', type: 'manual', sections: [{ id: 'collect-pokemon-box', group: 'ボックス' }, { id: 'collect-onepiece', group: 'ワンピース' }] },
    { id: 'runto', type: 'auto', sources: [{ game: 'pokemon' }, { game: 'onepiece' }] },
  ],
};

function ctx(entries) {
  return { config, state: { entries: Object.fromEntries(entries), meta: {} }, products: {}, now: { stamp: T, date: '2026-09-24' } };
}

test('自動取得の店舗も「本日休止」を受け付ける（ゲームごとに全商品が休止になる）', () => {
  const c = ctx([entry('runto', 'pokemon', 'p1', 'shrink'), entry('runto', 'onepiece', 'p2', 'tape')]);
  const out = { historyRows: [], events: [], runLines: [] };
  const res = applySubmission({ store: 'runto', type: 'paused', createdAt: T }, c, out);
  assert.deepEqual(res, { type: 'paused', paused: 2 });
  assert.equal(c.state.entries['runto|p1|shrink'].shown.state, 'paused');
  assert.equal(c.state.entries['runto|p2|tape'].shown.state, 'paused');
  assert.equal(c.state.meta['runto|pokemon'].lastOkAt, T);
  assert.equal(c.state.meta['runto|onepiece'].lastOkAt, T);
});

test('手入力店舗の「本日休止」は今までどおり区分ごと', () => {
  const c = ctx([entry('collect', 'pokemon', 'p1', 'box', 'collect-pokemon-box'), entry('collect', 'onepiece', 'p2', 'tape', 'collect-onepiece')]);
  const out = { historyRows: [], events: [], runLines: [] };
  applySubmission({ store: 'collect', type: 'paused', createdAt: T }, c, out);
  assert.equal(c.state.entries['collect|p1|box'].shown.state, 'paused');
  assert.equal(c.state.meta['collect|collect-pokemon-box'].lastOkAt, T);
});

test('自動取得の店舗に「全商品リスト」を送っても、手入力専用のためエラーになる', () => {
  const c = ctx([]);
  assert.throws(() => applySubmission({ store: 'runto', type: 'full', blocks: [] }, c, { historyRows: [], events: [], runLines: [] }), /手動入力の店舗ではありません/);
});
