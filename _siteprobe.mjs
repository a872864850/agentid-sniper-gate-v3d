// 一次性探測：對真實合約測「官網能不能看出來」的方法，決定 requireWebsite 怎麼落地
import { readFileSync, writeFileSync } from 'node:fs';

const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.publicnode.com'];
async function rpc(method, params) {
  for (const u of RPCS) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json(); if (j.error) continue; if (j.result !== undefined) return j.result;
    } catch {}
  }
  return null;
}
async function call(to, data) { return await rpc('eth_call', [{ to, data }, 'latest']); }

const KRC = [1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
const KROT = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
const M64 = (1n << 64n) - 1n; const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
function keccakHex(hex) {
  const msg = Buffer.from(hex, 'hex'); const rate = 136; const padLen = rate - (msg.length % rate); const p = Buffer.concat([msg, Buffer.alloc(padLen)]); p[msg.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) A[i] ^= p.readBigUInt64LE(off + i * 8);
    for (let r = 0; r < 24; r++) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
      for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) A[y + x] ^= D; }
      const B = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], KROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
      A[0] ^= KRC[r];
    }
  }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8); return out.toString('hex');
}
const selOf = (sig) => keccakHex(Buffer.from(sig, 'utf8').toString('hex')).slice(0, 8);
console.log('校驗 sel(transfer(address,uint256)) =', selOf('transfer(address,uint256)'), '(應 a9059cbb)');
console.log('校驗 sel(refund()) =', selOf('refund()'));

const NAMES = ['website()', 'site()', 'url()', 'homepage()', 'officialSite()', 'webSite()', 'info()', 'socials()', 'description()', 'getWebsite()'];
const SELS = NAMES.map((n) => [selOf(n), n]);

const log = readFileSync(process.argv[2] || 'data/watch.log', 'utf8');
const addrs = [];
for (const line of log.split(/\r?\n/)) {
  if (!/已自動鑄造|進場條件通過/.test(line)) continue;
  for (const m of line.matchAll(/0x[0-9a-fA-F]{40}/g)) addrs.push(m[0].toLowerCase());
}
const uniq = [...new Set(addrs)].reverse().slice(0, Number(process.argv[3] || 30));
console.log('待測合約', uniq.length, '個（日誌裡共', new Set(addrs).size, '個）');

function urlsInCode(hex) {
  const s = hex.replace(/^0x/, ''); const ch = [];
  for (let i = 0; i + 2 <= s.length; i += 2) { const b = parseInt(s.slice(i, i + 2), 16); ch.push(b >= 32 && b < 127 ? String.fromCharCode(b) : ' '); }
  const txt = ch.join(''); const out = new Set();
  for (const m of txt.matchAll(/https?:\/\/[a-zA-Z0-9._\-\/%?=&#+]+/g)) out.add(m[0]);
  for (const m of txt.matchAll(/\b[a-z0-9][a-z0-9-]{1,30}\.(xyz|com|fun|io|app|site|ai|finance|org|net|pro|club|live|link|cc|me|world|tech|money|gg|top|vip|online|meme)\b/gi)) out.add(m[0]);
  return [...out];
}
function decStr(r) {
  if (!r || r.length < 130) return '';
  try { const x = r.slice(2); const len = Number(BigInt('0x' + x.slice(64, 128))); if (!(len > 0 && len < 300)) return ''; return Buffer.from(x.slice(128, 128 + len * 2), 'hex').toString('utf8'); } catch { return ''; }
}

const rows = [];
for (const a of uniq) {
  const code = ((await rpc('eth_getCode', [a, 'latest'])) || '0x');
  const urls = code.length > 2 ? urlsInCode(code) : [];
  const hits = [];
  for (const [sel, name] of SELS) {
    if (!(code.length > 2) || !code.toLowerCase().includes(sel)) continue;
    const r = await call(a, '0x' + sel).catch(() => null); const t = decStr(r);
    if (t && /https?:\/\/|\.(xyz|com|fun|io|app|site|ai)\b/i.test(t)) hits.push(name + '=' + t.slice(0, 60));
  }
  rows.push({ a, codeLen: code.length, urls: urls.slice(0, 5), getters: hits });
  console.log(a, 'code', String(code.length).padStart(6), 'URL:', (urls.slice(0, 3).join(' , ') || '-'), '| getter:', (hits.join(' , ') || '-'));
}
writeFileSync('data/site-probe.json', JSON.stringify(rows, null, 1));
const withSite = rows.filter((r) => r.urls.length || r.getters.length).length;
console.log(`\n有官網線索 ${withSite}/${rows.length}`);
