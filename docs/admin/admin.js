// 管理画面。保留（要確認）の項目を「正しい／修正／据え置き」で判断し、
// 判断を data/box/decisions.json に書き込む（GitHub API 経由）。次の更新の最初に自動で反映される。
(function () {
  'use strict';
  const app = document.getElementById('app');

  // ---------- ブラウザ内の保存（使えない環境でも動くように try/catch）----------
  const mem = {};
  const kv = {
    get(k) { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { mem[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch { delete mem[k]; } },
  };
  const API = kv.get('admin.api') || 'https://api.github.com'; // テスト用の差し替え（同じサイト内からしか設定できない）
  const guessRepo = () => {
    const m = location.hostname.match(/^(.+)\.github\.io$/);
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return m && seg ? `${m[1]}/${seg}` : 'po-one-tcg/card-price-tracker';
  };
  const REPO = kv.get('admin.repo') || guessRepo();
  const BRANCH = 'main';
  const DECISIONS_PATH = 'data/box/decisions.json';

  let token = kv.get('admin.token') || '';
  let pending = null; // { generatedAt, pending: [...] }
  let decisions = null; // { decisions: [...] } | null（未接続）
  let statusMsg = null; // { kind: 'ok'|'err'|'info', text }
  let busy = false;

  // ---------- 部品 ----------
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
  const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
  const md = (s) => `${+s.slice(5, 7)}/${+s.slice(8, 10)} ${s.slice(11, 16)}`;
  const jstStamp = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19) + '+09:00';
  const b64enc = (s) => {
    let bin = '';
    new TextEncoder().encode(s).forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  };
  const b64dec = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

  // ---------- GitHub API ----------
  async function gh(path, { method = 'GET', body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.message || 'HTTP ' + res.status);
      e.status = res.status;
      throw e;
    }
    return data;
  }
  function explain(e) {
    if (e.status === 401) return 'トークンが正しくないか、期限が切れています。新しく作り直して貼り付けてください。';
    if (e.status === 403 || e.status === 404) return `権限が足りないか、リポジトリ（${REPO}）が見つかりません。トークンの権限（Contents と Actions を「Read and write」）と、対象リポジトリの選択を確認してください。（${e.message}）`;
    return e.message;
  }

  async function readDecisions() {
    try {
      const f = await gh(`/repos/${REPO}/contents/${DECISIONS_PATH}?ref=${BRANCH}`);
      return { data: JSON.parse(b64dec(f.content)), sha: f.sha };
    } catch (e) {
      if (e.status === 404) return { data: { decisions: [] }, sha: null };
      throw e;
    }
  }
  async function addDecision(decision) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data, sha } = await readDecisions();
      data.decisions.push(decision);
      try {
        await gh(`/repos/${REPO}/contents/${DECISIONS_PATH}`, {
          method: 'PUT',
          body: { message: `管理画面: 判断を記録 (${decision.action})`, content: b64enc(JSON.stringify(data, null, 1) + '\n'), sha: sha || undefined, branch: BRANCH },
        });
        return data;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 3) continue; // 自動更新と同時になったので読み直す
        throw e;
      }
    }
  }

  // ---------- 動作 ----------
  function say(kind, text) {
    statusMsg = { kind, text };
    render();
  }
  async function run(label, fn) {
    if (busy) return;
    busy = true;
    say('info', label + ' …');
    try {
      await fn();
    } catch (e) {
      say('err', explain(e));
    } finally {
      busy = false;
      render();
    }
  }
  const connect = (value) =>
    run('接続を確認しています', async () => {
      token = value.trim();
      if (!token) throw new Error('トークンを貼り付けてください');
      await gh(`/repos/${REPO}`);
      const r = await readDecisions();
      kv.set('admin.token', token);
      decisions = r.data;
      say('ok', `接続できました（${REPO}）`);
    });
  const disconnect = () => {
    kv.del('admin.token');
    token = '';
    decisions = null;
    say('info', 'このブラウザからトークンを削除しました');
  };
  const decide = (item, action, price) =>
    run('判断を保存しています', async () => {
      const d = { id: String(Date.now()), key: item.key, action, at: jstStamp() };
      if (action === 'set') {
        if (!(price > 0)) throw new Error('修正後の価格を数字で入力してください');
        d.price = price;
      }
      decisions = await addDecision(d);
      say('ok', `保存しました: ${item.name}。次の更新の最初に反映されます（すぐ反映するには下の「今すぐ更新」）。`);
    });
  const runNow = () =>
    run('更新を開始しています', async () => {
      await gh(`/repos/${REPO}/actions/workflows/scrape.yml/dispatches`, { method: 'POST', body: { ref: BRANCH } });
      say('ok', '更新を開始しました。1〜3分後に公開ページに反映されます。');
    });

  // ---------- 画面 ----------
  const ACTION_LABEL = { approve: '正しい', set: '修正して反映', dismiss: '前の価格のまま' };

  function connectionCard() {
    if (token && decisions) {
      return h('section', { class: 'box' },
        h('div', { class: 'row-between' }, h('span', null, '✅ 接続中', h('span', { class: 'muted' }, `（${REPO}）`)),
          h('button', { class: 'btn', type: 'button', onclick: disconnect }, 'トークンを削除')));
    }
    const input = h('input', { type: 'password', class: 'field', placeholder: 'github_pat_ で始まる文字列', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'GitHubトークン' });
    return h('section', { class: 'box' },
      h('h2', { style: 'margin-top:0' }, '① GitHubトークンを登録する（最初の1回だけ）'),
      h('ol', { class: 'steps' },
        h('li', null, h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'トークン作成ページ'), ' を開く（リポジトリの持ち主のアカウントでログインしておく）'),
        h('li', null, '名前は何でもOK（例: ', h('code', null, 'BOX管理画面'), '）、有効期限は ', h('b', null, '90日'), ' にする（切れたらまた作り直す）'),
        h('li', null, h('b', null, 'Repository access'), ' → ', h('b', null, 'Only select repositories'), ' → ', h('code', null, 'card-price-tracker'), ' だけを選ぶ'),
        h('li', null, h('b', null, 'Permissions'), ' → ', h('b', null, 'Repository permissions'), ' を開き、', h('b', null, 'Contents'), ' と ', h('b', null, 'Actions'), ' を ', h('b', null, 'Read and write'), ' にする'),
        h('li', null, '一番下の ', h('b', null, 'Generate token'), ' を押し、表示された ', h('code', null, 'github_pat_…'), ' をコピーする（この画面を閉じると二度と見られません）'),
        h('li', null, '下の欄に貼り付けて「保存して接続」')),
      h('div', { class: 'row-gap' }, input,
        h('button', { class: 'btn primary', type: 'button', onclick: () => connect(input.value) }, '保存して接続')),
      h('p', { class: 'muted small' }, '※ トークンはこのブラウザの中にだけ保存され、リポジトリには入りません。自分専用のパソコン・スマホでだけ使ってください。'));
  }

  function pendingList() {
    const list = pending ? pending.pending : [];
    const waiting = new Map((decisions?.decisions || []).filter((d) => !d.appliedAt).map((d) => [d.key, d]));
    const head = h('h2', null, '④ 要確認リスト', h('span', { class: 'muted small' }, pending ? `　（${md(pending.generatedAt)} 時点）` : ''));
    if (!pending) return h('section', null, head, h('p', { class: 'empty' }, '要確認リストを読み込めませんでした。'));
    if (!list.length) return h('section', null, head, h('p', { class: 'empty' }, '確認が必要な項目はありません 🎉'));
    return h('section', null, head,
      h('p', { class: 'muted small' }, '前回から大きく（±50%超）変わった価格は、ここで確認するまで公開ページには反映されません。'),
      list.map((it) => {
        const w = waiting.get(it.key);
        const pct = ((it.price - it.prevPrice) / it.prevPrice) * 100;
        const priceInput = h('input', { type: 'number', min: '1', inputmode: 'numeric', class: 'field short', placeholder: '正しい価格（円）', 'aria-label': '修正後の価格' });
        return h('div', { class: 'item' },
          h('div', { class: 'item-title' }, it.name || it.pid, h('span', { class: 'muted small' }, `　${it.store}`)),
          h('div', { class: 'item-price' }, yen(it.prevPrice), ' → ', h('b', null, yen(it.price)), h('span', { class: pct > 0 ? 'up' : 'down' }, `　${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(0)}%`)),
          w
            ? h('div', { class: 'badge warn' }, `判断済み（${ACTION_LABEL[w.action]}${w.price ? ' ' + yen(w.price) : ''}）— 次の更新で反映されます`)
            : h('div', { class: 'actions' },
                h('button', { class: 'btn primary', type: 'button', disabled: !decisions || busy, onclick: () => decide(it, 'approve') }, `正しい（${yen(it.price)}で反映）`),
                h('span', { class: 'row-gap' }, priceInput,
                  h('button', { class: 'btn', type: 'button', disabled: !decisions || busy, onclick: () => decide(it, 'set', Number(priceInput.value)) }, '間違い → この価格に修正')),
                h('button', { class: 'btn', type: 'button', disabled: !decisions || busy, onclick: () => decide(it, 'dismiss') }, `間違い → ${yen(it.prevPrice)}のまま`)));
      }));
  }

  function runCard() {
    return h('section', { class: 'box' },
      h('h2', { style: 'margin-top:0' }, '⑤ 今すぐ更新'),
      h('p', { class: 'muted small' }, '判断を保存したあと、次の自動更新（13:00 / 15:00 / 18:00）を待たずにすぐ反映したいときに押します。'),
      h('button', { class: 'btn primary', type: 'button', disabled: !decisions || busy, onclick: runNow }, '今すぐ更新を実行'));
  }

  function historyList() {
    const list = (decisions?.decisions || []).slice(-8).reverse();
    if (!list.length) return null;
    return h('section', null, h('h2', null, '最近の判断'),
      h('div', { class: 'feed' }, list.map((d) =>
        h('div', { class: 'row' }, h('span', { class: 'when' }, md(d.at)),
          h('span', { class: 'badge ' + (d.appliedAt ? 'new' : 'warn') }, d.appliedAt ? (d.error ? '反映できず' : '反映済み') : '反映待ち'),
          h('span', null, ACTION_LABEL[d.action] || d.action, d.price ? ' ' + yen(d.price) : ''),
          h('span', { class: 'muted small' }, d.key.split('|')[1] || '')))));
  }

  // ---------- 買取EXPOの取り込み ----------
  const EP = window.ExpoParser;
  let manual = null; // ../data/manual.json（区分の設定と、いまの内容）
  let expoText = '';
  let plan = null; // 読み取り結果 + 確定前の予測
  let headingMap = {}; // 未対応の見出し → 選んだ区分ID
  let sendAfter = true; // 取り込み後にすぐ更新を実行する
  let inboxCount = null; // 取り込み待ち（まだ収集に反映されていない送信）の数

  // 手入力の店舗（買取EXPO・買取コレクトなど）。見出し（✅…）は店舗をまたいで一意なので、貼り付けた内容から店舗も自動で判別する
  const manualStores = () => (manual ? manual.stores : []);
  const autoStores = () => (manual ? manual.autoStores || [] : []);
  const storeOf = (id) => manualStores().find((s) => s.id === id) || autoStores().find((s) => s.id === id);
  const allSections = () => manualStores().flatMap((s) => s.sections.map((sec) => ({ ...sec, storeId: s.id, storeName: s.name })));
  const activeSections = () => allSections().filter((s) => s.kind !== 'skip' && s.kind !== 'update'); // 入力状況・区分選択の対象
  const condName = (id) => (manual.conditions.find((c) => c.id === id) || { label: id }).label;
  const gameName = (id) => (manual.games.find((g) => g.id === id) || { label: id }).label;

  // 貼り付けた内容を読み取り、「確定したらどうなるか」を今のデータと突き合わせて予測する（収集側と同じ判定）
  function buildPlan() {
    const sections = allSections().map((s) => ({
      ...s,
      headings: [...(s.headings || []), ...Object.entries(headingMap).filter(([, id]) => id === s.id).map(([hd]) => hd)],
    }));
    const updateStore = manualStores().find((s) => s.updatePosts) || manualStores()[0]; // 「価格を変更します」形式のお知らせの持ち主
    const parsed = EP.parse(expoText, sections);
    const resolve = EP.makeResolver(manual.aliases); // 同じ商品の別表記（テラスタルフェス = テラスタルフェスex など）
    const index = new Map();
    for (const p of manual.products) if (!index.has(`${p.game}|${resolve(p.game, p.name)}`)) index.set(`${p.game}|${resolve(p.game, p.name)}`, p.id);
    const threshold = manual.thresholdPct ?? 50;
    const anomalous = (a, b) => !(b > 0) || (Math.abs(b - a) / a) * 100 > threshold;

    // 同じ貼り付けの中の「全商品リスト」は、価格変更より先に取り込まれる。価格変更の照合には、それも含めて見る
    const pastedEntries = parsed.blocks
      .filter((b) => b.kind === 'full' && b.section && !b.skipped && !b.unknown)
      .flatMap((b) => b.items.map((it) => ({ store: b.section.storeId, game: it.game, cond: it.cond, name: it.name, price: it.price, state: it.closed ? 'none' : 'value' })));

    const blocks = parsed.blocks.map((b) => {
      const out = { ...b, storeId: b.section ? b.section.storeId : b.unknown ? null : updateStore.id, appear: [], disappear: [], anomaly: [], unmatched: [], matched: 0, created: 0, absent: [], prevCount: 0, tooFew: false, confirmedDrop: false };
      if (b.skipped || b.unknown) return out;
      if (b.kind === 'update') {
        for (const it of b.items) {
          const cands = [...pastedEntries, ...manual.entries].filter((e) => e.store === out.storeId && resolve(e.game, e.name || '') === resolve(e.game, it.name) && (!it.cond || e.cond === it.cond));
          const pick = cands.find((e) => e.cond === 'shrink') || cands.find((e) => e.cond === 'box') || cands[0];
          if (!pick) { out.unmatched.push(it.name); continue; }
          it.matchedCond = pick.cond;
          it.from = pick.price;
          if (pick.state === 'value' && anomalous(pick.price, it.price)) out.anomaly.push({ ...it });
          out.matched++;
        }
        return out;
      }
      const sec = b.section;
      const prev = manual.entries.filter((e) => e.store === sec.storeId && e.src === sec.id);
      const prevMap = new Map(prev.map((e) => [`${e.pid}|${e.cond}`, e]));
      const baseline = Boolean(sec.lastOkAt);
      const touched = new Set();
      for (const it of b.items) {
        const pid = index.get(`${it.game}|${resolve(it.game, it.name)}`);
        if (pid) out.matched++; else out.created++;
        const pe = pid ? prevMap.get(`${pid}|${it.cond}`) : null;
        if (pe) touched.add(`${pid}|${it.cond}`);
        if (!pe) { if (baseline && !it.closed) out.appear.push(it); }
        else if (it.closed) { if (pe.state === 'value') out.disappear.push({ ...it, from: pe.price }); }
        else if (pe.state !== 'value') out.appear.push(it);
        else if (pe.price !== it.price && anomalous(pe.price, it.price)) out.anomaly.push({ ...it, from: pe.price });
      }
      out.absent = prev.filter((e) => !touched.has(`${e.pid}|${e.cond}`));
      for (const e of out.absent) if (e.state === 'value') out.disappear.push({ name: e.name, cond: e.cond, from: e.price, absent: true });
      out.prevCount = prev.length;
      out.tooFew = prev.length >= 10 && b.items.length < prev.length * 0.6;
      return out;
    });
    return { blocks, dateGuess: parsed.dateGuess };
  }

  const newId = () => Math.random().toString(36).slice(2, 8);
  const inboxPath = (type) => `data/box/manual/inbox/${jstStamp().replace(/[-:T+]/g, '').slice(0, 14)}-${type}-${newId()}.json`;
  async function putNewFile(path, obj, message) {
    await gh(`/repos/${REPO}/contents/${path}`, { method: 'PUT', body: { message, content: b64enc(JSON.stringify(obj) + '\n'), branch: BRANCH } });
  }
  async function refreshInbox() {
    try {
      const list = await gh(`/repos/${REPO}/contents/data/box/manual/inbox?ref=${BRANCH}`);
      inboxCount = Array.isArray(list) ? list.filter((f) => f.name.endsWith('.json')).length : 0;
    } catch (e) {
      inboxCount = e.status === 404 ? 0 : null;
    }
  }

  const sendable = () => plan.blocks.filter((b) => b.kind === 'full' && !b.unknown && !b.skipped && b.items.length && !(b.tooFew && !b.confirmedDrop));
  const updatable = () => plan.blocks.filter((b) => b.kind === 'update' && b.items.length);

  const submitManual = () =>
    run('取り込みデータを送信しています', async () => {
      const subs = [];
      // 店舗ごとに、全商品リスト(full) と 価格変更(update) を別々のファイルにする（fullを先に処理するため）
      for (const sid of [...new Set([...sendable(), ...updatable()].map((b) => b.storeId))]) {
        const base = { store: sid, createdAt: jstStamp(), rawText: expoText };
        const fulls = sendable().filter((b) => b.storeId === sid);
        const ups = updatable().filter((b) => b.storeId === sid);
        if (fulls.length) {
          subs.push({ ...base, id: newId(), type: 'full',
            blocks: fulls.map((b) => ({ sectionId: b.sectionId, ...(b.tooFew ? { confirmedDrop: true } : {}), items: b.items.map(({ name, cond, price, closed, game }) => ({ name, cond, price, closed, game })) })) });
        }
        if (ups.length) subs.push({ ...base, id: newId(), type: 'update', blocks: ups.map((b) => ({ items: b.items.map(({ name, cond, price }) => ({ name, cond, price })) })) });
      }
      if (!subs.length) throw new Error('取り込める内容がありません');
      for (const s of subs) await putNewFile(inboxPath(s.type), s, `管理画面: ${storeOf(s.store).name}の取り込みデータ (${s.type})`);
      if (sendAfter) await gh(`/repos/${REPO}/actions/workflows/scrape.yml/dispatches`, { method: 'POST', body: { ref: BRANCH } });
      expoText = '';
      plan = null;
      await refreshInbox();
      say('ok', sendAfter ? '送信しました。更新を開始したので、1〜3分後に公開ページに反映されます。' : '送信しました。次の自動更新（13:00 / 15:00 / 18:00）で反映されます。');
    });

  const pauseStore = (sid) => {
    const name = storeOf(sid).name;
    if (!window.confirm(`${name}を「本日休止」にします。\n全商品が「休止」表示になります（出現・消滅にはカウントされません）。よろしいですか？`)) return;
    run('休止を送信しています', async () => {
      await putNewFile(inboxPath('paused'), { id: newId(), store: sid, type: 'paused', createdAt: jstStamp() }, `管理画面: ${name} 本日休止`);
      if (sendAfter) await gh(`/repos/${REPO}/actions/workflows/scrape.yml/dispatches`, { method: 'POST', body: { ref: BRANCH } });
      await refreshInbox();
      say('ok', '「本日休止」を送信しました。' + (sendAfter ? '1〜3分後に反映されます。' : '次の更新で反映されます。'));
    });
  };

  // 自動取得の店舗: サイトが休業日で更新が無いとき、「取得できていない」のか「店が休み」なのかを区別して記録する
  function autoStoresCard() {
    if (!autoStores().length) return null;
    const canWrite = Boolean(token && decisions);
    return h('section', { class: 'box' },
      h('h2', { style: 'margin-top:0' }, '③ 自動取得の店舗が休業日のとき'),
      h('p', { class: 'muted small' }, '更新が無いのが、取得できていないからか、店が休みだからかを区別するための記録です（休みの実績は「いつが休み」かを日付つきで公開ページに表示します）。'),
      autoStores().map((st) => h('div', { class: 'store-row' },
        h('span', { class: 'store-name' }, st.name),
        h('div', { class: 'chips-row' }, st.games.map((g) => {
          const ok = g.lastOkAt && g.fresh;
          return h('span', { class: 'badge ' + (ok ? 'new' : 'warn'), title: g.lastOkAt ? `最終更新 ${md(g.lastOkAt)}` : 'まだ取得できていません' }, (ok ? '✅ ' : '⚠ ') + gameName(g.game));
        })),
        h('button', { class: 'btn', type: 'button', disabled: busy || !canWrite, onclick: () => pauseStore(st.id) }, `${st.name} 本日休止`))));
  }

  // 店舗ごとに、各区分の入力状況（✅ = 最新 / ⚠ = 未入力・古い）を並べる
  function inputChecklist() {
    return manualStores().map((st) => {
      const secs = activeSections().filter((s) => s.storeId === st.id);
      return h('div', { class: 'store-row' }, h('span', { class: 'store-name' }, st.name),
        h('div', { class: 'chips-row' }, secs.map((s) => {
          const ok = s.lastOkAt && s.fresh;
          return h('span', { class: 'badge ' + (ok ? 'new' : 'warn'), title: s.lastOkAt ? `最終更新 ${md(s.lastOkAt)}` : 'まだ一度も入力されていません' }, (ok ? '✅ ' : '⚠ ') + s.label);
        })));
    });
  }

  function eventList(label, cls, items, fmt) {
    if (!items.length) return null;
    return h('details', { class: 'ev' }, h('summary', null, h('span', { class: 'badge ' + cls }, label), ` ${items.length}件`),
      h('ul', null, items.slice(0, 40).map((it) => h('li', null, fmt(it))), items.length > 40 ? h('li', { class: 'muted' }, `…ほか ${items.length - 40}件`) : null));
  }

  function blockView(b, i) {
    const head = h('div', { class: 'item-title' }, '✅ ' + b.heading,
      b.section ? h('span', { class: 'muted small' }, `　→ ${b.section.storeName} / ${b.section.label}`) : b.storeId ? h('span', { class: 'muted small' }, `　→ ${storeOf(b.storeId).name}`) : null);
    if (b.unknown) {
      const sel = h('select', { class: 'field short', 'aria-label': '取り込む区分', onchange: (e) => { if (e.target.value) { headingMap[b.heading] = e.target.value; plan = buildPlan(); render(); } } },
        h('option', { value: '' }, '区分を選ぶ…'), activeSections().map((s) => h('option', { value: s.id }, `${s.storeName} / ${s.label}`)));
      return h('div', { class: 'item' }, head, h('div', { class: 'badge warn' }, '見出しを認識できませんでした（この区分は送信されません）'), h('div', { class: 'row-gap' }, h('span', { class: 'small' }, '当てはまる区分:'), sel));
    }
    if (b.skipped) return h('div', { class: 'item' }, head, h('div', { class: 'muted small' }, 'この区分はBOXの価格ではない（レート表など）ため、取り込みません。'));
    if (b.kind === 'update') {
      return h('div', { class: 'item' }, head,
        h('table', { class: 'mini' }, h('tbody', null, b.items.map((it) => h('tr', null,
          h('td', null, it.name, it.matchedCond ? h('span', { class: 'muted small' }, `（${condName(it.matchedCond)}）`) : null),
          h('td', null, it.from != null ? `${yen(it.from)} → ` : '', h('b', null, yen(it.price))),
          h('td', null, b.unmatched.includes(it.name) ? h('span', { class: 'badge warn' }, '該当する商品なし（反映されません）') : null))))),
        eventList('⚠ 要確認になる', 'warn', b.anomaly, (it) => `${it.name} ${yen(it.from)} → ${yen(it.price)}`));
    }
    const priced = b.items.filter((x) => !x.closed).length;
    return h('div', { class: 'item' }, head,
      h('div', { class: 'small' }, `${b.items.length}件（価格あり ${priced} / 〆切 ${b.items.length - priced}）　既存の商品と一致 ${b.matched} / 新規 ${b.created}`),
      b.tooFew ? h('div', { class: 'status err' }, `⚠ 前回は ${b.prevCount}件でしたが、今回は ${b.items.length}件しかありません。貼り忘れの可能性があります（このまま取り込むと、載っていない商品は「消滅」になります）。`,
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: b.confirmedDrop ? true : null, onchange: (e) => { b.confirmedDrop = e.target.checked; render(); } }), ' 貼り忘れではない。このまま取り込む')) : null,
      eventList('🆕 出現', 'new', b.appear, (it) => `${it.name}（${condName(it.cond)}）${yen(it.price)}`),
      eventList('✕ 消滅', 'gone', b.disappear, (it) => `${it.name}（${condName(it.cond)}）直前 ${yen(it.from)}${it.absent ? ' ※今回のポストに載っていない' : ''}`),
      eventList('⚠ 要確認になる', 'warn', b.anomaly, (it) => `${it.name}（${condName(it.cond)}）${yen(it.from)} → ${yen(it.price)}`),
      b.ignored.length ? h('details', { class: 'ev' }, h('summary', { class: 'muted small' }, `読み飛ばした行 ${b.ignored.length}件`), h('ul', null, b.ignored.map((l) => h('li', { class: 'muted small' }, l)))) : null,
      b.warnings.length ? h('div', { class: 'badge warn' }, b.warnings.join(' / ')) : null);
  }

  function planView() {
    const okFull = sendable().length, okUp = updatable().length;
    return h('div', null,
      h('h3', { class: 'sub' }, '読み取り結果（確認してから確定します）'),
      plan.blocks.length ? plan.blocks.map(blockView) : h('p', { class: 'empty' }, '「✅」で始まる見出し、または価格変更のお知らせが見つかりませんでした。'),
      h('div', { class: 'row-gap', style: 'margin-top:8px' },
        h('button', { class: 'btn primary', type: 'button', disabled: busy || !(okFull || okUp), onclick: submitManual }, `この内容で確定して取り込む（${okFull + okUp}件のポスト分）`),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: sendAfter ? true : null, onchange: (e) => { sendAfter = e.target.checked; } }), ' 取り込み後すぐ更新を実行する')));
  }

  function manualCard() {
    if (!manualStores().length) return h('section', { class: 'box' }, h('h2', { style: 'margin-top:0' }, '② 手入力店舗の入力'), h('p', { class: 'muted' }, '取り込みの設定を読み込めませんでした。'));
    const ta = h('textarea', { class: 'field area', rows: '7', placeholder: 'ここにポスト（買取EXPO）や、書き起こした価格表（買取コレクト）を貼り付け。複数の店舗・複数のポストをまとめて貼ってOK', 'aria-label': '取り込む内容', spellcheck: 'false' });
    ta.value = expoText;
    ta.addEventListener('input', () => { expoText = ta.value; });
    const canWrite = Boolean(token && decisions);
    return h('section', { class: 'box' },
      h('h2', { style: 'margin-top:0' }, '② 手入力店舗の入力（買取EXPO・買取コレクト）'),
      h('p', { class: 'muted small' }, '各区分の最新の入力状況（⚠ は未入力・古い区分。入力しないまま時間がたつと、公開ページでは「未確認」になります）'),
      inputChecklist(),
      inboxCount ? h('p', { class: 'small' }, `📥 取り込み待ち ${inboxCount}件（次の更新で反映されます）`) : null,
      ta,
      h('div', { class: 'row-gap' },
        h('button', { class: 'btn primary', type: 'button', disabled: busy, onclick: () => { expoText = ta.value; plan = buildPlan(); render(); } }, '読み取る'),
        h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => { expoText = ''; plan = null; render(); } }, 'クリア'),
        canWrite ? null : h('span', { class: 'muted small' }, '※ 確定するには、先に上の「GitHubトークン」を登録してください')),
      plan ? planView() : null,
      h('hr', { class: 'sep' }),
      h('div', { class: 'row-gap' },
        h('span', { class: 'small' }, '店が休止のとき: '),
        manualStores().map((st) => h('button', { class: 'btn', type: 'button', disabled: busy || !canWrite, onclick: () => pauseStore(st.id) }, `${st.name} 本日休止`))));
  }

  function render() {
    const y = window.scrollY;
    app.replaceChildren(
      ...[
        h('h1', null, '管理画面'),
        statusMsg ? h('div', { class: 'status ' + statusMsg.kind, role: 'status' }, statusMsg.text) : null,
        connectionCard(),
        manual ? manualCard() : null,
        manual ? autoStoresCard() : null,
        pendingList(),
        token && decisions ? runCard() : null,
        historyList(),
      ].filter(Boolean));
    window.scrollTo(0, y);
  }

  async function init() {
    try {
      const res = await fetch('../data/pending.json', { cache: 'no-store' });
      pending = res.ok ? await res.json() : null;
    } catch { pending = null; }
    try {
      const res = await fetch('../data/manual.json', { cache: 'no-store' });
      manual = res.ok ? await res.json() : null;
    } catch { manual = null; }
    render();
    if (token) {
      try {
        decisions = (await readDecisions()).data;
        await refreshInbox();
      } catch (e) {
        statusMsg = { kind: 'err', text: explain(e) };
      }
      render();
    }
  }
  init();
})();
