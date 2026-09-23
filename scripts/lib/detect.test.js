// 実行: node --test scripts/lib/
const test = require('node:test');
const assert = require('node:assert/strict');
const { step, applyDecision, isAnomalous } = require('./detect');

const T = (n) => `2026-09-${String(n).padStart(2, '0')}T11:00:00+09:00`;
const value = (price) => ({ kind: 'value', price });
const run = (entry, obs, day, baseline = true) => step(entry, obs, { now: T(day), baseline });

test('店舗の初回巡回は基準づくり: 出現イベントを出さない', () => {
  const r = run(null, value(10000), 1, false);
  assert.equal(r.events.length, 0);
  assert.equal(r.entry.confirmed.price, 10000);
  assert.deepEqual(r.rows, [{ t: T(1), st: 'value', v: 10000 }]);
});

test('2回目以降に初めて載った商品は出現', () => {
  const r = run(null, value(10000), 2, true);
  assert.deepEqual(r.events.map((e) => e.type), ['appear']);
  assert.equal(r.entry.lastEvent.type, 'appear');
});

test('取扱なし → 数値あり = 出現。大きな値でも保留にせず即反映', () => {
  let e = run(run(null, value(5000), 1, false).entry, { kind: 'absent' }, 2).entry;
  const r = run(e, value(500000), 3);
  assert.deepEqual(r.events.map((e) => e.type), ['appear']);
  assert.equal(r.entry.pending, null);
  assert.equal(r.entry.shown.price, 500000);
});

test('休止は出現・消滅にカウントしない: 金額あり → 休止 → 同じ金額 でイベントなし', () => {
  let r = run(run(null, value(5000), 1, false).entry, { kind: 'paused' }, 2);
  assert.equal(r.events.length, 0);
  assert.equal(r.entry.shown.state, 'paused');
  assert.equal(r.entry.shown.price, null); // 休止中は価格を出さない
  r = run(r.entry, value(5000), 3);
  assert.equal(r.events.length, 0);
  assert.equal(r.entry.shown.state, 'value');
  assert.equal(r.entry.shown.price, 5000);
});

test('何日も続けて休止のときは、since が最新の休止日に更新される（いつの休みか取り違えないため）', () => {
  let e = run(run(null, value(5000), 1, false).entry, { kind: 'paused' }, 2).entry;
  assert.equal(e.shown.since, T(2));
  const r = run(e, { kind: 'paused' }, 3);
  assert.equal(r.entry.shown.since, T(3));
  assert.deepEqual(r.rows, [{ t: T(3), st: 'paused', v: null }]);
});

test('休止のあとに大きく違う金額で再開したら、確定済みの金額と比べて異常検知する', () => {
  const e = run(run(null, value(5000), 1, false).entry, { kind: 'paused' }, 2).entry;
  assert.deepEqual(run(e, value(50000), 3).events.map((x) => x.type), ['anomaly']);
});

test('〆切（none）のあとの休止 → 再開は、通常どおり出現', () => {
  let e = run(run(null, value(5000), 1, false).entry, { kind: 'absent' }, 2).entry;
  e = run(e, { kind: 'paused' }, 3).entry;
  assert.deepEqual(run(e, value(5000), 4).events.map((x) => x.type), ['appear']);
});

test('数値あり → 掲載なし = 消滅。公開に即反映', () => {
  const e = run(null, value(5000), 1, false).entry;
  const r = run(e, { kind: 'absent' }, 2);
  assert.deepEqual(r.events.map((x) => x.type), ['disappear']);
  assert.equal(r.entry.shown.state, 'none');
  assert.equal(r.entry.lastEvent.type, 'disappear');
});

test('掲載なしが続いても消滅イベントは1回だけ', () => {
  let e = run(null, value(5000), 1, false).entry;
  e = run(e, { kind: 'absent' }, 2).entry;
  const r = run(e, { kind: 'absent' }, 3);
  assert.equal(r.events.length, 0);
  assert.equal(r.rows.length, 0);
});

test('数値あり → 数値あり: 小さな変動は通常反映（イベントなし）', () => {
  const e = run(null, value(10000), 1, false).entry;
  const r = run(e, value(11000), 2);
  assert.equal(r.events.length, 0);
  assert.equal(r.entry.shown.price, 11000);
  assert.equal(r.entry.pending, null);
});

test('数値あり → 数値あり: 閾値超は保留し、公開は前の価格のまま', () => {
  const e = run(null, value(14000), 1, false).entry;
  const r = run(e, value(140000), 2); // 桁間違い
  assert.deepEqual(r.events.map((x) => x.type), ['anomaly']);
  assert.equal(r.entry.pending.price, 140000);
  assert.equal(r.entry.shown.price, 14000);
  assert.equal(r.rows.length, 0);
});

test('0円は保留', () => {
  const e = run(null, value(14000), 1, false).entry;
  assert.deepEqual(run(e, value(0), 2).events.map((x) => x.type), ['anomaly']);
});

test('保留中に同じ値が続いても異常イベントは重複しない / 別の値なら更新', () => {
  let e = run(run(null, value(14000), 1, false).entry, value(140000), 2).entry;
  assert.equal(run(e, value(140000), 3).events.length, 0);
  assert.deepEqual(run(e, value(150000), 3).events.map((x) => x.type), ['anomaly']);
});

test('保留中に元の価格へ戻ったら保留は自動で消える', () => {
  let e = run(run(null, value(14000), 1, false).entry, value(140000), 2).entry;
  const r = run(e, value(14000), 3);
  assert.equal(r.entry.pending, null);
});

test('閾値ちょうど(50%)は通常、超えると保留', () => {
  assert.equal(isAnomalous(10000, 15000), false);
  assert.equal(isAnomalous(10000, 15001), true);
  assert.equal(isAnomalous(10000, 5000), false);
  assert.equal(isAnomalous(10000, 4999), true);
});

test('未確認: 前日の価格を引き継がない / 検知にも使わない', () => {
  let e = run(null, value(14000), 1, false).entry;
  let r = run(e, { kind: 'unknown' }, 2);
  assert.equal(r.entry.shown.state, 'unknown');
  assert.equal(r.entry.shown.price, null);
  assert.equal(r.events.length, 0);
  // 未確認から同じ金額に戻っても出現/消滅にならない
  r = run(r.entry, value(14000), 3);
  assert.equal(r.events.length, 0);
  assert.equal(r.entry.shown.state, 'value');
});

test('未確認を挟んだ後の変化も、確定済みの価格と比較して異常検知する', () => {
  let e = run(null, value(14000), 1, false).entry;
  e = run(e, { kind: 'unknown' }, 2).entry;
  assert.deepEqual(run(e, value(140000), 3).events.map((x) => x.type), ['anomaly']);
});

test('判断: approve は保留の価格を反映', () => {
  const e = run(run(null, value(14000), 1, false).entry, value(30000), 2).entry;
  const r = applyDecision(e, { action: 'approve' }, T(3));
  assert.equal(r.entry.shown.price, 30000);
  assert.equal(r.entry.pending, null);
});

test('判断: set は修正値を反映し、サイトが同じ誤値を出し続けても再保留しない', () => {
  let e = run(run(null, value(14000), 1, false).entry, value(140000), 2).entry;
  e = applyDecision(e, { action: 'set', price: 14500 }, T(3)).entry;
  assert.equal(e.shown.price, 14500);
  const r = run(e, value(140000), 4); // サイトは相変わらず140000
  assert.equal(r.events.length, 0);
  assert.equal(r.entry.pending, null);
  assert.equal(r.entry.shown.price, 14500);
  // サイトの値が変われば判断は失効し、通常の判定に戻る
  assert.deepEqual(run(r.entry, value(14600), 5).entry.shown.price, 14600);
});

test('判断: dismiss は据え置き、同じ値では再保留しない', () => {
  let e = run(run(null, value(14000), 1, false).entry, value(140000), 2).entry;
  e = applyDecision(e, { action: 'dismiss' }, T(3)).entry;
  assert.equal(e.shown.price, 14000);
  assert.equal(run(e, value(140000), 4).events.length, 0);
});

test('判断: 保留が無い項目への approve はエラー', () => {
  const e = run(null, value(14000), 1, false).entry;
  assert.throws(() => applyDecision(e, { action: 'approve' }, T(2)));
});

test('step は元の entry を書き換えない', () => {
  const e = run(null, value(14000), 1, false).entry;
  const snapshot = JSON.stringify(e);
  run(e, { kind: 'absent' }, 2);
  assert.equal(JSON.stringify(e), snapshot);
});
