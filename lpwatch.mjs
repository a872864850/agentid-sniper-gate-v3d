// LP 死址驗證器（v3 安全機制第 5 條的「事後驗證」）
//
// 為什麼不能只看位元碼：LP 死址常數通常在「建構參數」裡，不在 runtime bytecode，
// 實測 250 個合約裡 0 個位元碼含 0x…dEaD。所以「LP 全部鑄到死地址」只能等開池後查。
//
// 用法：
//   node lpwatch.mjs             # 檢查今天鑄造過、還沒查過池子的幣
//   node lpwatch.mjs --all       # 全部重查
//   node lpwatch.mjs 0xaddr ...  # 只查指定合約
//
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, 'data', 'watch.log');
const STATE = join(HERE, 'data', 'lpwatch.json');
const FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const DEAD = '0x000000000000000000000000000000000000dead';
const ZERO = '0x0000000000000000000000000000000000000000';

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
const num = (r) => (r && r.length >= 66 ? Number(BigInt(r.slice(0, 66))) : null);
const addrOf = (r) => (r && r.length >= 66 ? '0x' + r.slice(26, 66) : null);
const pad = (a) => '000000000000000000000000' + a.toLowerCase().replace(/^0x/, '');

const args = process.argv.slice(2);
const force = args.includes('--all');
const explicit = args.filter((a) => /^0x[0-9a-f]{40}$/i.test(a));

let tokens = explicit.map((a) => a.toLowerCase());
if (!tokens.length) {
  const seen = new Set();
  for (const l of readFileSync(LOG, 'utf8').split(/\r?\n/)) {
    const m = l.match(/\[[^\]]+\]\s+(0x[a-fA-F0-9]{40})\s+🤖/);
    if (m) seen.add(m[1].toLowerCase());
  }
  tokens = [...seen];
}
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
let checked = 0, withPair = 0, burned = 0, unburned = 0, rows = [];

let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < tokens.length) {
    const t = tokens[i++];
    if (!force && state[t] && state[t].pair) continue;
    const pair = addrOf(await call(FACTORY, '0xe6a43905' + pad(t) + pad(WBNB)));
    checked++;
    if (!pair || /^0x0{40}$/.test(pair)) { state[t] = { at: Date.now(), pair: null }; continue; }
    withPair++;
    const ts = num(await call(pair, '0x18160ddd'));
    const bd = num(await call(pair, '0x70a08231' + pad(DEAD)));
    const bz = num(await call(pair, '0x70a08231' + pad(ZERO)));
    const pct = ts ? ((bd + bz) / ts) * 100 : 0;
    const ok = pct >= 95;
    if (ok) burned++; else unburned++;
    state[t] = { at: Date.now(), pair, totalSupply: ts, dead: bd, zero: bz, pct: Number(pct.toFixed(2)), locked: ok };
    rows.push({ t, pair, pct, ok });
  }
}));
writeFileSync(STATE, JSON.stringify(state, null, 1));
rows.sort((a, b) => a.pct - b.pct);
for (const r of rows) console.log(`${r.ok ? '🔒' : '⚠️'} LP ${String(r.pct.toFixed(2)).padStart(6)}% 在死址  ${r.t}  pair ${r.pair}`);
console.log(`\n檢查 ${checked} 個合約：有交易對 ${withPair} 個（LP 已鎖死 ${burned}、未鎖 ${unburned}）；其餘 ${checked - withPair} 個還沒開池`);
if (unburned) { console.log('\n⚠️ 有池子但 LP 沒進死址，項目方可抽池子：'); for (const r of rows.filter((x) => !x.ok)) console.log('   ' + r.t); }
