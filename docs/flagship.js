// フラッグシップバトルの記念品カード配布枚数（推定）ページ。docs/data/flagship.json を読んで表示する。
(function () {
  'use strict';
  const app = document.getElementById('app');

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const num = (n) => n.toLocaleString('ja-JP');
  const md = (stamp) => (stamp ? `${+stamp.slice(5, 7)}/${+stamp.slice(8, 10)}` : '—');

  function seriesTable(round) {
    const caps = [...new Set(round.series.flatMap((s) => Object.keys(s.byCapacity)))].sort((a, b) => a - b);
    return h('div', { class: 'tablewrap', style: 'max-height:none' }, h('table', null,
      h('thead', null, h('tr', null,
        h('th', { class: 'name' }, '期間'),
        h('th', null, '開催数'),
        caps.map((c) => h('th', null, `${c}人`)),
        h('th', null, 'キャンセル'),
        h('th', null, 'データ取得日'))),
      h('tbody', null, round.series.map((s) => h('tr', null,
        h('th', { class: 'name', scope: 'row' }, h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.label)),
        h('td', null, num(s.active) + '件'),
        caps.map((c) => h('td', null, s.byCapacity[c] ? num(s.byCapacity[c]) + '件' : '—')),
        h('td', null, s.canceled ? num(s.canceled) + '件' : '—'),
        h('td', null, md(s.fetchedAt))))),
      h('tfoot', null, h('tr', null,
        h('th', { class: 'name', scope: 'row' }, '合計'),
        h('td', null, num(round.totals.active) + '件'),
        caps.map((c) => h('td', null, round.totals.byCapacity[c] ? num(round.totals.byCapacity[c]) + '件' : '—')),
        h('td', null, round.totals.canceled ? num(round.totals.canceled) + '件' : '—'),
        h('td', null, '')))));
  }

  function prizeCard(p) {
    const rules = Object.entries(p.rules).sort((a, b) => a[0] - b[0]).map(([cap, n]) => `${cap}人開催 → ${n}枚`).join('　/　');
    return h('div', { class: 'card', style: 'display:flex; gap:12px; align-items:flex-start' },
      p.image ? h('img', { src: p.image, alt: p.cardName, style: 'width:100px; height:auto; border-radius:6px; flex:none' }) : null,
      h('div', null,
        h('div', { class: 't' }, `${p.label}記念品「${p.cardName}」${p.cardCode ? `（${p.cardCode}）` : ''}`),
        h('div', { style: 'font-size:28px; font-weight:700; margin:6px 0' }, `推定 ${num(p.estimate)} 枚`),
        h('div', { class: 's' }, `配布条件: ${rules}`)));
  }

  function roundView(round) {
    return h('div', { class: 'box', style: 'margin-bottom:16px' },
      h('h2', { style: 'margin-top:0' }, round.label),
      h('p', { class: 'muted small' }, round.period),
      h('div', { class: 'grid', style: 'margin-bottom:14px' }, round.prizes.map(prizeCard)),
      seriesTable(round));
  }

  function historyCard(round, key, label) {
    const p = round[key];
    return h('div', { class: 'card' },
      p.image ? h('img', { src: p.image, alt: p.cardName, style: 'width:100%; height:auto; border-radius:6px; margin-bottom:6px' }) : null,
      h('div', { class: 's' }, `第${round.id}回・${label}`),
      h('div', { class: 't' }, p.cardName, p.cardCode ? h('span', { class: 'muted' }, `（${p.cardCode}）`) : null),
      p.note ? h('div', { class: 'muted small' }, p.note) : null,
      h('div', { class: 'small', style: 'margin-top:4px' }, p.estimate != null ? `推定 ${num(p.estimate)} 枚` : h('span', { class: 'muted' }, '推定枚数 未算出')));
  }

  function historyView(history) {
    return h('div', { class: 'box' },
      h('h2', { style: 'margin-top:0' }, '歴代の記念品カード'),
      h('p', { class: 'muted small' }, '出典: ', h('a', { href: 'https://tier-one-onepiece.jp/blog/flagship-battle-promo-card-list/', target: '_blank', rel: 'noopener' }, 'ティアワンメディア「フラッグシップバトル記念品（プロモ）一覧まとめ」'), '。推定枚数は、開催実績データがある回のみ表示します。'),
      h('div', { class: 'grid' }, history.flatMap((r) => [historyCard(r, 'winner', '優勝'), historyCard(r, 'best8', 'ベスト8')])));
  }

  function notes() {
    return h('div', { class: 'box' },
      h('h2', { style: 'margin-top:0' }, 'この数字について'),
      h('p', { class: 'muted small' }, 'OPTCG Port（ファンサイト）に掲載されている、フラッグシップバトル各回・各店舗の開催実績（募集定員）から、配布枚数を逆算した推定値です。以下の点にご注意ください。'),
      h('ul', { class: 'small' },
        h('li', null, h('b', null, '募集定員ベースの計算です。'), ' 実際には抽選倍率や当日欠席などにより、予定どおりのフルの人数で開催されなかったケースが一定数含まれている可能性があります（大会中止（キャンセル）分は集計から除いています）。'),
        h('li', null, h('b', null, '海外配布分は含みません。'), ' 過去のカードには海外向けに別途配布されるケースがありました。'),
        h('li', null, h('b', null, 'フラッグシップバトルEX（特別大型大会）の配布分は含みません。'), ' 通常の店舗開催のみが集計対象です。'),
        h('li', null, h('b', null, '集計時点のスナップショットです。'), ' 開催実績は今後変わる可能性があります。')));
  }

  function render(data) {
    app.replaceChildren(h('div', null,
      h('div', { class: 'crumb' }, h('a', { href: 'index.html#/' }, 'ホーム'), ' › フラッグシップバトル 記念品カード配布枚数（推定）'),
      h('h1', null, 'フラッグシップバトル 記念品カード配布枚数（推定）'),
      data.rounds.map(roundView),
      data.history && data.history.length ? historyView(data.history) : null,
      notes()));
  }

  async function init() {
    try {
      const res = await fetch('data/flagship.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      render(await res.json());
    } catch (e) {
      app.replaceChildren(h('p', { class: 'empty' }, 'データを読み込めませんでした。しばらくしてからもう一度お試しください。'));
    }
  }
  init();
})();
