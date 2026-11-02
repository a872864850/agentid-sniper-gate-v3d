// site-backtest.mjs —— 用真實合約測「官網能不能看出來」：對最近通過前面幾條的合約跑一次官網檢查
// 用法：node site-backtest.mjs [log檔] [最多幾個] [mode: passed|minted|all]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeSiteFinder, SITE_VERSION } from './site.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = process.argv[2] || join(HERE, 'data', 'watch.log');
const LIMIT = Number(process.argv[3] || 60);
const MODE = String(process.argv[4] || 'passed');

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
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
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
  return code;
}
const wl = readFileSync(join(HERE, 'watch.mjs'), 'utf8');
const ks = wl.indexOf('const KRC ='), ke = wl.indexOf('const DEPLOYERS', ks);
const keccakHex = new Function(wl.slice(ks, ke) + '\nreturn keccakHex;')();

const lines = readFileSync(LOG, 'utf8').split(/\r?\n/);
const passed = [], minted = new Set(), all = [];
for (const l of lines) {
  if (l.includes('進場條件通過')) { const m0 = l.match(/0x[0-9a-fA-F]{40}/); if (m0) passed.push(m0[0].toLowerCase()); }
  const m = l.match(/\[[^\]]+\]\s+(0x[a-fA-F0-9]{40})\s+(🤖 已自動鑄造|⏸|⛔|⚠️|⚪|❌)/);
  if (m) { all.push(m[1].toLowerCase()); if (m[2].startsWith('🤖')) minted.add(m[1].toLowerCase()); }
}
const src = MODE === 'minted' ? [...minted] : MODE === 'all' ? all : passed;
const pick = [...new Set(src)].slice(-LIMIT);
console.log(`SITE_VERSION = ${SITE_VERSION}；來源 ${MODE}，最近 ${pick.length} 個合約\n`);

const finder = makeSiteFinder({ call, codeOf, fullCode, keccakHex, log: () => {}, cfg: {} });
let ok = 0; const rows = [];
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < pick.length) {
    const c = pick[i++];
    const r = await finder(c, { allow: new Set(), extra: [] }).catch((e) => ({ ok: false, why: 'err ' + e.message, candidates: [] }));
    if (r.ok) ok++;
    rows.push({ c, r });
  }
}));
rows.sort((a, b) => (b.r.ok ? 1 : 0) - (a.r.ok ? 1 : 0));
for (const x of rows.slice(0, 12)) console.log(`${x.r.ok ? '✅' : '❌'} ${x.c}  ${x.r.ok ? x.r.host + '（' + x.r.src + '）' : x.r.why}`);
console.log(`\n有官網 ${ok} / ${rows.length}（${((ok / rows.length) * 100).toFixed(1)}%）`);
