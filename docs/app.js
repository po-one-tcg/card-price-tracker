// トレカBOX価格トラッカー 公開ページ。docs/data/box.json を読んで表示する（外部ライブラリなし）。
(function () {
  'use strict';
  const app = document.getElementById('app');
  let DATA = null;
  let byId = {};
  // スマホの「戻る」で前のページに戻ったとき、そのページで見ていた高さまでスクロールを戻すための記録
  // （ページ内のフィルタ切り替えとは別。ハッシュ（#/…）ごとに、離れる直前のスクロール位置を覚えておく）
  const scrollMemory = new Map();

  // ---------- 部品 ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + yen(Math.abs(n));
  const dayNum = (s) => Math.floor(Date.parse(s.slice(0, 10) + 'T00:00:00Z') / 86400000);
  const daysAgo = (s) => Math.max(0, dayNum(DATA.today) - dayNum(s));
  const agoText = (s) => (daysAgo(s) === 0 ? '今日' : daysAgo(s) + '日前');
  const md = (stamp) => `${+stamp.slice(5, 7)}/${+stamp.slice(8, 10)}`;
  const hm = (stamp) => stamp.slice(11, 16);
  const PERIOD_LABEL = { 1: '前日', 7: '1週間', 14: '2週間', 30: '1ヶ月', 90: '3ヶ月', 180: '半年' };
  const COND_ORDER = ['shrink', 'tape', 'noshrink', 'nopeel', 'tapecut', 'pack', 'carton', 'whitebox', 'red', 'blue', 'set', 'box'];
  // 個別ページだけ、既定と違う状態の並びにしたい商品（商品ID → 並び順）。「box」は他の多くの商品でも使う
  // 共通の状態のため、ここで個別に上書きしない限りCOND_ORDER全体を動かせない
  const PRODUCT_COND_ORDER = {
    pokemon_dd7c7925: ['box', 'whitebox', 'carton'], // スタートデッキ100 バトルコレクション
  };
  const condLabel = (id) => (DATA.conditions.find((c) => c.id === id) || { label: id }).label;
  const gameLabel = (id) => (DATA.games.find((g) => g.id === id) || { label: id }).label;
  const storeName = (id) => (DATA.stores.find((s) => s.id === id) || { name: id }).name;
  const pctText = (p) => (p > 0 ? '+' : p < 0 ? '−' : '±') + Math.abs(p).toFixed(1) + '%';
  const arrow = (v) => (v > 0 ? '▲' : v < 0 ? '▼' : '');
  const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

  // ---------- セル（店舗×商品×状態）----------
  // isMax: その行（同じ商品・同じ状態）の中で一番高い価格なら目立たせる（安い方は目立たせなくてよい）
  // 価格のセル（表示は中央寄せ。CSS の td.cell）
  function cellNode(cell, isMax) {
    const td = cellNodeInner(cell, isMax);
    td.classList.add('cell');
    return td;
  }
  function cellNodeInner(cell, isMax) {
    if (!cell) return h('td', { class: 'dash' }, '—');
    switch (cell.state) {
      case 'value': {
        const isNew = cell.event && cell.event.type === 'appear';
        // 前日比（このセル＝この店だけの動き）。無くなった／初めて付いた場合は前日比を出さない
        const diff = cell.dayDiff ? h('small', { class: cls(cell.dayDiff) }, arrow(cell.dayDiff) + yen(Math.abs(cell.dayDiff))) : null;
        return h('td', { class: (isNew ? 'is-new ' : '') + (isMax ? 'is-max' : '') },
          h('span', { class: 'price' }, yen(cell.price)),
          isNew ? h('small', null, h('span', { class: 'badge new' }, '🆕 出現 ' + agoText(cell.event.at))) : null,
          diff);
      }
      case 'none':
        if (cell.event && cell.event.type === 'disappear') {
          return h('td', { class: 'gone' }, h('span', { class: 'badge gone' }, '✕ 取扱終了'), h('small', null, agoText(cell.event.at)));
        }
        return h('td', { class: 'dash' }, '—');
      case 'paused':
        // 「休み」だけだと、いつ休みだったのか分からず機会損失につながるため、必ず日付を添える
        return h('td', { class: 'dash' }, '休み', h('small', null, md(cell.since)));
      case 'stale':
        return h('td', { class: 'unk' }, '未確認', h('small', null, cell.staleDays == null ? '未取得' : '最終更新 ' + cell.staleDays + '日前'));
      default:
        return h('td', { class: 'unk' }, '未確認');
    }
  }
  // 価格のセルが並んだ行の中で、一番高い価格のセルを true にした配列を返す
  function markMax(cells) {
    const max = Math.max(-1, ...cells.filter((c) => c && c.state === 'value').map((c) => c.price));
    return cells.map((c) => c && c.state === 'value' && c.price === max);
  }

  // 一覧で使う「代表の状態」: シュリンク付き → BOX(区別なし) → カートン → シュリンク無し の順で最初にあるもの。
  // 状態のフィルタが無いゲーム（例: MTG）で使う。状態が分かれているゲームでは、状態のフィルタ（exactCond）を常に指定する。
  const SUMMARY_ORDER = ['shrink', 'box', 'carton', 'noshrink', 'nopeel', 'tape', 'tapecut', 'whitebox', 'red', 'blue', 'set', 'pack'];
  // BOX（状態の区別なし）は、シュリンク付き／テープ付きと同じ扱いにする（別の状態としては出さない）
  function summaryCell(p, storeId, exactCond) {
    if (exactCond) {
      const cell = p.cells.find((x) => x.store === storeId && x.cond === exactCond);
      if (cell) return cell;
      if (exactCond === 'shrink' || exactCond === 'tape') return p.cells.find((x) => x.store === storeId && x.cond === 'box') || null;
      return null;
    }
    for (const c of SUMMARY_ORDER) {
      const cell = p.cells.find((x) => x.store === storeId && x.cond === c);
      if (cell) return cell;
    }
    return null;
  }

  // ---------- 表示の好み（状態・店舗のフィルタ）。ブラウザだけに覚えさせる（他の人には影響しない）----------
  const FILTER_KEY = 'boxtracker.filters.v1';
  function loadFilters() {
    try {
      const v = JSON.parse(localStorage.getItem(FILTER_KEY));
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
  function saveFilters() {
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch {}
  }
  let filters = loadFilters(); // { cond: { ゲームID: 状態ID }, hiddenStores: [店舗ID, ...] }
  function setCondFilter(gameId, condId) {
    filters = { ...filters, cond: { ...(filters.cond || {}), [gameId]: condId } };
    saveFilters();
    render(true); // フィルタの切り替えでは、スクロール位置を保つ（一覧を下の方まで見ていることが多いため）
  }
  function toggleStore(storeId, visibleCount) {
    const hidden = new Set(filters.hiddenStores || []);
    if (hidden.has(storeId)) hidden.delete(storeId);
    else {
      if (visibleCount <= 1) return; // 店舗を1つも表示しない状態にはしない
      hidden.add(storeId);
    }
    filters = { ...filters, hiddenStores: [...hidden] };
    saveFilters();
    render(true);
  }
  // 店舗の並び順（ブラウザだけに覚えさせる。既定は五十音順）
  const DEFAULT_STORE_ORDER = ['expo', 'collect', 'somurie', 'nikoniko', 'homura', 'pricebase', 'macho', 'runto'];
  function storeOrderArray() {
    const known = new Set(DATA.stores.map((s) => s.id));
    const saved = (filters.storeOrder || []).filter((id) => known.has(id));
    if (saved.length) return saved;
    const fallback = DEFAULT_STORE_ORDER.filter((id) => known.has(id));
    return [...fallback, ...DATA.stores.map((s) => s.id).filter((id) => !fallback.includes(id))];
  }
  function orderedStores(list) {
    const pos = Object.fromEntries(storeOrderArray().map((id, i) => [id, i]));
    return [...list].sort((a, b) => (pos[a.id] ?? 999) - (pos[b.id] ?? 999));
  }
  function moveStore(visibleIds, storeId, dir) {
    const idx = visibleIds.indexOf(storeId);
    const otherId = visibleIds[idx + dir];
    if (!otherId) return;
    const full = storeOrderArray();
    const ia = full.indexOf(storeId);
    const ib = full.indexOf(otherId);
    [full[ia], full[ib]] = [full[ib], full[ia]];
    filters = { ...filters, storeOrder: full };
    saveFilters();
    render(true);
  }
  let storeOrderOpen = false; // 「並び替え」パネルの開閉。ページ遷移をまたいでは覚えない一時的な表示状態

  // 状態・店舗のフィルタ欄（商品が複数状態を持つゲーム／店舗が2つ以上あるときだけ出す）
  function filterBar(gameId, allStores, condsHere, condSel) {
    if (condsHere.length <= 1 && allStores.length <= 1) return null;
    const collapsed = !!filters.filtersHidden;
    const toggleRow = h('div', { class: 'filter-row' },
      h('button', { class: 'chip ghost', type: 'button', onclick: () => { filters = { ...filters, filtersHidden: !collapsed }; saveFilters(); render(true); } }, collapsed ? '絞り込み設定を表示' : '絞り込み設定を隠す'));
    if (collapsed) return h('div', { class: 'filters' }, toggleRow);
    const hidden = new Set(filters.hiddenStores || []);
    const rows = [toggleRow];
    if (condsHere.length > 1) {
      rows.push(h('div', { class: 'filter-label' }, '状態'));
      rows.push(h('div', { class: 'filter-row' },
        condsHere.map((c) => h('button', { class: 'chip', type: 'button', 'aria-pressed': condSel === c ? 'true' : 'false', onclick: () => setCondFilter(gameId, c) }, condLabel(c)))));
    }
    if (allStores.length > 1) {
      const visibleCount = allStores.filter((s) => !hidden.has(s.id)).length;
      const ids = allStores.map((s) => s.id);
      rows.push(h('div', { class: 'filter-label' }, '店舗'));
      rows.push(h('div', { class: 'filter-row' },
        allStores.map((s) => h('button', { class: 'chip' + (hidden.has(s.id) ? ' off' : ''), type: 'button', 'aria-pressed': hidden.has(s.id) ? 'false' : 'true', onclick: () => toggleStore(s.id, visibleCount) }, s.name))));
      rows.push(h('div', { class: 'filter-actions' },
        hidden.size ? h('button', { class: 'link-btn', type: 'button', onclick: () => { filters = { ...filters, hiddenStores: [] }; saveFilters(); render(true); } }, 'すべて表示') : null,
        hidden.size < allStores.length ? h('button', { class: 'link-btn', type: 'button', onclick: () => { filters = { ...filters, hiddenStores: allStores.map((s) => s.id) }; saveFilters(); render(true); } }, '全解除') : null,
        h('button', { class: 'link-btn', type: 'button', onclick: () => { storeOrderOpen = !storeOrderOpen; render(true); } }, storeOrderOpen ? '並び替えを閉じる' : '並び替え')));
      if (storeOrderOpen) {
        rows.push(h('div', { class: 'store-reorder' },
          allStores.map((s, i) => h('div', { class: 'store-reorder-row' },
            h('span', { class: 'store-reorder-name' }, s.name),
            h('button', { class: 'order-btn', type: 'button', 'aria-label': s.name + 'を上へ', disabled: i === 0 ? true : null, onclick: () => moveStore(ids, s.id, -1) }, '▲'),
            h('button', { class: 'order-btn', type: 'button', 'aria-label': s.name + 'を下へ', disabled: i === allStores.length - 1 ? true : null, onclick: () => moveStore(ids, s.id, 1) }, '▼')))));
      }
    }
    return h('div', { class: 'filters' }, rows);
  }

  // ---------- グラフ（SVG）----------
  let chartSeq = 0; // ページ内で複数グラフを描くとき、塗りつぶしのグラデーションIDが被らないように
  function chart(series, fmtN) {
    // 発売前・取扱開始前など、値が無い期間が先頭や末尾に続くぶんは横軸から詰める（データがある範囲だけを描く）
    let lo = 0, hi = series.dates.length - 1;
    while (lo <= hi && series.avg[lo] === null) lo++;
    while (hi >= lo && series.avg[hi] === null) hi--;
    const dates = series.dates.slice(lo, hi + 1), avgTrimmed = series.avg.slice(lo, hi + 1);
    const pts = dates.map((d, i) => ({ d, n: dayNum(d), v: avgTrimmed[i] }));
    const vals = pts.filter((p) => p.v !== null);
    if (vals.length < 2) return h('p', { class: 'empty' }, 'グラフはデータが2日分たまると表示されます。');
    // 画面幅に合わせて描くので、スマホでも文字が縮小されない
    const W = Math.max(300, Math.min(700, app.clientWidth - 26)), H = W < 480 ? 200 : 230, L = 58, R = 12, T = 14, B = 28;
    let min = Math.min(...vals.map((p) => p.v)), max = Math.max(...vals.map((p) => p.v));
    if (min === max) { min *= 0.95; max *= 1.05; }
    const pad = (max - min) * 0.08; min -= pad; max += pad;
    const x0 = pts[0].n, x1 = pts[pts.length - 1].n || x0 + 1;
    const X = (n) => L + ((n - x0) / Math.max(1, x1 - x0)) * (W - L - R);
    const Y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
    const NS = 'http://www.w3.org/2000/svg';
    const s = (tag, attrs, text) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
      if (text != null) e.textContent = text;
      return e;
    };
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': '価格推移グラフ' });
    // 縦軸の目盛りは、1円単位のような半端な数字にならないよう、きりのいい間隔（最低でも100円単位）に丸める
    const rough = (max - min) / 3;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
    const norm = rough / mag;
    const step = Math.max((norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag, 100);
    const firstTick = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = firstTick; v <= max + 1e-6; v += step) ticks.push(v);
    if (!ticks.length) ticks.push(Math.round((min + max) / 2 / step) * step);
    for (const v of ticks) {
      svg.append(s('line', { class: 'grid', x1: L, x2: W - R, y1: Y(v), y2: Y(v) }));
      svg.append(s('text', { class: 'ax', x: L - 6, y: Y(v) + 4, 'text-anchor': 'end' }, yen(v)));
    }
    // 線の下をうっすら塗りつぶす（値がある範囲だけ。線を目立たせるための薄い彩りで、データそのものではない）
    if (vals.length > 1) {
      const gid = 'cg' + (++chartSeq);
      const defs = s('defs');
      const grad = s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(s('stop', { offset: 0, style: 'stop-color:var(--accent); stop-opacity:.16' }));
      grad.append(s('stop', { offset: 1, style: 'stop-color:var(--accent); stop-opacity:0' }));
      defs.append(grad);
      svg.append(defs);
      const baseline = H - B;
      const line = vals.map((p) => `${X(p.n).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' L ');
      const areaD = `M ${X(vals[0].n).toFixed(1)},${baseline} L ${line} L ${X(vals[vals.length - 1].n).toFixed(1)},${baseline} Z`;
      svg.append(s('path', { class: 'area', d: areaD, fill: `url(#${gid})` }));
    }
    // 巡回できなかった日・取扱なしの日は、値を補わずスキップして、前後にある値どうしを直線でつなぐ
    // （空白で途切れさせない。あとから間の日付が埋まれば、そのぶん自然に線が増える）
    if (vals.length > 1) svg.append(s('polyline', { class: 'ln', points: vals.map((p) => `${X(p.n).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ') }));
    for (const p of vals) {
      const c = s('circle', { class: 'pt', cx: X(p.n), cy: Y(p.v), r: 3 });
      c.append(s('title', {}, `${p.d}  ${yen(p.v)}${fmtN ? fmtN(p) : ''}`));
      svg.append(c);
    }
    const labels = [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]];
    labels.forEach((p, i) => svg.append(s('text', { class: 'ax', x: X(p.n), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle' }, md(p.d))));
    return svg;
  }

  // ---------- 画面: ホーム ----------
  function viewHome() {
    const counts = {};
    for (const p of DATA.products) counts[p.game] = (counts[p.game] || 0) + 1;
    return h('div', null,
      h('h1', null, 'ゲーム別の価格表'),
      h('div', { class: 'grid' },
        DATA.games.map((g) => {
          const n = counts[g.id] || 0;
          const st = Object.entries(DATA.storeGame).filter(([k]) => k.endsWith('|' + g.id)).map(([, v]) => v);
          const last = st.map((s) => s.lastOkAt).filter(Boolean).sort().pop();
          return n
            ? h('a', { class: 'card', href: '#/g/' + g.id }, h('div', { class: 't' }, g.label), h('div', { class: 's' }, `${n}商品・最終更新 ${last ? md(last) + ' ' + hm(last) : '—'}`))
            : h('div', { class: 'card off' }, h('div', { class: 't' }, g.label), h('div', { class: 's' }, '準備中'));
        })),
      h('h2', null, '取扱の出現・消滅'),
      h('div', { class: 'grid' },
        h('a', { class: 'card', href: '#/feed' },
          h('div', { class: 't' }, '🆕✕ 取扱の出現・消滅'),
          h('div', { class: 's' }, `直近${DATA.eventDays}日で${DATA.feed.length}件`)),
        h('a', { class: 'card', href: 'guide.html' },
          h('div', { class: 't' }, '📮 郵送買取のながれと注意点'),
          h('div', { class: 's' }, '初めての人向けの説明ページ'))));
  }

  // ---------- 画面: 取扱の出現・消滅 ----------
  function viewFeed() {
    const feedRows = DATA.feed.map((f) =>
      h('div', { class: 'row' },
        h('span', { class: 'when' }, `${md(f.t)} ${hm(f.t)}`),
        h('span', { class: 'badge ' + (f.type === 'appear' ? 'new' : 'gone') }, f.type === 'appear' ? '🆕 出現' : '✕ 消滅'),
        byId[f.pid] ? h('a', { href: '#/p/' + f.pid }, f.name) : h('span', null, f.name),
        h('span', { class: 'muted' }, `${storeName(f.store)}・${gameLabel(f.game)}${f.price ? '・' + yen(f.price) : ''}`)));
    return h('div', null,
      h('div', { class: 'crumb' }, h('a', { href: '#/' }, 'ホーム'), ' › 取扱の出現・消滅'),
      h('h1', null, '取扱の出現・消滅'),
      h('p', { class: 'muted' }, '店が買取を始めた／やめたBOXを、直近30日ぶん新しい順に表示します。'),
      feedRows.length ? h('div', { class: 'feed' }, feedRows) : h('p', { class: 'empty' }, '直近30日の出現・消滅はありません。'));
  }

  // ---------- 画面: ゲームの価格表 ----------
  function viewGame(gameId) {
    const list = DATA.products.filter((p) => p.game === gameId);
    if (!list.length) return h('p', { class: 'empty' }, 'このゲームのデータはまだありません。');
    const allStores = orderedStores(DATA.stores.filter((s) => list.some((p) => p.cells.some((c) => c.store === s.id))));
    const hidden = new Set(filters.hiddenStores || []);
    const stores = allStores.filter((s) => !hidden.has(s.id));
    // BOX（状態の区別なし）はシュリンク付き／テープ付きと同じ扱いなので、状態フィルタには別枠で出さない
    const condsHere = COND_ORDER.filter((c) => c !== 'box' && list.some((p) => p.cells.some((x) => x.cond === c)));
    const saved = (filters.cond || {})[gameId];
    const condSel = condsHere.length ? (condsHere.includes(saved) ? saved : condsHere[0]) : null;
    const exactCond = condSel;
    // 区分（groupOrder）が設定されているゲームだけ、商品を区分ごとに見出しで分ける
    // （設定が無いゲームは区分に意味が無いので、見出しを出さず1つのリストにする）
    const gameCfg = DATA.games.find((x) => x.id === gameId);
    const groups = [];
    if (gameCfg && gameCfg.groupOrder) {
      for (const p of list) {
        const name = p.group || 'その他';
        let g = groups.find((x) => x.name === name);
        if (!g) groups.push((g = { name, items: [] }));
        g.items.push(p);
      }
    } else {
      groups.push({ name: null, items: list });
    }
    const thead = h('thead', null, h('tr', null,
      h('th', { class: 'name' }, '商品'),
      stores.map((s) => {
        const st = DATA.storeGame[`${s.id}|${gameId}`];
        // 壊れている（未確認）のとは別に、まだ「今日」の更新が来ていないだけの店を、見落とさないようバッジで強調する
        // （放置すると、買取店は機会損失、見る人は毎回手動で確認する手間になるため）
        const isToday = st && st.lastOkAt && st.lastOkAt.slice(0, 10) === DATA.today;
        const timeText = st && st.lastOkAt ? md(st.lastOkAt) + ' ' + hm(st.lastOkAt) : '未取得';
        // 途中で折り返さない（幅が足りない列は、バッジぶん表がその列だけ少し広がり、横スクロールで見る）
        const badge = !st || !st.lastOkAt ? null
          : !st.fresh ? h('span', { class: 'badge warn' }, '⚠ 未取得')
          : !isToday ? h('span', { class: 'badge notice' }, '本日未更新')
          : null;
        return h('th', { class: 'store' }, s.name,
          badge ? h('div', { style: 'margin-top:3px; text-align:center' }, badge) : null,
          h('small', { class: 'muted' }, timeText));
      })));
    const body = h('tbody');
    for (const g of groups) {
      if (g.name) body.append(h('tr', { class: 'group' }, h('td', { colspan: stores.length + 1 }, g.name)));
      for (const p of g.items) {
        const rowCells = stores.map((s) => summaryCell(p, s.id, exactCond));
        const isMax = markMax(rowCells);
        body.append(h('tr', null,
          h('th', { class: 'name', scope: 'row' }, h('div', { class: 'pname' },
            // 一覧には画像を出さない（スマホで幅を取りすぎるため。画像は商品ページに出す）
            h('div', null, h('a', { href: '#/p/' + p.id }, p.name),
              p.release ? h('div', { class: 'muted', style: 'font-size:11px' }, '発売 ' + p.release.replace(/-/g, '/')) : null))),
          rowCells.map((c, i) => cellNode(c, isMax[i]))));
      }
    }
    const newCount = list.filter((p) => p.cells.some((c) => c.event && c.event.type === 'appear')).length;
    const goneCount = list.filter((p) => p.cells.some((c) => c.event && c.event.type === 'disappear')).length;
    return h('div', null,
      h('div', { class: 'crumb' }, h('a', { href: '#/' }, 'ホーム'), ' › ', gameLabel(gameId)),
      h('div', { style: 'display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px' },
        h('h1', { style: 'margin:0' }, gameLabel(gameId) + ' 買取価格'),
        gameId === 'onepiece' ? h('a', { class: 'tag-link', href: 'flagship.html' }, '🎴 配布カード枚数データ') : null),
      h('div', { class: 'legend' },
        h('span', null, h('span', { class: 'badge new' }, '🆕 出現'), ` 直近${DATA.eventDays}日に買取開始（${newCount}件）`),
        h('span', null, h('span', { class: 'badge gone' }, '✕ 取扱終了'), ` 直近${DATA.eventDays}日に買取停止（${goneCount}件）`),
        h('span', null, '— 取扱なし　未確認 = 取得できていない　店名の下 = 最終更新')),
      filterBar(gameId, allStores, condsHere, condSel),
      stores.length ? h('div', { class: 'tablewrap' }, h('table', null, thead, body)) : h('p', { class: 'empty' }, '表示する店舗がありません。上の「店舗」フィルタで選んでください。'));
  }

  // ---------- 画面: 商品 ----------
  const prodCond = {}; // 商品ごとの、状態フィルタの選択（ページを開いている間だけ覚える）
  function viewProduct(pid) {
    const p = byId[pid];
    if (!p) return h('p', { class: 'empty' }, '商品が見つかりません。');
    const order = PRODUCT_COND_ORDER[pid] || COND_ORDER;
    const allConds = order.filter((c) => p.cells.some((x) => x.cond === c));
    // 状態のフィルタ（状態が2つ以上ある商品だけ）。選んだ状態の行・推移だけを出す。既定は「すべて」
    const sel = allConds.length > 1 && allConds.includes(prodCond[pid]) ? prodCond[pid] : 'all';
    const conds = sel === 'all' ? allConds : [sel];
    const stores = orderedStores(DATA.stores.filter((s) => p.cells.some((c) => c.store === s.id && conds.includes(c.cond))));
    const condBar = allConds.length > 1
      ? h('div', { class: 'filter-row', style: 'margin:12px 0' },
          h('span', { class: 'small muted' }, '状態:'),
          ['all', ...allConds].map((c) => h('button', { class: 'chip', type: 'button', 'aria-pressed': sel === c ? 'true' : 'false', onclick: () => { prodCond[pid] = c; render(true); } }, c === 'all' ? 'すべて' : condLabel(c))))
      : null;
    const table = h('div', { class: 'tablewrap', style: 'max-height:none' }, h('table', null,
      h('thead', null, h('tr', null, h('th', { class: 'name' }, '状態'), stores.map((s) => h('th', { class: 'store' }, s.name)))),
      h('tbody', null, conds.map((c) => {
        const rowCells = stores.map((s) => p.cells.find((x) => x.store === s.id && x.cond === c));
        const isMax = markMax(rowCells);
        return h('tr', null, h('th', { class: 'name', scope: 'row' }, condLabel(c)), rowCells.map((cell, i) => cellNode(cell, isMax[i])));
      }))));
    const blocks = conds.map((c) => {
      const st = p.stats[c];
      const multi = st.nowN > 1;
      const rows = DATA.periods.map((d) => {
        const r = st.periods[d];
        return h('tr', null, h('td', { style: 'text-align:left' }, PERIOD_LABEL[d]),
          r ? h('td', { class: cls(r.diff) }, arrow(r.diff) + ' ' + signed(r.diff)) : h('td', { class: 'muted' }, 'データなし'),
          r ? h('td', { class: cls(r.pct) }, pctText(r.pct)) : h('td', { class: 'muted' }, '—'),
          h('td', { class: 'muted' }, r ? `${md(r.baseDate)} ${yen(r.base)}${r.baseN > 1 ? `（${r.baseN}店舗平均）` : ''}` : ''));
      });
      return h('div', null,
        h('h2', null, `${condLabel(c)} の推移`),
        st.now != null
          ? h('p', null, h('strong', null, yen(st.now)), h('span', { class: 'muted' }, ` （${md(st.nowDate)} 時点${multi ? `・${st.nowN}店舗平均` : ''}）`))
          : h('p', { class: 'muted' }, '現在、金額のついている店舗はありません。'),
        h('div', { class: 'panel' }, chart(p.series[c], (pt) => '')),
        h('div', { class: 'panel', style: 'margin-top:10px' }, h('table', null,
          h('thead', null, h('tr', null, ['期間', '差額', '変化率', '基準（比較元）'].map((t, i) => h('th', { style: i === 0 ? 'text-align:left' : '' }, t)))),
          h('tbody', null, rows))));
    });
    const restockBlock = p.restocks.length
      ? h('div', { class: 'restock' },
          h('div', { class: 't' }, '再販日（若干の前後あり）'),
          h('ul', { class: 'restock-list' }, p.restocks.map((d) => h('li', null, d.replace(/-/g, '/')))))
      : null;
    const restockNote = p.restocks.length
      ? h('div', { class: 'muted', style: 'font-size:11px;margin:0 0 16px' }, '再販日はカードショップや家電量販店の納品日を示しています。コンビニ各社の納品日とは一致しません。')
      : null;
    return h('div', null,
      h('div', { class: 'crumb' }, h('a', { href: '#/' }, 'ホーム'), ' › ', h('a', { href: '#/g/' + p.game }, gameLabel(p.game)), ' › ', p.name),
      h('div', { class: 'hero' }, p.image ? h('img', { src: p.image, alt: '' }) : null,
        h('div', { class: 'info' }, h('h1', null, p.name), h('div', { class: 'muted' }, p.group + (p.release ? '　発売 ' + p.release.replace(/-/g, '/') : '')))),
      restockBlock,
      restockNote,
      condBar, table, blocks);
  }

  // ---------- 画面: 値動きランキング ----------
  let rankState = { period: 7, game: 'all' };
  function viewRanking() {
    const rows = [];
    for (const p of DATA.products) {
      if (rankState.game !== 'all' && p.game !== rankState.game) continue;
      for (const c of Object.keys(p.stats)) {
        const st = p.stats[c];
        const r = st.periods[rankState.period];
        if (r && r.diff !== 0 && st.current) rows.push({ p, c, now: r.now, n: r.baseN, r });
      }
    }
    rows.sort((a, b) => Math.abs(b.r.pct) - Math.abs(a.r.pct));
    const chip = (label, active, fn) => h('button', { class: 'chip', type: 'button', 'aria-pressed': active ? 'true' : 'false', onclick: fn }, label);
    const rerender = () => render(true);
    const games = [...new Set(DATA.products.map((p) => p.game))];
    return h('div', null,
      h('h1', null, '値動きランキング'),
      h('p', { class: 'muted' }, '全商品のうち、期間内で価格が大きく動いたものを表示します（比較元と現在の両方に金額がある店舗どうしで、同じ顔ぶれの平均を比べています）。'),
      h('div', { class: 'chips' }, DATA.periods.map((d) => chip(PERIOD_LABEL[d], rankState.period === d, () => { rankState.period = d; rerender(); }))),
      h('div', { class: 'chips' }, [chip('全ゲーム', rankState.game === 'all', () => { rankState.game = 'all'; rerender(); }),
        games.map((g) => chip(gameLabel(g), rankState.game === g, () => { rankState.game = g; rerender(); }))]),
      rows.length
        ? h('div', { class: 'tablewrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', { class: 'name' }, '商品'), h('th', null, '現在'), h('th', null, '差額'), h('th', null, '変化率'))),
            h('tbody', null, rows.slice(0, 50).map((x) => h('tr', null,
              h('th', { class: 'name', scope: 'row' }, h('div', { class: 'pname' },
                h('div', null, h('a', { href: '#/p/' + x.p.id }, x.p.name), h('div', { class: 'muted', style: 'font-size:11px' }, gameLabel(x.p.game) + (x.c !== 'box' ? '・' + condLabel(x.c) : ''))))),
              h('td', null, yen(x.now), x.n > 1 ? h('small', null, x.n + '店舗平均') : null),
              h('td', { class: cls(x.r.diff) }, arrow(x.r.diff) + ' ' + signed(x.r.diff)),
              h('td', { class: cls(x.r.pct) }, pctText(x.r.pct)))))))
        : h('p', { class: 'empty' }, `${PERIOD_LABEL[rankState.period]}前と比べて価格が動いた商品はありません（比較できるデータがまだ少ない場合もあります）。`));
  }

  // 表が横スクロールできるとき、続きがあることに気づけるよう端に影を出す（.tablewrap に scroll-l/scroll-r を付け外し）
  function updateTableScrollShadow() {
    app.querySelectorAll('.tablewrap').forEach((wrap) => {
      const max = wrap.scrollWidth - wrap.clientWidth;
      wrap.classList.toggle('scroll-l', wrap.scrollLeft > 1);
      wrap.classList.toggle('scroll-r', wrap.scrollLeft < max - 1);
    });
  }
  window.addEventListener('resize', updateTableScrollShadow);

  // ---------- ルーター ----------
  // preserveScroll: フィルタの切り替えなど、画面は同じままの再描画で使う（ページ移動のときは常に先頭へ）
  function render(preserveScroll) {
    if (!DATA) return;
    const y = window.scrollY;
    // 価格表（.tablewrap）は中で縦スクロールする作りなので、ページとは別にこちらの位置も保つ
    const tableScroll = preserveScroll ? app.querySelector('.tablewrap')?.scrollTop : 0;
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    let view;
    if (parts[0] === 'g' && parts[1]) view = viewGame(decodeURIComponent(parts[1]));
    else if (parts[0] === 'p' && parts[1]) view = viewProduct(decodeURIComponent(parts[1]));
    else if (parts[0] === 'ranking') view = viewRanking();
    else if (parts[0] === 'feed') view = viewFeed();
    else view = viewHome();
    app.replaceChildren(view);
    app.querySelectorAll('.tablewrap').forEach((wrap) => wrap.addEventListener('scroll', updateTableScrollShadow, { passive: true }));
    updateTableScrollShadow();
    document.title = 'トレカBOX価格トラッカー';
    if (parts[0] === 'p' && byId[parts[1]]) document.title = byId[parts[1]].name + ' | トレカBOX価格トラッカー';
    if (preserveScroll) {
      window.scrollTo(0, y);
      if (tableScroll) {
        const wrap = app.querySelector('.tablewrap');
        if (wrap) wrap.scrollTop = tableScroll;
      }
    } else {
      // ページの移動: 以前そのページを見ていた（＝「戻る」で帰ってきた）ならその高さへ、初めて見るページなら先頭へ
      const mem = scrollMemory.get(location.hash);
      window.scrollTo(0, mem ? mem.y : 0);
      const wrap = mem && mem.table ? app.querySelector('.tablewrap') : null;
      if (wrap) wrap.scrollTop = mem.table;
    }
  }

  async function init() {
    try {
      const res = await fetch('data/box.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      DATA = await res.json();
    } catch (e) {
      app.replaceChildren(h('p', { class: 'pad' }, 'データを読み込めませんでした。時間をおいて再読み込みしてください。（' + e.message + '）'));
      return;
    }
    byId = Object.fromEntries(DATA.products.map((p) => [p.id, p]));
    document.getElementById('updated').textContent = `データ生成: ${DATA.generatedAt.slice(0, 16).replace('T', ' ')}（日本時間）`;
    window.addEventListener('hashchange', (e) => {
      // 離れるページのスクロール位置を、そのページのハッシュに結びつけて覚えておく（「戻る」で使う）
      try {
        const oldHash = new URL(e.oldURL).hash || '#/';
        scrollMemory.set(oldHash, { y: window.scrollY, table: app.querySelector('.tablewrap')?.scrollTop || 0 });
      } catch {}
      render();
    });
    render();
  }
  init();
})();
