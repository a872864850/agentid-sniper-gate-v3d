// 看這些「免費項目」到底是什麼平台：代幣名字／符號／位元碼可讀字串
const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.publicnode.com'];
async function rpc(method, params) {
  for (const u of RPCS) { try { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) }); const j = await r.json(); if (j.error) continue; if (j.result !== undefined) return j.result; } catch {} }
  return null;
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
function decStr(r) { if (!r || r.length < 130) return ''; try { const x = r.slice(2); const len = Number(BigInt('0x' + x.slice(64, 128))); if (!(len > 0 && len < 200)) return ''; return Buffer.from(x.slice(128, 128 + len * 2), 'hex').toString('utf8'); } catch { return ''; } }
const addrs = ['0xae7db212a3b4144cee27d24e4a3df680c941c4a7', '0xaa93a227dc38ee5605a700b2b2e328d5b4567c54', '0x9bea17df40dfb6df203593aad58114eb745ffaa1', '0x120115a03be0e5213139b53918fb5af56627bfe7'];
for (const a of addrs) {
  const nm = decStr(await call(a, '0x06fdde03')), sy = decStr(await call(a, '0x95d89b41'));
  const tr = await call(a, '0xfc0c546a');
  const tok = tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n ? '0x' + tr.slice(26, 66) : '';
  let tn = '', ts = '';
  if (tok) { tn = decStr(await call(tok, '0x06fdde03')); ts = decStr(await call(tok, '0x95d89b41')); }
  const code = ((await rpc('eth_getCode', [a, 'latest'])) || '0x');
  const ch = []; const s = code.replace(/^0x/, '');
  for (let i = 0; i + 2 <= s.length; i += 2) { const b = parseInt(s.slice(i, i + 2), 16); ch.push(b >= 32 && b < 127 ? String.fromCharCode(b) : ' '); }
  const txt = ch.join(' ').replace(/\s+/g, ' ').trim();
  const strings = [...new Set((txt.match(/[ -~]{6,60}/g) || []))].slice(0, 25);
  console.log(`\n=== ${a} ===`);
  console.log('name=', JSON.stringify(nm), 'symbol=', JSON.stringify(sy), 'tokenOf=', tok, tok ? `(${tn} / ${ts})` : '');
  console.log('可讀字串:', strings.join(' | '));
}
