// _revertdiag.mjs —— 一次性診斷：同一個合約在不同 RPC 節點上，refund() revert 的「形狀」是否一致
// 目的：查清楚為什麼同一筆會在 valid / unknown 之間來回跳（懷疑某些節點把 revert 資料放在 error.data）
const RPCS = [
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc.publicnode.com',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
];
const TOKENS = process.argv.slice(2);
import { readFileSync } from 'node:fs';
const wsrc = readFileSync('./watch.mjs', 'utf8');
const ks = wsrc.indexOf('const KRC ='), ke = wsrc.indexOf('const DEPLOYERS', ks);
const keccakHex = new Function(wsrc.slice(ks, ke) + '\nreturn keccakHex;')();
const sel = (s) => '0x' + keccakHex(Buffer.from(s, 'utf8').toString('hex')).slice(0, 8);
const FROM = '0xdad26575cc28af78ace54bb1d3f033ca9afa0510';
const SEL = sel('refund()');
const CTRL = '0xdeadbeef';
console.log('refund() =', SEL);

async function call(url, tok, data) {
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: FROM, to: tok, data }, 'latest'] }),
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json();
    return j.result !== undefined ? { ok: true, result: j.result } : { err: j.error };
  } catch (e) { return { err: { message: e.message } }; }
}

for (const tok of TOKENS) {
  console.log(`\n=== ${tok} ===`);
  for (const u of RPCS) {
    const a = await call(u, tok, SEL), b = await call(u, tok, CTRL);
    const fmt = (x) => x.ok ? `OK ${String(x.result).slice(0, 12)}` : `ERR msg=${JSON.stringify(String(x.err?.message).slice(0, 60))} data=${JSON.stringify(x.err?.data ?? null).slice(0, 30)}`;
    console.log(`  ${new URL(u).host.padEnd(30)} refund: ${fmt(a)}`);
    console.log(`  ${''.padEnd(30)} ctrl  : ${fmt(b)}`);
  }
}
