// 探測 2：今天實際鑄造過的代幣，賣完後有沒有真的建池？LP 有沒有燒掉／鎖住？
// 用法：node probe-lp2.mjs [數量]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIMIT = Number(process.argv[2] || 40);

const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.publicnode.com', 'https://binance.llamarpc.com'];
let ri = 0;
async function rpc(method, params) {
  for (let k = 0; k < 10; k++) {
    const u = RPCS[ri++ % RPCS.length];
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('rpc failed');
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']).catch(() => null);
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const DEAD = '0x000000000000000000000000000000000000dEaD';

const lines = readFileSync(join(HERE, 'data', 'watch.log'), 'utf8').split(/\r?\n/);
const minted = [], seen = new Set();
for (const l of lines) {
  const m = l.match(/\[[^\]]+\]\s+\[[^\]]+\]\s+(0x[a-fA-F0-9]{40})\s+🤖 已自動鑄造/);
  if (m) { const a = m[1].toLowerCase(); if (!seen.has(a)) { seen.add(a); minted.push(a); } }
}
const pick = minted.slice(-LIMIT);
console.log(`今天自動鑄造過 ${minted.length} 個合約，檢查最近 ${pick.length} 個\n`);

const rows = [];
let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < pick.length) {
    const t = pick[i++];
    try {
      const pr = await call(FACTORY, '0xe6a43905' + t.slice(2).padStart(64, '0') + WBNB.slice(2).padStart(64, '0'));
      const pair = pr && pr.length >= 66 && !/^0x0+$/.test(pr.slice(0, 66)) ? '0x' + pr.slice(26, 66).toLowerCase() : null;
      const r = { t, pair };
      if (pair) {
        const ts = await call(pair, '0x18160ddd');                     // totalSupply (LP)
        const bal = await call(pair, '0x70a08231' + DEAD.slice(2).padStart(64, '0'));
        const bal0 = await call(pair, '0x70a08231' + '0'.repeat(64));
        const res = await call(pair, '0x0902f1ac');                    // getReserves
        if (ts && bal) {
          const T = BigInt(ts), B = BigInt(bal);
          r.lpSupply = T.toString();
          r.lpBurnedPct = T > 0n ? Number((B * 10000n) / T) / 100 : 0;
          r.lpDead = B > 0n;
        }
        if (bal0) r.lpZeroAddr = BigInt(bal0) > 0n;
        if (res && res.length >= 194) {
          r.r0 = BigInt(res.slice(2, 66)).toString();
          r.r1 = BigInt(res.slice(66, 130)).toString();
        }
      }
      rows.push(r);
    } catch (e) { rows.push({ t, err: e.message }); }
  }
}));

const withPair = rows.filter((r) => r.pair);
console.log(`有 PancakeSwap 交易對：${withPair.length}/${rows.length}`);
const burned = withPair.filter((r) => r.lpBurnedPct >= 99);
console.log(`LP 燒到死址 ≥99%：${burned.length}/${withPair.length}`);
for (const r of rows) {
  console.log(`${r.t} ${r.pair ? 'pair ' + r.pair.slice(0, 10) + '… LP燒 ' + (r.lpBurnedPct ?? '?') + '%' : '無池'}`);
}
writeFileSync(join(HERE, 'data', 'gate-probe2.json'), JSON.stringify(rows, null, 1));
console.log('\n→ data/gate-probe2.json');
