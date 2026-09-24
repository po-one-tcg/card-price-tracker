// 買取EXPOのXポスト（テキスト）を読み取る。ブラウザ（管理画面）とNode（収集・テスト）の両方で使う。
//
// 想定しているポストの書式（実物のポストから確認したもの）:
//   ✅ポケカ Box                          ← 区分の見出し（1日に複数本ポストされる）
//   🔥30th CELEBRATION 26500円            ← 買取中（価格あり）
//   30th CELEBRATIONシュリ無 21000円      ← シュリンク無し（付いていなければシュリンク付き）
//   ブラックボルト 〆切                    ← 買取停止
//   (カートン)OP-01 Romance Dawn 450000円 ← カートン
//   OP-17 世界最強の戦士テープカット 9000円 ← テープカット（ワンピース・ドラゴンボール等。付いていなければテープ付き）
//   下記商品の買取価格を只今より変更…      ← 価格変更のお知らせ（商品名の行 → 「22,000円」の行、の繰り返し）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ExpoParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const nfkc = (s) => s.normalize('NFKC');
  const stripMarks = (s) => s.replace(/[️‍]/g, '').replace(/^[\s🔥✅⭐️★☆♦◆■●]+/u, '');

  // ワンピース・ドラゴンボールなどは、名前の表記が店ごとに違う（"OP-01 ロマンスドーン" と "OP-01 Romance Dawn"）。
  // 名前が型番（OP-01 / EB-04 / PRB-01 / FB02 / SB01 / ST01）で始まる、または末尾が [SB01] のものは、型番だけで同一判定する。
  const SET_CODE = /^(op|eb|prb|fb|sb|st)-?(\d{2})(?!\d)/i;
  const SET_CODE_BRACKET = /\[(op|eb|prb|fb|sb|st)-?(\d{2})\]$/i;

  // 商品の同一判定用の名前。全角半角・大文字小文字・空白・記号・"box" の違いを無視する。
  function canon(name) {
    const head = nfkc(name).trim();
    const code = head.match(SET_CODE) || head.match(SET_CODE_BRACKET);
    if (code) return (code[1] + code[2]).toLowerCase();
    return nfkc(name)
      .toLowerCase()
      .replace(/box/g, '')
      .replace(/[\s・･、,.．。:：!！?？'’"“”()[\]【】〈〉<>「」『』～~\-－―−_/＆&]/g, '');
  }

  // 商品名の行から「名前」と「状態」を取り出す
  function cleanName(raw, section) {
    let t = stripMarks(nfkc(raw)).trim();
    let cond = null;
    let variant = '';
    if (/^\(カートン\)\s*/.test(t)) {
      cond = 'carton';
      t = t.replace(/^\(カートン\)\s*/, '');
    }
    const m = t.match(/シュリ無(ペリペリ付)?/);
    if (m) {
      cond = 'noshrink';
      if (m[1]) variant = ' ペリペリ付';
      t = t.replace(m[0], '');
    }
    const mt = t.match(/\s*テープカット/);
    if (mt) {
      cond = 'tapecut';
      t = t.replace(mt[0], '');
    }
    if (/\s+カートン$/.test(t)) {
      cond = cond || 'carton'; // 「… カートン」（遊戯王など、名前の末尾に付く形）
      t = t.replace(/\s+カートン$/, '');
    }
    t = t.replace(/\s+(box|ボックス)$/i, '').replace(/\s+/g, ' ').trim() + variant;
    // 印が無いとき: 区分があればその基本の状態、区分が無ければ null（価格変更ポストでは取り込み時に既存商品から決める）
    return { name: t, cond: cond || (section ? section.baseCondition || 'box' : null) };
  }

  const ITEM_LINE = /^(.*?)\s*(?:([0-9][0-9,]*)円|(〆切))\s*$/;
  const PRICE_ONLY = /^([0-9][0-9,]*)円$/;
  const UPDATE_MARK = /買取価格を.*変更/;

  const normHeading = (s) => nfkc(s).toLowerCase().replace(/\s+/g, '');
  function findSection(heading, sections) {
    const h = normHeading(heading);
    return sections.find((s) => (s.headings || []).some((x) => normHeading(x) === h)) || null;
  }

  function gameFor(name, section) {
    const n = nfkc(name);
    for (const r of section.gameRules || []) if (n.includes(nfkc(r.contains))) return r.game;
    return section.game;
  }

  // text: 貼り付けられたポスト全文（複数本まとめてOK）, sections: 設定の区分一覧
  function parse(text, sections) {
    const lines = text.replace(/\r/g, '').split('\n');
    const blocks = [];
    let cur = null;
    let dateGuess = null;
    const ignoredAll = [];

    for (const rawLine of lines) {
      const line = nfkc(rawLine).trim();
      const d = line.match(/(\d{1,2})月(\d{1,2})日\s*買取価格/);
      if (d) dateGuess = { month: +d[1], day: +d[2] };

      const head = line.match(/^✅\s*(.+)$/);
      if (head) {
        const heading = head[1].trim();
        const section = findSection(heading, sections);
        // kind: 'update' の区分は「価格変更」専用（載っている商品の金額だけを更新する）
        cur = { kind: section && section.kind === 'update' ? 'update' : 'full', heading, section, sectionId: section ? section.id : null, unknown: !section, skipped: !!(section && section.kind === 'skip'), lines: [] };
        blocks.push(cur);
        continue;
      }
      if (UPDATE_MARK.test(line)) {
        cur = { kind: 'update', heading: '価格変更のお知らせ', section: null, sectionId: null, unknown: false, skipped: false, lines: [] };
        blocks.push(cur);
        continue;
      }
      if (cur && line) cur.lines.push(line);
    }

    for (const b of blocks) {
      b.items = [];
      b.ignored = [];
      b.warnings = [];
      if (b.skipped) continue;
      const seen = new Map();
      const push = (item) => {
        const key = item.game + '|' + canon(item.name) + '|' + item.cond;
        if (seen.has(key)) b.warnings.push(`重複: 「${item.name}」が2回あります（後の行を採用）`);
        seen.set(key, item);
      };

      if (b.kind === 'update' && b.section) {
        // 「商品名 金額円」の行形式の価格変更（見出し付き）
        for (const line of b.lines) {
          const m = line.match(ITEM_LINE);
          if (!m || !m[1].trim() || !m[2]) {
            if (!/^#/.test(line)) b.ignored.push(line);
            continue;
          }
          const c = cleanName(m[1], null);
          push({ name: c.name, cond: c.cond, price: Number(m[2].replace(/,/g, '')), closed: false, game: null, raw: m[1] });
        }
      } else if (b.kind === 'update') {
        // 買取EXPOの価格変更のお知らせ: 商品名の行 → 「22,000円」の行、の繰り返し
        let lastName = null;
        for (const line of b.lines) {
          const pm = line.match(PRICE_ONLY);
          if (pm && lastName) {
            const c = cleanName(lastName, null);
            push({ name: c.name, cond: c.cond, price: Number(pm[1].replace(/,/g, '')), closed: false, game: null, raw: lastName });
            lastName = null;
          } else if (!pm && !/^(#|お世話になっております|沢山の)/.test(line)) {
            lastName = line;
          }
        }
      } else {
        const sec = b.section || { baseCondition: 'box', game: null };
        const exclude = (sec.excludeContains || []).map(nfkc);
        for (const line of b.lines) {
          const m = line.match(ITEM_LINE);
          if (!m || !m[1].trim()) {
            if (!/^#/.test(line)) b.ignored.push(line);
            continue;
          }
          const c = cleanName(m[1], sec);
          if (!c.name) continue;
          if (exclude.some((word) => c.name.includes(word))) {
            b.ignored.push(line + '（取り込み対象外の設定）');
            continue;
          }
          push({ name: c.name, cond: c.cond, price: m[2] ? Number(m[2].replace(/,/g, '')) : null, closed: !m[2], game: b.section ? gameFor(c.name, sec) : null, raw: m[1] });
        }
      }
      b.items = [...seen.values()];
    }
    return { blocks: blocks.map(({ lines, ...rest }) => rest), dateGuess };
  }

  // 「別の表記 → 正とする表記」の対応表（config/product-aliases.json）を使って、同じ商品の判定キーを返す関数を作る。
  // aliases: { ゲームID: { "別の表記": "正とする表記" } }（"_" で始まるキーはメモなので無視）
  function makeResolver(aliases) {
    const map = {};
    for (const [game, pairs] of Object.entries(aliases || {})) {
      if (game.startsWith('_') || typeof pairs !== 'object') continue;
      map[game] = {};
      for (const [from, to] of Object.entries(pairs)) map[game][canon(from)] = canon(to);
    }
    return (game, name) => {
      let c = canon(name);
      const m = map[game];
      for (let i = 0; m && m[c] && i < 5; i++) c = m[c]; // 連鎖（A→B→C）も辿る
      return c;
    };
  }

  // 既存の商品（{id, game, name}）から、同じ商品を探す。見つからなければ null。
  function matchProduct(game, name, products, resolve) {
    const r = resolve || ((g, n) => canon(n));
    const c = r(game, name);
    return products.find((p) => p.game === game && r(game, p.name) === c) || null;
  }

  return { parse, canon, cleanName, matchProduct, findSection, makeResolver };
});
