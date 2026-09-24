// 実行: node --test scripts/box/expo-parser.test.js
// 2026-09-21 の買取EXPOの実際のポスト（fixtures/）を使ったテスト。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../../docs/admin/expo-parser.js');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'box-targets.json'), 'utf8'));
const sections = config.stores.find((s) => s.id === 'expo').sections;
const read = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const day = P.parse(read('expo-2026-09-21.txt'), sections);
const block = (id) => day.blocks.find((b) => b.sectionId === id);
const item = (id, raw, cond) => block(id).items.find((i) => i.raw.includes(raw) && (!cond || i.cond === cond));

test('1日ぶんの11本のポストが、すべて既知の見出しとして読み取れる', () => {
  assert.equal(day.blocks.length, 11);
  assert.equal(day.blocks.filter((b) => b.unknown).length, 0);
  assert.deepEqual(day.dateGuess, { month: 9, day: 21 });
});

test('区分ごとの商品数（価格あり + 〆切）', () => {
  const count = (id) => block(id).items.length;
  assert.equal(count('yugioh'), 2);
  assert.equal(count('mtg'), 5);
  assert.equal(count('unionarena'), 28);
  assert.equal(count('weiss-lorcana'), 10);
  assert.equal(count('dragonball'), 15);
  assert.equal(count('onepiece'), 46); // 23弾 × (box + カートン)
  assert.equal(count('pokemon-old-box'), 16);
  assert.equal(count('pokemon-box'), 80);
  assert.equal(day.blocks.reduce((n, b) => n + b.items.length, 0), 299);
});

test('ポケカシングル全種（レート表）は取り込まない', () => {
  assert.equal(block('pokemon-single').skipped, true);
  assert.equal(block('pokemon-single').items.length, 0);
});

test('BOXではないレート（バラパック等）は対象外の設定で外れる', () => {
  const b = block('onepiece-other');
  assert.equal(b.items.some((i) => /バラパック|パラレル\(キャラクター/.test(i.name)), false);
  assert.equal(b.ignored.length, 2);
});

test('価格あり / 〆切', () => {
  const a = item('pokemon-box', 'ストームエメラルダ', 'shrink');
  assert.deepEqual([a.price, a.closed], [10500, false]);
  const c = item('pokemon-box', 'ブラックボルト', 'shrink');
  assert.deepEqual([c.price, c.closed], [null, true]);
});

test('シュリ無 = シュリンク無し、印が無ければ区分の基本の状態（ポケカBOXはシュリンク付き）', () => {
  assert.equal(item('pokemon-box', '30th CELEBRATION', 'noshrink').price, 21000);
  assert.equal(item('pokemon-box', '30th CELEBRATION', 'shrink').price, 26500);
  assert.equal(item('pokemon-box', '30th CELEBRATION', 'noshrink').name, '30th CELEBRATION');
});

test('シュリ無ペリペリ付 は別の名前（ペリペリ付）として区別する', () => {
  const v = block('pokemon-box').items.find((i) => i.name === 'Vstarユニバース ペリペリ付');
  assert.deepEqual([v.cond, v.price], ['noshrink', 22000]);
});

test('(カートン) は状態 carton、付いていなければ tape（ワンピース）。名前の末尾の "box" は取り除く', () => {
  assert.equal(item('onepiece', 'OP-01', 'carton').price, 450000);
  assert.equal(item('onepiece', 'OP-01', 'tape').price, 36500);
  assert.equal(item('onepiece', 'OP-01', 'tape').name, 'OP-01 Romance Dawn');
  assert.equal(item('onepiece', 'OP-03', 'carton').closed, true);
  assert.equal(item('onepiece', 'OP-03', 'tape').closed, false);
});

test('テープカット は状態 tapecut（ワンピース・ドラゴンボール等、付いていなければテープ付き）', () => {
  const collectSections = config.stores.find((s) => s.id === 'collect').sections;
  const text = '✅コレクト ワンピース BOX・カートン\nOP-17 世界最強の戦士 15200円\nOP-17 世界最強の戦士テープカット 9000円\n';
  const parsed = P.parse(text, collectSections);
  const items = parsed.blocks[0].items;
  const tape = items.find((i) => i.cond === 'tape');
  const cut = items.find((i) => i.cond === 'tapecut');
  assert.deepEqual([tape.name, tape.price], ['OP-17 世界最強の戦士', 15200]);
  assert.deepEqual([cut.name, cut.price], ['OP-17 世界最強の戦士', 9000]);
});

test('二重スペースがあっても同じ商品として扱える', () => {
  assert.equal(item('onepiece', 'OP-08', 'carton').name, 'OP-08 二つの伝説');
  assert.equal(P.canon('PRB-01 The best  box'), P.canon('PRB-01 The best'));
});

test('ヴァイス&ロルカナの1本のポストを、名前でゲームに振り分ける', () => {
  const b = block('weiss-lorcana');
  const games = Object.fromEntries(b.items.map((i) => [i.name, i.game]));
  assert.equal(games['ロルカナ THE FIRST CHAPTER 物語のはじまり'], 'lorcana');
  assert.equal(games['ロルカナ WILDS UNKNOWN 未知なる彼方へ'], 'lorcana');
  assert.equal(games['ヴァイスNikke'], 'weiss');
  assert.equal(games['マーベル Marvel vol.2'], 'weiss');
});

test('本文以外の行（案内文・ハッシュタグ）は商品にならない', () => {
  assert.equal(block('pokemon-old-box').items.some((i) => /お問い合わせ|即日/.test(i.name)), false);
  assert.equal(block('pokemon-box').items.some((i) => /カートンも買取|公式Line/.test(i.name)), false);
  assert.equal(block('pokemon-box').items.length, 80);
});

test('価格変更のお知らせ: 商品名の行 + 「22,000円」の行', () => {
  const u = P.parse(read('expo-update.txt'), sections);
  assert.equal(u.blocks.length, 1);
  assert.equal(u.blocks[0].kind, 'update');
  assert.deepEqual(u.blocks[0].items.map((i) => [i.name, i.cond, i.price]), [
    ['30th CELEBRATION', 'noshrink', 22000],
    ['ストームエメラルダ', null, 11000], // 状態の印が無いものは、取り込み時に既存の商品から決める
  ]);
});

test('未知の見出しは unknown になり、勝手に取り込まれない', () => {
  const r = P.parse('✅新しいジャンル 買取価格\n🔥テスト 1000円', sections);
  assert.equal(r.blocks[0].unknown, true);
  assert.equal(r.blocks[0].sectionId, null);
});

test('見出しの表記ゆれ（全角半角・スペース・バ/ヴ）を吸収する', () => {
  const a = P.parse('✅ヴァイスシュヴァルツ＆ロルカナ　買取価格\n🔥ヴァイスX 1000円', sections);
  assert.equal(a.blocks[0].sectionId, 'weiss-lorcana');
});

test('商品の同一判定: PRICE BASE の「30th CELEBRATION BOX」と EXPO の「30th CELEBRATION」', () => {
  const products = [{ id: 'p1', game: 'pokemon', name: '30th CELEBRATION BOX' }, { id: 'p2', game: 'onepiece', name: '30th CELEBRATION' }];
  assert.equal(P.matchProduct('pokemon', '30th CELEBRATION', products).id, 'p1');
  assert.equal(P.matchProduct('pokemon', '30th CELEBRATION FUTURISTIC BOX', products), null);
});

test('同じ商品が2回書かれていたら警告して後の行を採用', () => {
  const r = P.parse('✅遊戯王 買取価格\n🔥A商品 1000円\n🔥A商品 2000円', sections);
  assert.equal(r.blocks[0].items.length, 1);
  assert.equal(r.blocks[0].items[0].price, 2000);
  assert.equal(r.blocks[0].warnings.length, 1);
});

// ---- 買取コレクト（価格表の画像を、決まった書式の文章に書き起こしたもの）----
const manualSections = config.stores.filter((s) => s.type === 'manual').flatMap((s) => s.sections.map((x) => ({ ...x, storeId: s.id })));
const collect = P.parse(read('collect-2026-09-19.txt') + '\n' + read('collect-update.txt'), manualSections);
const cblock = (id) => collect.blocks.find((b) => b.sectionId === id);

test('コレクト: 区分ごとの商品数（価格あり + 〆切）', () => {
  const n = (id) => cblock(id).items.length;
  assert.equal(n('collect-pokemon-box'), 114); // 57商品 × (シュリンク付き / 無し)
  assert.equal(n('collect-pokemon-other'), 31);
  assert.equal(n('collect-onepiece'), 46); // 23弾 × (BOX / カートン)
  assert.equal(n('collect-onepiece-other'), 36);
  assert.equal(n('collect-dragonball'), 5);
  assert.equal(n('collect-yugioh'), 4);
  assert.equal(cblock('collect-rates').skipped, true);
  assert.equal(collect.blocks.filter((b) => b.unknown).length, 0);
});

test('コレクト: ワンピースの価格（表の "-" は〆切）', () => {
  const it = (raw, cond) => cblock('collect-onepiece').items.find((i) => i.raw.includes(raw) && i.cond === cond);
  assert.equal(it('OP-17', 'carton').price, 145000);
  assert.equal(it('OP-17', 'tape').price, 10500);
  assert.equal(it('OP-05', 'tape').price, 55000);
  assert.equal(it('OP-05', 'carton').closed, true);
  assert.equal(cblock('collect-onepiece').items.filter((i) => !i.closed).length, 11);
});

test('コレクト: 遊戯王は名前の末尾の「ボックス」「カートン」を状態として読む（シュリンク有無）', () => {
  const y = cblock('collect-yugioh').items;
  const heroesCarton = y.find((i) => /HEROES/.test(i.name) && i.cond === 'carton');
  assert.equal(heroesCarton.price, 315000);
  assert.equal(heroesCarton.name, '遊戯王 LIMIT OVER COLLECTION -THE HEROES-');
  assert.equal(y.find((i) => /HEROES/.test(i.name) && i.cond === 'shrink').closed, true);
});

test('コレクト: 店舗ごとに表記が違う商品を、型番や名前で同じ商品と判定する', () => {
  assert.equal(P.canon('OP-01 ロマンスドーン'), P.canon('OP-01 Romance Dawn'));
  assert.equal(P.canon('FB-02'), P.canon('FB02 烈火の闘気'));
  assert.equal(P.canon('MANGA BOOSTER 01 [SB01]'), P.canon('SB01 MANGA BOOSTER 01'));
  assert.equal(P.canon('DUAL EVOLUTION [FB09]'), P.canon('FB09 DUAL EVOLUTION'));
  assert.notEqual(P.canon('OP-13 受け継がれる意志'), P.canon('OP-14 蒼海の七傑')); // 型番が違えば別
  assert.notEqual(P.canon('ONE PIECE magazine 付録プロモ ST21-014'), P.canon('スタートデッキEX ルフィ&エース ST-30'));
  assert.equal(P.canon('遊戯王 LIMIT OVER COLLECTION THE HEROES'), P.canon('遊戯王 LIMIT OVER COLLECTION -THE HEROES-'));
});

test('コレクト: 価格変更の区分は「更新」として読み、状態の印が無いものは取り込み時に決める', () => {
  const u = cblock('collect-update');
  assert.equal(u.kind, 'update');
  assert.deepEqual(u.items.map((i) => [i.name, i.cond, i.price]), [
    ['30th CELEBRATION', null, 28000],
    ['30th CELEBRATION', 'noshrink', 22500],
    ['プレミアムデッキセット エーフィ・ブラッキー', null, 16000],
    ['30th CELEBRATION FUTURISTIC', null, 60000],
  ]);
});
