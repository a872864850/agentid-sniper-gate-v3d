// 探測：把今天評估過的合約抓下來，統計「自動加 LP」與「後門」各種訊號的命中率
// 用法：node probe-lp.mjs [數量] [輸出路徑]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIMIT = Number(process.argv[2] || 200);
const OUT = process.argv[3] || join(HERE, 'data', 'gate-probe.json');

const RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.publicnode.com', 'https://binance.llamarpc.com'];
let ri = 0;
async function rpc(method, params) {
  for (let k = 0; k < 10; k++) {
    const u = RPCS[ri++ % RPCS.length];
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
      if (j.error && /rate|limit|too many/i.test(JSON.stringify(j.error))) { await new Promise((r) => setTimeout(r, 400)); continue; }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('rpc failed ' + method);
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']).catch(() => null);
const codeCache = new Map();
async function codeOf(a) {
  if (!codeCache.has(a)) codeCache.set(a, String((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase());
  return codeCache.get(a);
}
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

const ROUTER = '10ed43c718714eb63d5aa57b78b54704e256024e';
const FACTORY = 'ca143ce32fe78f1f7019d7d551a6402fc5350c73';
const WBNB = 'bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const SEL = {
  addLiqEth: 'f305d719', addLiq: 'e8e33700', createPair: 'c9c65396', getPair: 'e6a43905',
  sync: 'fff6cae9', swapExactEth: '7ff36ab5', swapExactTokens: '38ed1739',
};
const SIZE_SELS = ['d5abeb01', '32cb6b0c', '355274ea', 'e985e367', 'f1aee5a2', '0f2cdd6c',
  'a0e23ebd', 'd8f93498', 'c65b61ca', '3a98ef39', 'b6b6f0c3', 'cce132d1', '06517a29',
  '2163837f', 'aa2d9a02', '76c71ca1', '98f1312e', '85e3f997', 'cef6feda', '29b80536', '3a1d8d3a'];

// 只有這些算「跑路後門」：能抽走資金、改稅、黑名單、暫停、升級、改上限／手動開盤
const CRITICAL = [
  'pause()', 'unpause()', 'setPaused(bool)',
  'blacklist(address)', 'setBlacklist(address,bool)', 'addBlacklist(address)', 'setBot(address,bool)',
  'setTax(uint256)', 'setFee(uint256)', 'setBuyTax(uint256)', 'setSellTax(uint256)',
  'setFees(uint256,uint256)', 'setBuyFee(uint256)', 'setSellFee(uint256)',
  'setMaxTxAmount(uint256)', 'setMaxWalletAmount(uint256)', 'setLimits(uint256,uint256)',
  'setMaxSupply(uint256)', 'setMintPrice(uint256)',
  'withdraw()', 'withdrawETH()', 'withdrawToken(address)', 'emergencyWithdraw()',
  'rescueToken(address)', 'upgradeTo(address)', 'upgradeToAndCall(address,bytes)',
  'enableTrading()', 'openTrading()', 'setTradingOpen(bool)',
  'setRouter(address)', 'setPool(address)', 'setMarketPair(address)',
  'migrate(address)', 'setSwapEnabled(bool)',
];
const SOFT = ['setBaseURI(string)', 'setTokenURI(uint256,string)', 'excludeFromFee(address)', 'setWhitelist(address,bool)'];

const wl = readFileSync(join(HERE, 'watch.mjs'), 'utf8').split(/\r?\n/);
const src = wl.slice(376, 395).join('\n');
const keccakHex = new Function(src + '\nreturn keccakHex;')();
if (keccakHex('') !== 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') throw new Error('keccak 抽取失敗');
const sel = (s) => keccakHex(Buffer.from(s, 'utf8').toString('hex')).slice(0, 8);

const lines = readFileSync(join(HERE, 'data', 'watch.log'), 'utf8').split(/\r?\n/);
const seen = new Set(), all = [];
for (const l of lines) {
  const m = l.match(/\[[^\]]+\]\s+(0x[a-fA-F0-9]{40})\s+(🤖 已自動鑄造|⏸|⛔|⚠️|⚪|❌)/);
  if (!m) continue;
  const a = m[1].toLowerCase();
  if (seen.has(a)) continue; seen.add(a); all.push(a);
}
const pick = all.slice(-LIMIT);
console.log(`log 內契約 ${all.length} 個，探測最近 ${pick.length} 個`);

const criticalSel = CRITICAL.map((s) => [sel(s), s]);
const softSel = SOFT.map((s) => [sel(s), s]);

const rows = [];
let i = 0, done = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < pick.length) {
    const c = pick[i++];
    try {
      const base = await codeOf(c);
      if (!base || base.length < 10) { rows.push({ c, nocode: 1 }); continue; }
      const code = await fullCode(c, base);
      const r = {
        c, len: code.length,
        router: code.includes(ROUTER), factory: code.includes(FACTORY), wbnb: code.includes(WBNB),
      };
      for (const [k, v] of Object.entries(SEL)) r[k] = code.includes(v);
      r.crit = criticalSel.filter(([s]) => code.includes(s)).map(([, n]) => n);
      r.soft = softSel.filter(([s]) => code.includes(s)).map(([, n]) => n);
      const sizes = [];
      for (const s of SIZE_SELS) {
        if (!code.includes(s)) continue;
        const x = await call(c, '0x' + s);
        if (!x || x.length < 66) continue;
        let n = Number(BigInt(x.slice(0, 66)));
        if (!Number.isFinite(n) || n <= 0) continue;
        if (n % 1e18 === 0 && n / 1e18 >= 1 && n / 1e18 <= 1e9) n = n / 1e18;
        if (n >= 1 && n <= 1e9) sizes.push(n);
      }
      r.sizes = [...new Set(sizes)];
      const o = await call(c, '0x8da5cb5b');
      r.owner = o && o.length >= 66 && !/^0x0{64}$/i.test(o) ? '0x' + o.slice(26, 66) : null;
      rows.push(r);
    } catch (e) { rows.push({ c, err: e.message }); }
    if (++done % 40 === 0) console.log(`  … ${done}/${pick.length}`);
  }
}));

const ok = rows.filter((r) => !r.nocode && !r.err);
const pct = (n) => `${n}/${ok.length} (${((n / ok.length) * 100).toFixed(1)}%)`;
const cnt = (f) => ok.filter(f).length;
console.log(`\n可用樣本 ${ok.length}`);
console.log(`bitcode 含 Router ${pct(cnt((r) => r.router))}`);
console.log(`含 Factory      ${pct(cnt((r) => r.factory))}`);
console.log(`含 WBNB         ${pct(cnt((r) => r.wbnb))}`);
console.log(`含 addLiquidityETH ${pct(cnt((r) => r.addLiqEth))}`);
console.log(`含 addLiquidity    ${pct(cnt((r) => r.addLiq))}`);
console.log(`含 createPair      ${pct(cnt((r) => r.createPair))}`);
console.log(`Router+addLiq      ${pct(cnt((r) => r.router && (r.addLiqEth || r.addLiq)))}`);
console.log(`Router+WBNB        ${pct(cnt((r) => r.router && r.wbnb))}`);
console.log(`(Router||Factory)&&addLiq ${pct(cnt((r) => (r.router || r.factory) && (r.addLiqEth || r.addLiq)))}`);
console.log(`無 CRITICAL 後門    ${pct(cnt((r) => r.crit.length === 0))}`);
console.log(`有 owner           ${pct(cnt((r) => r.owner))}`);
console.log(`總量讀得到          ${pct(cnt((r) => r.sizes.length > 0))}`);

const combos = {
  'A: 總量+Router&addLiq+無後門': (r) => r.sizes.length > 0 && r.router && (r.addLiqEth || r.addLiq) && r.crit.length === 0,
  'B1: 總量+(Router||Factory)&addLiq+無後門': (r) => r.sizes.length > 0 && (r.router || r.factory) && (r.addLiqEth || r.addLiq) && r.crit.length === 0,
  'B2: 總量+Router&WBNB+無後門': (r) => r.sizes.length > 0 && r.router && r.wbnb && r.crit.length === 0,
  'C1: 總量+(Router||Factory||WBNB)+addLiq+無後門': (r) => r.sizes.length > 0 && (r.router || r.factory || r.wbnb) && (r.addLiqEth || r.addLiq) && r.crit.length === 0,
  'C2: 總量+addLiq+無後門': (r) => r.sizes.length > 0 && (r.addLiqEth || r.addLiq) && r.crit.length === 0,
  'D: 總量+無後門（不看LP）': (r) => r.sizes.length > 0 && r.crit.length === 0,
};
console.log('\n=== 組合命中 ===');
for (const [k, f] of Object.entries(combos)) console.log(`${k}: ${pct(cnt(f))}`);
console.log('\n=== 有 addLiquidity 的合約（關鍵樣本）===');
for (const r of ok.filter((x) => x.addLiqEth || x.addLiq).slice(0, 20)) {
  console.log(`${r.c} len=${r.len} router=${r.router ? 1 : 0} factory=${r.factory ? 1 : 0} wbnb=${r.wbnb ? 1 : 0} addLiqEth=${r.addLiqEth ? 1 : 0} addLiq=${r.addLiq ? 1 : 0} crit=${r.crit.length} sizes=${r.sizes.join('/')}`);
}
console.log('\n=== 無後門且總量可讀的樣本 ===');
for (const r of ok.filter((x) => x.crit.length === 0 && x.sizes.length > 0).slice(0, 25)) {
  console.log(`${r.c} sizes=${r.sizes.join('/')} router=${r.router ? 1 : 0} addLiq=${(r.addLiqEth || r.addLiq) ? 1 : 0} owner=${r.owner ? r.owner.slice(0, 8) : '無'}`);
}

writeFileSync(OUT, JSON.stringify({ total: all.length, sample: ok.length, rows: ok }, null, 1));
console.log(`\n原始結果 → ${OUT}`);
