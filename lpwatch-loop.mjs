// LP 事後驗證常駐迴圈（C 方案配套）
// 每 20 分鐘跑一次 lpwatch 的邏輯：對今天鑄造過的幣查 Pancake pair，
// 若已開池 → 讀 pair.totalSupply / balanceOf(0x…dEaD) / balanceOf(0x0)，
//   鎖倉 ≥95% 記 🔒；<95% 記 ⚠️ 並寫入 data/LP-ALERT.txt（項目方可抽池子）。
// 只做唯讀鏈上呼叫，不簽任何交易。
//
// 啟動（背景、不佔視窗）：
//   powershell -NoProfile -Command "Start-Process node -ArgumentList 'lpwatch-loop.mjs' -WorkingDirectory '<此目錄>' -WindowStyle Hidden"
// 停止：工作管理員結束 node（命令行含 lpwatch-loop.mjs），或 kill 對應 PID
//
// 日誌：data/lpwatch.log（追加）· 狀態：data/lpwatch.json
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, 'data', 'watch.log');
const OUT = join(HERE, 'data', 'lpwatch.log');
const ALERT = join(HERE, 'data', 'LP-ALERT.txt');
const STATE = join(HERE, 'data', 'lpwatch.json');
const FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const DEAD = '0x000000000000000000000000000000000000dead';
const ZERO = '0x0000000000000000000000000000000000000000';
const INTERVAL = Number(process.env.LPWATCH_INTERVAL_MS || 20 * 60e3);
const ONCE = process.argv.includes('--once');

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
const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
const say = (s) => { const line = `[${stamp()}] ${s}`; console.log(line); try { appendFileSync(OUT, line + '\r\n'); } catch {} };

async function pass() {
  const seen = new Set();
  for (const l of readFileSync(LOG, 'utf8').split(/\r?\n/)) {
    const m = l.match(/\[[^\]]+\]\s+(0x[a-fA-F0-9]{40})\s+🤖/);
    if (m) seen.add(m[1].toLowerCase());
  }
  const tokens = [...seen];
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  let checked = 0, withPair = 0, burned = 0, unburned = 0;
  const alerts = [];
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < tokens.length) {
      const t = tokens[i++];
      if (state[t] && state[t].pair !== undefined && state[t].locked) continue; // 已確認鎖死的不重查
      const pair = addrOf(await call(FACTORY, '0xe6a43905' + pad(t) + pad(WBNB)));
      checked++;
      if (!pair || /^0x0{40}$/.test(pair)) { state[t] = { at: Date.now(), pair: null }; continue; }
      withPair++;
      const ts = num(await call(pair, '0x18160ddd'));
      const bd = num(await call(pair, '0x70a08231' + pad(DEAD)));
      const bz = num(await call(pair, '0x70a08231' + pad(ZERO)));
      const pct = ts ? ((bd + bz) / ts) * 100 : 0;
      const ok = pct >= 95;
      if (ok) burned++; else { unburned++; alerts.push({ t, pair, pct }); }
      state[t] = { at: Date.now(), pair, totalSupply: ts, dead: bd, zero: bz, pct: Number(pct.toFixed(2)), locked: ok };
    }
  }));
  writeFileSync(STATE, JSON.stringify(state, null, 1));
  say(`掃 ${checked} 個：有池子 ${withPair}（鎖死 ${burned}、未鎖 ${unburned}），其餘 ${checked - withPair} 還沒開池`);
  if (alerts.length) {
    for (const a of alerts) say(`⚠️ LP 未鎖死 ${a.pct.toFixed(2)}%  ${a.t}  pair ${a.pair}`);
    try { appendFileSync(ALERT, alerts.map((a) => `[${stamp()}] ${a.t} pair=${a.pair} 死址鎖倉 ${a.pct.toFixed(2)}%`).join('\r\n') + '\r\n'); } catch {}
  }
  return { checked, withPair, burned, unburned };
}

say(`LP 看門狗啟動（每 ${Math.round(INTERVAL / 60e3)} 分鐘一輪；只讀鏈上、不簽交易）`);
for (;;) {
  try { await pass(); } catch (e) { say('本輪出錯：' + e.message); }
  if (ONCE) break;
  await new Promise((r) => setTimeout(r, INTERVAL));
}
