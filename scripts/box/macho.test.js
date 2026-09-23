// 実行: node --test scripts/box/macho.test.js
// 買取マッチョは、ページのHTMLに "rows":[...] というJSON配列がそのまま（1回エスケープされた形で）埋め込まれている。
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../sites/macho.js');

// 実物のページと同じ形（"rows":[...] というJSONを、JS文字列として1回エスケープしてHTMLに埋め込む）。
// JSON.stringify を2回かけることで、正しくエスケープされた文字列を作る（手でエスケープすると間違えやすいため）。
function page(rows, { nextLink = false } = {}) {
  const embedded = JSON.stringify(JSON.stringify({ rows })).slice(1, -1); // {\"rows\":[...]}
  return `<html><body><script>self.__next_f.push([1,"X:${embedded}"])</script>${nextLink ? '<a href="?page=2">次へ →</a>' : ''}</body></html>`;
}
const item = (over = {}) => ({ id: 1, name: 'テスト', game: 'pokemon', model_number: null, rarity: null, pack_name: null, product_type: 'package', rank_system: 'none', rank_value: null, cert_number: null, condition: 'Shrink', condition_label: null, kaitori_price: null, hidden_label: '調整中', image_url: 'https://cdn.example.com/x.jpg', updated_at: null, group_id: 1, ...over });

test('埋め込まれたJSONを取り出す（実物と同じ形）', () => {
  const rows = M.extractRows(page([item({ id: 1 }), item({ id: 2, name: 'テスト2' })]));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, 'テスト2');
});

test('状態の対応（ポケモン）: Shrink/No shrink/No shrink・Pull tab/Carton/Unified pack/Pack', () => {
  const c = (condition) => M.toRow(item({ condition, kaitori_price: 1000 }), 'pokemon').cond;
  assert.equal(c('Shrink'), 'shrink');
  assert.equal(c('No shrink'), 'noshrink');
  assert.equal(c('No shrink/Pull tab'), 'noshrink'); // 店の説明どおり、シュリンクなしと同じ扱い
  assert.equal(c('Carton'), 'carton');
  assert.equal(c('Unified pack'), 'pack');
  assert.equal(c('Pack'), 'pack');
});

test('状態の対応（ワンピース）: Tape/Tape cut/Carton/Pack。テープ付きとテープカットは別の状態', () => {
  const c = (condition) => M.toRow(item({ game: 'onepiece', product_type: 'package', condition, kaitori_price: 1000 }), 'onepiece').cond;
  assert.equal(c('Tape'), 'tape');
  assert.equal(c('Tape cut'), 'tapecut');
  assert.notEqual(c('Tape'), c('Tape cut'));
  assert.equal(c('Carton'), 'carton');
});

test('価格がある: status=price。夜間の「調整中」など price が無い: status=unknown（前日の価格を引き継がない）', () => {
  const priced = M.toRow(item({ kaitori_price: 25500, hidden_label: null }), 'pokemon');
  assert.deepEqual([priced.status, priced.price], ['price', 25500]);
  const adjusting = M.toRow(item({ kaitori_price: null, hidden_label: '調整中' }), 'pokemon');
  assert.deepEqual([adjusting.status, adjusting.price], ['unknown', null]);
});

test('シングル・バラ（product_type: single/bulk）は対象外（null を返す）', () => {
  assert.equal(M.toRow(item({ product_type: 'single' }), 'pokemon'), null);
  assert.equal(M.toRow(item({ product_type: 'bulk' }), 'pokemon'), null);
});

test('区分（group）: package=ボックス、set=その他（セット・プロモ等）。ゲームでラベルが違う', () => {
  assert.equal(M.toRow(item({ product_type: 'package' }), 'pokemon').pack, 'ボックス');
  assert.equal(M.toRow(item({ product_type: 'set', condition: 'Normal', kaitori_price: 1 }), 'pokemon').pack, 'その他（セット・プロモ等）');
  assert.equal(M.toRow(item({ game: 'onepiece', product_type: 'package' }), 'onepiece').pack, 'BOX・カートン');
});

test('型番（model_number）は meta に入る（ワンピース・OP-17 など）', () => {
  const row = M.toRow(item({ game: 'onepiece', product_type: 'package', model_number: 'OP-17', name: 'OP-17 世界最強の戦士' }), 'onepiece');
  assert.equal(row.meta, 'OP-17');
});

test('load(): 複数ページを「次へ」リンクの有無で判断してまとめる（重複IDは1件だけ）', async () => {
  const p1 = page([item({ id: 1 })], { nextLink: true });
  const p2 = page([item({ id: 1 }), item({ id: 2 })]); // 1ページ目と2ページ目に同じ商品が重複掲載
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return calls === 1 ? p1 : p2;
  };
  const rows = await M.load({ game: 'pokemon' }, { fetcher });
  assert.equal(calls, 2);
  assert.equal(rows.length, 2);
});

test('load(): テスト用データ（配列）を渡すとネットワークに出ない', async () => {
  const rows = await M.load({ game: 'pokemon' }, { data: [page([item({ id: 9 })])] });
  assert.equal(rows.length, 1);
});
