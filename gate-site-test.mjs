// gate-site-test.mjs —— 驗證 v3e「沒有官方網站就不打」真的會擋／會放（不碰鏈、不真的連網）
// 用法：node gate-site-test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeGate, GATE_VERSION } from './gate.mjs';
import { makeSiteFinder, SITE_VERSION } from './site.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const wl = readFileSync(join(HERE, 'watch.mjs'), 'utf8');
const ks = wl.indexOf('const KRC ='), ke = wl.indexOf('const DEPLOYERS', ks);
if (ks < 0 || ke < 0) throw new Error('watch.mjs 裡找不到 keccak 實作，測試中止');
const keccakHex = new Function(wl.slice(ks, ke) + '\nreturn keccakHex;')();
if (keccakHex('') !== 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') throw new Error('keccak 抽取失敗（結果不對），測試中止');
const sel = (s) => keccakHex(Buffer.from(s, 'utf8').toString('hex')).slice(0, 8);

// 合約外殼：有 refund()、總量 500、無提款、無治理函式
function shell(extra = '') { return '0x6080604052' + sel('refund()') + 'd5abeb01' + extra; }
const hexOf = (s) => Buffer.from(s, 'utf8').toString('hex');

const SITE = 'https://mazevex.xyz/';
const codeWithUrl = shell(hexOf('x'.repeat(40) + SITE + 'y'.repeat(40)));
const codeNoUrl = shell(hexOf('hello world this contract has no website at all'));
const codeGetter = shell(sel('website()')); // 位元碼裡有 website() 選擇器，網址由 getter 回傳

const codeMap = new Map();
const callMap = new Map();
const deps = {
  call: async (to, data) => {
    const s = String(data).replace(/^0x/, '').slice(0, 8);
    if (s === 'd5abeb01') return '0x' + (500).toString(16).padStart(64, '0'); // 總量 500
    if (s === sel('owner()')) return '0x' + '0'.repeat(64);
    const k = to + ':' + String(data).slice(0, 10);
    return callMap.get(k) ?? null;
  },
  codeOf: async (a) => codeMap.get(a) || '0x',
  fullCode: async (a, c) => c,
  keccakHex,
  cfg: {},
  log: () => {},
};

// 假 fetch：只有 good.xyz 打得開且頁面提到代幣
const fetchImpl = async (url) => {
  const u = String(url);
  if (u.includes('good.xyz')) return { ok: true, status: 200, text: async () => '<html>MAZ — Mazevex official</html>' };
  if (u.includes('silent.xyz')) return { ok: true, status: 200, text: async () => '<html>welcome</html>' };
  return { ok: false, status: 404, text: async () => '' };
};

const cases = [];
function add(name, addr, code, { requireWebsite = true, siteVerify = true, allow = [], fetchImpl: f = fetchImpl, getter = null } = {}) {
  codeMap.set(addr, code);
  if (getter) callMap.set(addr + ':0x' + sel('website()'), getter);
  cases.push({ name, addr, requireWebsite, siteVerify, allow, fetchImpl: f });
}
// 合約裡的網址是 mazevex.xyz（fetch 404） → 應攔下
add('位元碼有網址但首頁打不開', '0x' + '1'.repeat(40), codeWithUrl);
// 完全沒有網址 → 應攔下
add('完全沒有網址', '0x' + '2'.repeat(40), codeNoUrl);
// 沒有網址、但關掉驗證也救不了（沒網址就是沒網址） → 應攔下
add('沒有網址＋siteVerify=false', '0x' + '3'.repeat(40), codeNoUrl, { siteVerify: false });
// 人工白名單（合約） → 應放行
add('人工白名單（合約地址）', '0x' + '4'.repeat(40), codeNoUrl, { allow: ['0x' + '4'.repeat(40)] });
// 人工白名單（網域） → 應放行
add('人工白名單（網域）', '0x' + '5'.repeat(40), shell(hexOf('see good.xyz for details')), { allow: ['good.xyz'] });
// 官網打得開且頁面有提到代幣 → 應放行
add('官網打得開且提到代幣', '0x' + '6'.repeat(40), shell(hexOf('visit good.xyz')));
// 官網打得開但完全沒提到代幣（假官網） → 應攔下
add('首頁沒提到代幣', '0x' + '7'.repeat(40), shell(hexOf('visit silent.xyz')));
// getter website() 回傳官網 → 應放行
add('getter 回傳官網', '0x' + '8'.repeat(40), codeGetter, { getter: '0x' + Buffer.from('https://good.xyz', 'utf8').toString('hex').padEnd(64, '0').slice(0, 0) + '0'.repeat(64) });

// getter 的 ABI string 回傳（offset=32, len, data）
const g = '0x' + (32).toString(16).padStart(64, '0') + Buffer.from('https://good.xyz', 'utf8').length.toString(16).padStart(64, '0') + Buffer.from('https://good.xyz', 'utf8').toString('hex').padEnd(128, '0');
callMap.set('0x' + '8'.repeat(40) + ':0x' + sel('website()'), g);

let bad = 0;
console.log('GATE_VERSION =', GATE_VERSION, '| SITE_VERSION =', SITE_VERSION);
const expectMap = {
  '位元碼有網址但首頁打不開': false,
  '完全沒有網址': false,
  '沒有網址＋siteVerify=false': false,
  '人工白名單（合約地址）': true,
  '人工白名單（網域）': true,
  '官網打得開且提到代幣': true,
  '首頁沒提到代幣': false,
  'getter 回傳官網': true,
};
for (const c of cases) {
  const finder = makeSiteFinder({ ...deps, fetchImpl: c.fetchImpl, cfg: { siteVerify: c.siteVerify, siteDex: false } });
  const g2 = makeGate({ ...deps, cfg: { requireWebsite: c.requireWebsite }, siteFind: (a) => finder(a, { allow: c.allow, name: 'Mazevex', symbol: 'MAZ' }) });
  const v = await g2(c.addr);
  const want = expectMap[c.name];
  const ok = want ? v === '' : v.includes('官方網站');
  if (!ok) bad++;
  console.log(`${ok ? '✅' : '❌'} ${c.name.padEnd(26)} 應${want ? '放行' : '攔下'} → ${v || '（放行）'}`);
}
// 另外驗一條：requireWebsite 關掉時，沒官網也照樣放行（可隨時關閉）
{
  const finder = makeSiteFinder({ ...deps, fetchImpl: () => ({ ok: false, status: 404, text: async () => '' }), cfg: { siteDex: false } });
  const g2 = makeGate({ ...deps, cfg: { requireWebsite: false }, siteFind: (a) => finder(a, {}) });
  const v = await g2('0x' + '2'.repeat(40));
  const ok = v === '';
  if (!ok) bad++;
  console.log(`${ok ? '✅' : '❌'} ${'關掉規則（requireWebsite=false）'.padEnd(26)} 應放行 → ${v || '（放行）'}`);
}
console.log(bad ? `\n${bad} 個案例不符預期` : '\n全部符合預期');
process.exitCode = bad ? 1 : 0;
