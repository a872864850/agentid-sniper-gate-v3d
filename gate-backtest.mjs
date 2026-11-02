// 回測：把 watch.log 裡今天實際評估過的合約，用新的進場條件（gate.mjs）跑一遍
// 用法：node gate-backtest.mjs [log 檔路徑] [最多幾個合約]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeGate } from './gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = process.argv[2] || join(HERE, 'data', 'watch.log');
const LIMIT = Number(process.argv[3] || 60);
const MODE = String(process.argv[4] || 'recent'); // recent | minted | all

const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.publicnode.com'];
let ri = 0;
async function rpc(method, params) {
  for (let k = 0; k < 8; k++) {
    const u = RPCS[ri++ % RPCS.length];
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('rpc failed ' + method);
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']).catch(() => null);
const codeCache = new Map();
async function codeOf(a) { if (!codeCache.has(a)) codeCache.set(a, String((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase()); return codeCache.get(a); }
async function fullCode(c, code) {
  code = String(code || '').toLowerCase();
  if (code.length < 4 || code.length >= 4000) return code;
  try {
    const impl = await rpc('eth_getStorageAt', [c, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']);
    if (impl && BigInt(impl) !== 0n) code += String((await rpc('eth_getCode', ['0x' + impl.slice(-40), 'latest']).catch(() => '')) || '').toLowerCase();
  } catch {}
  const m = code.replace(/^0x/, '').match(/^363d3d373d3d3d363d73([0-9a-f]{40})5af4/);
  if (m) code += String((await rpc('eth_getCode', ['0x' + m[1], 'latest']).catch(() => '')) || '').toLowerCase();
  return code;
}

// keccak256 直接用 watch.mjs 裡已經在用的那一份（第 377–395 行），避免回測與正式邏輯不一致
const wl = readFileSync(join(HERE, 'watch.mjs'), 'utf8').split(/\r?\n/);
const src = wl.slice(376, 395).join('\n');
const keccakHex = new Function(src + '\nreturn keccakHex;')();
if (keccakHex('') !== 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') throw new Error('keccak 抽取失敗，回測中止');

const lines = readFileSync(LOG, 'utf8').split(/\r?\n/);
const seen = new Set(), all = [], minted = new Set();
for (const l of lines) {
  const m = l.match(/\[[^\]]+\]\s+(0x[a-fA-F0-9]{40})\s+(🤖 已自動鑄造|⏸|⛔|⚠️|⚪|❌)/);
  if (!m) continue;
  const a = m[1].toLowerCase();
  if (m[2].startsWith('🤖')) minted.add(a);
  if (seen.has(a)) continue; seen.add(a); all.push(a);
}
const pick = (MODE === 'minted' ? all.filter((c) => minted.has(c)) : all).slice(-LIMIT);
console.log(`log 內不同合約 ${all.length} 個（實際鑄造過 ${minted.size} 個）；本次回測最近 ${pick.length} 個\n`);

const gate = makeGate({ call, codeOf, fullCode, keccakHex, cfg: JSON.parse(process.env.GATE_CFG || '{}') });
let pass = 0, passMinted = 0; const reasons = {}; const rows = [];
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < pick.length) {
    const c = pick[i++];
    const r = await gate.inspect(c).catch((e) => ({ v: '檢查出錯：' + e.message, info: {} }));
    const key = r.v ? r.v.replace(/0x[0-9a-f]+/gi, '…').replace(/（[^）]*）/g, '（…）') : '✅ 通過';
    reasons[key] = (reasons[key] || 0) + 1;
    if (!r.v) { pass++; if (minted.has(c)) passMinted++; }
    rows.push({ c, v: r.v, info: r.info, m: minted.has(c) });
  }
}));
rows.sort((a, b) => (a.v ? 1 : 0) - (b.v ? 1 : 0));
for (const r of rows.slice(0, 15)) console.log(`${r.v ? '❌' : '✅'} ${r.m ? '[打過]' : '      '} ${r.c}  ${r.v || `總量 ${(r.info.sizes || []).join('/')} · LP ${(r.info.lp || []).join(',') || '無'} · owner ${r.info.owner ? r.info.owner.slice(0, 8) + '…' : '無'}`}`);
console.log(`\n=== 通過 ${pass} / ${pick.length}（${((pass / pick.length) * 100).toFixed(1)}%），其中原本實際打過的 ${passMinted} / ${pick.filter((c) => minted.has(c)).length} ===`);
// 三條條件各自單獨的通過率（看哪一條最致命）
const t = { capOk: 0, lpOk: 0, permClean: 0, ownerOk: 0, all: 0, cap10000Any: 0,
  refundOk: 0, lpBurnOk: 0, noWithdrawOk: 0, adminOk: 0, v3a: 0, v3b: 0 };
for (const r of rows) {
  const f = r.info || {};
  if (f.capOk) t.capOk++;
  if (f.lpOk) t.lpOk++;
  if (f.permClean) t.permClean++;
  if (f.ownerOk) t.ownerOk++;
  if (f.capOk && f.lpOk && f.permClean) t.all++;
  if ((f.sizes || []).includes(10000)) t.cap10000Any++;
  if (f.refundOk) t.refundOk++;
  if (f.lpBurnOk) t.lpBurnOk++;
  if (f.noWithdrawOk) t.noWithdrawOk++;
  if (f.adminOk) t.adminOk++;
  if (f.capOk && f.lpOk && f.refundOk && f.lpBurnOk && f.noWithdrawOk && f.adminOk) t.v3a++;
  if (f.capOk && f.lpOk && f.refundOk && f.lpBurnOk && f.noWithdrawOk && f.adminOk && f.refundWin) t.v3b++;
}
console.log(`單獨通過率：總量 ${t.capOk}/${rows.length} · 自動加LP ${t.lpOk}/${rows.length} · 無後門 ${t.permClean}/${rows.length} · owner ${t.ownerOk}/${rows.length}`);
console.log(`v3 新增：refund ${t.refundOk}/${rows.length} · LP死址 ${t.lpBurnOk}/${rows.length} · 無提款 ${t.noWithdrawOk}/${rows.length} · 權限≤2 ${t.adminOk}/${rows.length}`);
console.log(`v3 六條同時：${t.v3a}/${rows.length}（再加上 3 天常數：${t.v3b}/${rows.length}）`);
console.log('=== 攔下原因分布 ===');
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(3)}  ${k}`);
