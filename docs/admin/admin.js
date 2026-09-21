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
    const head = h('h2', null, '② 要確認リスト', h('span', { class: 'muted small' }, pending ? `　（${md(pending.generatedAt)} 時点）` : ''));
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
      h('h2', { style: 'margin-top:0' }, '③ 今すぐ更新'),
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

  function render() {
    app.replaceChildren(
      ...[
        h('h1', null, '管理画面'),
        statusMsg ? h('div', { class: 'status ' + statusMsg.kind, role: 'status' }, statusMsg.text) : null,
        connectionCard(),
        pendingList(),
        token && decisions ? runCard() : null,
        historyList(),
      ].filter(Boolean));
  }

  async function init() {
    try {
      const res = await fetch('../data/pending.json', { cache: 'no-store' });
      pending = res.ok ? await res.json() : null;
    } catch { pending = null; }
    render();
    if (token) {
      try {
        decisions = (await readDecisions()).data;
      } catch (e) {
        statusMsg = { kind: 'err', text: explain(e) };
      }
      render();
    }
  }
  init();
})();
