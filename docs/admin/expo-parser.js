// 買取EXPO・にこにこ買取のXポスト（テキスト）を読み取る。ブラウザ（管理画面）とNode（収集・テスト）の両方で使う。
//
// 想定しているポストの書式（実物のポストから確認したもの）:
//   ✅ポケカ Box                          ← 区分の見出し（1日に複数本ポストされる）
//   🔥30th CELEBRATION 26500円            ← 買取中（価格あり）
//   30th CELEBRATIONシュリ無 21000円      ← シュリンク無し（付いていなければシュリンク付き）
//   ブラックボルト 〆切                    ← 買取停止
//   (カートン)OP-01 Romance Dawn 450000円 ← カートン
//   OP-17 世界最強の戦士テープカット 9000円 ← テープカット（ワンピース・ドラゴンボール等。付いていなければテープ付き）
//   下記商品の買取価格を只今より変更…      ← 価格変更のお知らせ（商品名の行 → 「22,000円」の行、の繰り返し）
//
// にこにこ買取は見出し（✅）が無いポスト。区分は「見出しを選ぶ」で毎回手動で選ぶ（低頻度のため自動判定はしない）:
//   ・30th CELEBRATION Box　BOX ¥23,200 ／ NS ¥16,700  ← 1行に状態が2つ（区分の condLabels で略号→状態を対応づけ）
//   【エクストラブースター】                            ← 見出し内の小分類。取り込みには使わない（無視される）
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

  // 商品名そのものが「白箱」「未開封カートン」を表している商品（スタートデッキ100など）は、印が無くても状態をそこから決める。
  // 名前は変えない（別の店の「MEGA スタートデッキ100」などと同じ商品としてまとめるのは、対応表 product-aliases.json の役目）
  function condFromName(name) {
    if (/白箱/.test(name)) return 'whitebox';
    if (/未開封カートン/.test(name)) return 'carton';
    return null;
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
    return { name: t, cond: cond || condFromName(t) || (section ? section.baseCondition || 'box' : null) };
  }

  const ITEM_LINE = /^(.*?)\s*(?:([0-9][0-9,]*)円|(〆切))\s*$/;
  const PRICE_ONLY = /^([0-9][0-9,]*)円$/;
  const UPDATE_MARK = /買取価格を.*変更/;
  // にこにこ買取の書式（見出しなし、"・商品名 BOX ¥12,000／NS ¥9,000" のように1行に状態が2つ入る）
  const BULLET_LINE = /^[・･]\s*(.+?)\s+([A-Za-z]+)\s*¥\s*([0-9][0-9,]*)(?:\s*[／/]\s*([A-Za-z]+)\s*¥\s*([0-9][0-9,]*))?\s*$/;

  // にこにこ買取のページ貼り付け形式: 「商品名 [型式] ¥金額 ¥金額」（金額の代わりに「準備中」）。列の意味は区分の pageCols
  const PAGE_CATEGORIES = ['ポケモンカード', 'ワンピースカード', 'ドラゴンボール', '遊戯王', 'ユニオンアリーナ', 'ヴァイスシュヴァルツ', 'ガンダムカードゲーム', 'ディズニー ロルカナ', 'その他(トレカ)', 'サプライ'];
  const PAGE_ROW = /^(.+?)\s+((?:(?:¥\s*[0-9][0-9,]*|準備中)\s*)+)$/;
  const PAGE_CODE = /^(op|eb|prb|fb|sb|st)-?(\d{2})$/i;

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
    // ✅見出し・価格変更マークが1つも無いテキスト（にこにこ買取など）のための保険。行だけ拾っておき、
    // 最後まで見出しが1つも無ければ、これで仮の区分を1つ作る（見出しがあるEXPO等では使わず、今までどおり捨てる）
    const preLines = [];
    let dateGuess = null;
    const ignoredAll = [];

    // にこにこ買取の「買取価格表」ページを、そのままコピーして貼り付けた形。「ポケモンカード」「64商品」のように、
    // ゲーム名の行のすぐ次に「N商品」の行が来る。ゲームごとに区分を自動で決める（見出しを選ぶ必要なし）
    const nl = lines.map((l) => nfkc(l).trim());
    const pageStarts = [];
    for (let i = 0; i < nl.length; i++) {
      if (!nl[i] || /[¥]/.test(nl[i])) continue;
      let j = i + 1;
      while (j < nl.length && !nl[j]) j++;
      if (j < nl.length && /^\d+\s*商品$/.test(nl[j]) && (PAGE_CATEGORIES.includes(nl[i]) || findSection(nl[i], sections))) pageStarts.push({ i, heading: nl[i] });
    }
    if (pageStarts.length) {
      pageStarts.forEach((st, k) => {
        const section = findSection(st.heading, sections);
        const seg = nl.slice(st.i + 1, k + 1 < pageStarts.length ? pageStarts[k + 1].i : nl.length).filter(Boolean);
        blocks.push({ kind: 'full', page: true, heading: st.heading, section, sectionId: section ? section.id : null, unknown: !section, skipped: !!(section && section.kind === 'skip'), lines: seg });
      });
      lines.length = 0; // 見出しごとの読み取りは、上でやったので不要
    }

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
      else if (line) preLines.push(line);
    }

    // 見出しが1つも無かった（にこにこ買取など）: 拾っておいた行で仮の区分を1つ作る。
    // 「見出しを選ぶ」で区分が決まったときも、他の区分と同じ仕組み（headingMap→headingsに追加）で拾えるよう findSection を通す
    if (!blocks.length && preLines.length) {
      const noHeadingSection = findSection('(見出しなし)', sections);
      blocks.push({ kind: 'full', heading: '(見出しなし)', section: noHeadingSection, sectionId: noHeadingSection ? noHeadingSection.id : null, unknown: !noHeadingSection, skipped: !!(noHeadingSection && noHeadingSection.kind === 'skip'), lines: preLines });
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
      } else if (b.page && b.section && b.section.pageCols) {
        // にこにこ買取のページ貼り付け: 列の順に状態が並ぶ。「準備中」は買取なし（載せない）
        const sec = b.section;
        for (const line of b.lines) {
          const m = line.match(PAGE_ROW);
          if (!m) {
            if (/¥/.test(line)) b.ignored.push(line);
            continue;
          }
          const words = m[1].trim().split(/\s+/);
          const code = words.length > 1 && PAGE_CODE.test(words[words.length - 1]) ? words.pop().toUpperCase().replace(/^([A-Z]+)-?(\d+)$/, '$1-$2') : null;
          const name = (code ? code + ' ' : '') + words.join(' ');
          const cells = m[2].match(/¥\s*[0-9][0-9,]*|準備中/g);
          cells.forEach((cell, i) => {
            const cond = (i === 0 && condFromName(name)) || sec.pageCols[i];
            if (!cond || cell === '準備中') return;
            push({ name, cond, price: Number(cell.replace(/[^0-9]/g, '')), closed: false, game: sec.game, raw: m[1] });
          });
        }
      } else if (b.section && b.section.condLabels) {
        // にこにこ買取など: 見出しが無く、1行に「BOX ¥12,000／NS ¥9,000」のように状態が2つ入る書式
        const sec = b.section;
        for (const line of b.lines) {
          const m = line.match(BULLET_LINE);
          if (!m) {
            if (!/^#/.test(line)) b.ignored.push(line);
            continue;
          }
          const name = nfkc(m[1]).replace(/\s+/g, ' ').trim();
          if (!name) continue;
          const pairs = [[m[2], m[3]]];
          if (m[4]) pairs.push([m[4], m[5]]);
          for (const [label, priceStr] of pairs) {
            const cond = (pairs[0][0] === label && condFromName(name)) || sec.condLabels[label.toUpperCase()];
            if (!cond) { b.warnings.push(`未知の状態の略号「${label}」: ${line}`); continue; }
            push({ name, cond, price: Number(priceStr.replace(/,/g, '')), closed: false, game: sec.game, raw: m[1] });
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
    // 見出しなしの仮区分は、中身（行）が無ければ結果に出さない
    return { blocks: blocks.filter((b) => b.lines.length).map(({ lines, ...rest }) => rest), dateGuess };
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
