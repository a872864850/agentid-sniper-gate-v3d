// gate-window-test.mjs —— 驗證 v3d 的「退款期 1～10 天」規則真的會擋/會放
// 用假的合約位元碼（不碰鏈），測試 makeGate 的判斷路徑。
// 用法：node gate-window-test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeGate, GATE_VERSION } from './gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const wl = readFileSync(join(HERE, 'watch.mjs'), 'utf8').split(/\r?\n/);
const keccakHex = new Function(wl.slice(376, 395).join('\n') + '\nreturn keccakHex;')();
const sel = (s) => keccakHex(Buffer.from(s, 'utf8').toString('hex')).slice(0, 8);

// 假合約：有 refund()、無提款、無治理函式、總量 500；可選塞入「窗口常數」
function fakeCode({ days = null, units = 'sec', extra = '' } = {}) {
  let hex = '6080604052' + sel('refund()') + 'd5abeb01' + extra;
  if (days != null) {
    const v = units === 'sec' ? days * 86400 : days * 28800;
    hex += '62' + v.toString(16).padStart(6, '0');
  }
  return '0x' + hex.padEnd(400, '0');
}

const codeMap = new Map();
const deps = {
  call: async (to, data) => {
    const s = String(data).replace(/^0x/, '').slice(0, 8);
    if (s === 'd5abeb01') return '0x' + (500).toString(16).padStart(64, '0');
    if (s === sel('owner()')) return '0x' + '0'.repeat(64);
    return null;
  },
  codeOf: async (a) => codeMap.get(a) || '0x',
  fullCode: async (a, c) => c,
  keccakHex,
  cfg: {},
  log: () => {},
};

const cases = [
  ['退款期 3 天（秒）', { days: 3 }, ''],
  ['退款期 1 天（秒）', { days: 1 }, ''],
  ['退款期 7 天（秒）', { days: 7 }, ''],
  ['退款期 10 天（秒）', { days: 10 }, ''],
  ['退款期 30 天（超範圍）', { days: 30 }, '不在 1～10 天內'],
  ['退款期 20 天（超範圍）', { days: 20 }, '不在 1～10 天內'],
  ['1 天（區塊寫法）', { days: 1, units: 'block' }, ''],
  ['沒有窗口常數（auto 放行）', {}, ''],
];

let bad = 0;
console.log('GATE_VERSION =', GATE_VERSION);
for (const [name, opt, expect] of cases) {
  const addr = '0x' + String(1000 + cases.findIndex((c) => c[0] === name)).padStart(40, '0');
  codeMap.set(addr, fakeCode(opt));
  const gate = makeGate(deps); // 每個案例用新 gate，避免 30 分鐘快取
  const v = await gate(addr);
  const ok = expect ? v.includes(expect) : v === '';
  if (!ok) bad++;
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(24)} ${expect ? '應攔下' : '應放行'} → ${v || '（放行）'}`);
}
console.log(bad ? `\n${bad} 個案例不符預期` : '\n全部符合預期');
process.exitCode = bad ? 1 : 0;
