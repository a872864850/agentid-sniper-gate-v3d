// probe-diff.mjs —— 退款探測結果的「變化偵測」（純函式，不碰網路，可離線測試）
//
// 為什麼要獨立一支：refundprobe.mjs 每輪把結果整份覆寫，看不出「這一輪和上一輪哪裡變了」。
// 使用者 11/2 11:56「好的」要的是：某筆從「入口有效」變成「沒有入口」時立刻推播。
//
// 兩種證據等級，決定要不要「連兩輪確認」：
//   ❌ 沒有入口 / ✅ 可退  ← 位元碼與 eth_call 結果，確定性高 → 一偵測到就告警
//   ⚠️ 不可判定           ← 空 revert，本來就沒有資訊，而且節點抖動也會造成 → 連兩輪一致才告警
//
// 轉折類型：
//   gone       入口有效 → ❌ 沒有入口          🚨 最嚴重（合約被換掉／入口被移除）
//   blind      入口有效 → ⚠️ 不可判定          ⚠️（需連兩輪確認）
//   recovered  沒有入口 → 入口有效             ✅
//   cleared    不可判定 → 入口有效             ✅（需連兩輪確認）
// 限流（ratelimit）一律不算變化；第一次出現的新合約沒有基準，不告警。

export const EFFECTIVE_LEVELS = new Set(['ok', 'valid']);
export const KIND_META = {
  gone: { icon: '🚨', title: '退款入口消失', rank: 4, certain: true },
  blind: { icon: '⚠️', title: '退款入口變成不可判定', rank: 3, certain: false },
  recovered: { icon: '✅', title: '退款入口出現／恢復有效', rank: 2, certain: true },
  cleared: { icon: '✅', title: '退款入口由不可判定轉為有效', rank: 1, certain: true },
};

export const keyOf = (r) => `${String(r?.tok || '').toLowerCase()}|${r?.walletName || ''}`;
export const isEffective = (r) => !!r && EFFECTIVE_LEVELS.has(r.level);

/**
 * @param {Array} prevRows 上一輪的 rows（空＝第一次跑）
 * @param {Array} nowRows  這一輪的 rows
 * @param {Object} state   上次已告警／待確認的狀態 {key: {level, kind, at, pending}}
 * @param {Number} now     現在時間戳
 * @returns {{alerts: Array, suppressed: Array, state: Object}}
 */
export function planAlerts(prevRows, nowRows, state = {}, now = Date.now()) {
  const prev = new Map();
  for (const r of prevRows || []) prev.set(keyOf(r), r);
  const alerts = [];
  const suppressed = [];
  const nextState = { ...(state || {}) };

  for (const r of nowRows || []) {
    const k = keyOf(r);
    const p = prev.get(k);
    if (!p) continue; // 新合約：沒有基準
    if (p.level === 'ratelimit' || r.level === 'ratelimit') continue;
    const before = p.level, after = r.level;
    if (before === after) { if (nextState[k]) delete nextState[k].pending; continue; }

    let kind = null;
    if (isEffective(p) && after === 'none') kind = 'gone';
    else if (isEffective(p) && after === 'unknown') kind = 'blind';
    else if (p.level === 'none' && isEffective(r)) kind = 'recovered';
    else if (p.level === 'unknown' && isEffective(r)) kind = 'cleared';
    if (!kind) continue;

    const st = nextState[k] || {};
    if (st.level === after && st.kind === kind) continue; // 同一個變化已告警過

    const meta = KIND_META[kind];
    const info = {
      kind, key: k, tok: r.tok, walletName: r.walletName,
      before, after, beforeLabel: p.label, afterLabel: r.label,
      beforeDetail: p.detail || '', afterDetail: r.detail || '',
    };

    // 證據不確定的轉折（涉及 ⚠️ 不可判定）：要連兩輪看到同一個結果才告警
    if (!meta.certain) {
      const pend = st.pending;
      if (pend && pend.level === after && pend.kind === kind) {
        nextState[k] = { level: after, kind, at: now };
        alerts.push(info);
      } else {
        nextState[k] = { ...st, pending: { level: after, kind, at: now } };
        suppressed.push(info);
      }
      continue;
    }

    nextState[k] = { level: after, kind, at: now };
    alerts.push(info);
  }

  // 清掉本輪不在清單裡的 key，以及只剩空物件的殘留
  const live = new Set((nowRows || []).map(keyOf));
  for (const k of Object.keys(nextState)) {
    const v = nextState[k];
    if (!live.has(k) || !v || (!v.level && !v.pending)) delete nextState[k];
  }

  return { alerts, suppressed, state: nextState };
}

export function formatAlerts(alerts) {
  if (!alerts || !alerts.length) return '';
  const sorted = [...alerts].sort((a, b) => (KIND_META[b.kind]?.rank || 0) - (KIND_META[a.kind]?.rank || 0));
  const out = [`${KIND_META[sorted[0].kind].icon} 退款探測告警：${sorted.length} 筆狀態變化`];
  for (const a of sorted) {
    const meta = KIND_META[a.kind] || { icon: '⚠️', title: '狀態變化' };
    out.push('');
    out.push(`${meta.icon} ${meta.title}`);
    out.push(`${a.tok}`);
    if (a.walletName) out.push(`錢包：${a.walletName}`);
    out.push(`之前：${a.beforeLabel || a.before}${a.beforeDetail ? '｜' + a.beforeDetail : ''}`);
    out.push(`現在：${a.afterLabel || a.after}${a.afterDetail ? '｜' + a.afterDetail : ''}`);
    out.push(`https://bscscan.com/address/${a.tok}`);
  }
  return out.join('\n');
}
