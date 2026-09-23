// 出現・消滅・異常検知の判定ロジック（仕様書 5〜7章）。ファイルやネットワークには触れない純粋な関数。
//
// 1つの「店舗×商品×状態」ごとに entry を持つ:
//   confirmed : 最後に確定した状態 { state: 'value'|'none', price, since }（'none' = 掲載なし・〆切）
//   shown     : 公開ページに出す状態 { state: 'value'|'none'|'paused'|'unknown', price, since }
//   pending   : 異常検知で保留中の価格 { price, prevPrice, since } | null
//   ignored   : 「間違い」と判断済みのサイト側の価格（同じ値で再び保留しないため） | null
//   lastEvent : 直近の出現/消滅 { type: 'appear'|'disappear', at } | null
//
// 観測 obs は次のどれか:
//   { kind: 'value', price }  金額あり
//   { kind: 'unknown' }       掲載はあるが金額が確認できない（「買取中！」「価格更新中」など）。前日の価格は引き継がない
//   { kind: 'absent' }        サイトに掲載なし
//   { kind: 'paused' }        休止（手動入力店舗が「本日休止」を押した）。一時的なお休みなので出現・消滅には
//                             カウントしない（未確認と同様、確定済みの状態はそのまま。表示だけ「休止」）。
//                             ※仕様書6章は休止を「取扱なし」と同列に書いているが、1日休むだけで全商品が
//                               「消滅」→翌日「出現」になり通知が埋まるため、この扱いにしている
//
// 取得自体が失敗した回は step を呼ばない（＝何も観測しなかった扱い。消滅にしない）。

const DEFAULT_THRESHOLD_PCT = 50;

// 数値あり → 数値あり の変化が「要確認」か。0円以下、または変化率が閾値超（桁間違いはこれに含まれる）。
function isAnomalous(prevPrice, nextPrice, thresholdPct = DEFAULT_THRESHOLD_PCT) {
  if (!(nextPrice > 0)) return true;
  return (Math.abs(nextPrice - prevPrice) / prevPrice) * 100 > thresholdPct;
}

function newEntry() {
  return { confirmed: null, shown: null, pending: null, ignored: null, lastEvent: null };
}

// ctx: { now: ISO文字列, baseline: この店舗×ゲームに過去の成功実行があるか, thresholdPct }
// 戻り値: { entry, events, rows }。rows は公開状態が変わったときだけ出る履歴行 { t, st, v }
function step(prevEntry, obs, ctx) {
  const e = prevEntry ? structuredClone(prevEntry) : newEntry();
  const events = [];
  const rows = [];
  const now = ctx.now;
  const threshold = ctx.thresholdPct ?? DEFAULT_THRESHOLD_PCT;

  const setShown = (state, price) => {
    if (!e.shown || e.shown.state !== state || e.shown.price !== price) {
      e.shown = { state, price, since: now };
      rows.push({ t: now, st: state, v: price });
    }
  };
  const setConfirmed = (state, price) => {
    e.confirmed = { state, price, since: now };
  };
  const emit = (type, extra) => events.push({ t: now, type, ...extra });

  if (obs.kind === 'unknown') {
    setShown('unknown', null); // confirmed / pending はそのまま。次に金額が出たら confirmed と比較する
    return { entry: e, events, rows };
  }

  if (obs.kind === 'paused') {
    // confirmed / pending はそのまま。休止が明けて同じ金額に戻れば何も起きない。
    // 何日も続けて休止のときも「いつが休みか」を取り違えないよう、since は毎回この回の日時に更新する
    e.shown = { state: 'paused', price: null, since: now };
    rows.push({ t: now, st: 'paused', v: null });
    return { entry: e, events, rows };
  }

  if (obs.kind === 'absent') {
    const state = 'none';
    const c = e.confirmed;
    if (c && c.state === 'value') {
      emit('disappear', { from: c.price });
      e.lastEvent = { type: 'disappear', at: now };
    }
    e.pending = null;
    e.ignored = null;
    if (!c || c.state !== state) setConfirmed(state, null);
    setShown(state, null);
    return { entry: e, events, rows };
  }

  // obs.kind === 'value'
  const p = obs.price;
  const c = e.confirmed;

  if (e.ignored !== null && e.ignored !== p) e.ignored = null; // サイトの値が変わったら「間違い」判断は失効

  if (!c) {
    // 初めて金額を確認した商品。店舗の初回巡回（baseline なし）は基準づくりなので出現扱いにしない
    setConfirmed('value', p);
    if (ctx.baseline) {
      emit('appear', { to: p });
      e.lastEvent = { type: 'appear', at: now };
    }
    setShown('value', p);
    return { entry: e, events, rows };
  }

  if (c.state !== 'value') {
    // 取扱なし/休止 → 数値あり = 出現。異常検知は通さず即反映
    emit('appear', { from: c.state, to: p });
    e.lastEvent = { type: 'appear', at: now };
    setConfirmed('value', p);
    e.pending = null;
    setShown('value', p);
    return { entry: e, events, rows };
  }

  // 数値あり → 数値あり
  if (p === c.price || p === e.ignored) {
    e.pending = null;
    setShown('value', c.price);
    return { entry: e, events, rows };
  }
  if (isAnomalous(c.price, p, threshold)) {
    if (!e.pending || e.pending.price !== p) {
      e.pending = { price: p, prevPrice: c.price, since: now };
      emit('anomaly', { from: c.price, to: p });
    }
    setShown('value', c.price); // 保留中は公開側に反映せず、確定済みの価格を出し続ける
    return { entry: e, events, rows };
  }
  setConfirmed('value', p);
  e.pending = null;
  setShown('value', p);
  return { entry: e, events, rows };
}

// 管理者の判断を反映する。
//   approve : 保留中の価格を「正しい」として公開に反映
//   set     : 手動で正しい価格に修正して反映（price 必須）
//   dismiss : 保留中の価格は「間違い」。確定済みの価格のまま据え置く
// set / dismiss は、サイトが同じ間違った値を出し続けても再び保留にしない（ignored に記録）。
function applyDecision(prevEntry, decision, now) {
  if (!prevEntry) throw new Error('該当する項目がありません');
  const e = structuredClone(prevEntry);
  const events = [];
  const rows = [];
  const setShown = (state, price) => {
    if (!e.shown || e.shown.state !== state || e.shown.price !== price) {
      e.shown = { state, price, since: now };
      rows.push({ t: now, st: state, v: price });
    }
  };
  const flagged = e.pending?.price ?? null;

  if (decision.action === 'approve') {
    if (!e.pending) throw new Error('保留中の項目ではありません');
    e.confirmed = { state: 'value', price: e.pending.price, since: now };
    e.pending = null;
    setShown('value', e.confirmed.price);
    events.push({ t: now, type: 'approved', to: e.confirmed.price });
  } else if (decision.action === 'set') {
    if (!(decision.price > 0)) throw new Error('修正後の価格が必要です');
    e.confirmed = { state: 'value', price: decision.price, since: now };
    e.pending = null;
    e.ignored = flagged;
    setShown('value', decision.price);
    events.push({ t: now, type: 'corrected', from: flagged, to: decision.price });
  } else if (decision.action === 'dismiss') {
    if (!e.pending) throw new Error('保留中の項目ではありません');
    e.pending = null;
    e.ignored = flagged;
    events.push({ t: now, type: 'dismissed', from: flagged });
  } else {
    throw new Error(`不明な操作: ${decision.action}`);
  }
  return { entry: e, events, rows };
}

module.exports = { DEFAULT_THRESHOLD_PCT, isAnomalous, newEntry, step, applyDecision };
