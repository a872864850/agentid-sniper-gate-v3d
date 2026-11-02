// 單一合約的 v3 進場條件明細（除錯用）
// 用法：node probe-v3.mjs 0xaddr [0xaddr...]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeGate } from './gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
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
const cc = new Map();
async function codeOf(a) { if (!cc.has(a)) cc.set(a, String((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase()); return cc.get(a); }
async function fullCode(c, code) { return code; }

const wl = readFileSync(join(HERE, 'watch.mjs'), 'utf8').split(/\r?\n/);
const keccakHex = new Function(wl.slice(376, 395).join('\n') + '\nreturn keccakHex;')();

const gate = makeGate({ call, codeOf, fullCode, keccakHex, cfg: JSON.parse(process.env.GATE_CFG || '{}') });
for (const a of process.argv.slice(2)) {
  const r = await gate.inspect(a);
  const i = r.info || {};
  console.log('='.repeat(70));
  console.log(a, r.v ? '\n  ❌ ' + r.v : '\n  ✅ 全部通過');
  console.log('  總量', (i.sizes || []).join('/') || '—', '| Router', i.router, '| addLiq', i.lpSels, '| WBNB', i.wbnb);
  console.log('  refund', i.refunds || '無', '| 3天常數', i.refundWin, '| 死址', i.dead, '| 提款', i.withdraws || '無');
  console.log('  權限 pause', i.permPause || '無', '| start', i.permStart || '無', '| 否決', i.denyPerms || '無');
  console.log('  owner', i.owner || '已放棄', '| 位元碼長度', i.len);
}
