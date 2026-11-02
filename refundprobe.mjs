// refundprobe.mjs —— 「退款入口」的真實證明（gate v3d 配套，使用者 11/2 10:44「補上」）
//
// 為什麼需要這支：gate.mjs 只驗到「位元碼裡有 refund 的 4 位元組選擇器」。選擇器可以被寫進
// 合約卻永遠 revert（假入口），也可以只有 owner 能呼叫。這支改用真實 eth_call 呼叫，看鏈上
// 實際回什麼，並且用「不存在的選擇器」做對照組：
//
//   對照組 0xdeadbeef → 若它和 refund() 回一樣的空 revert，代表這個合約的 revert 不帶資訊，
//                       判定為「不可判定」，不假裝通過。
//
// 分類（只有 A/B/C 才算入口有效）：
//   ✅ 可退          eth_call 成功（合約現在就願意退）
//   ⏳ 帶原因        revert 帶人類可讀原因（未到期／沒有可退額／非參與者）
//   ⏳ 自訂錯誤      revert 帶 4 位元組 custom error（並嘗試比對已知錯誤名）
//   ⚠️ 不可判定      空 revert，且對照組也空 → 分不出真假入口
//   ⚠️ 限流          節點限流，多節點重試後仍失敗
//   ❌ 沒有入口       位元碼沒有 refund 類選擇器
//
// 用法：
//   node refundprobe.mjs                跑一次，印表格 + 寫 data/refund-probe.json
//   node refundprobe.mjs --limit 40     只看最近 40 筆鑄造
//   node refundprobe.mjs --watch        常駐（預設 30 分鐘一輪，REFUNDPROBE_INTERVAL_MS 可改）
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGF = join(HERE, 'data', 'watch.log');
const OUTJ = join(HERE, 'data', 'refund-probe.json');
const OUTL = join(HERE, 'data', 'refund-probe.log');
const CFGF = join(HERE, 'config.json');

const argv = process.argv.slice(2);
const LIMIT = Number(argv[argv.indexOf('--limit') + 1] || 0) || 40;
const WATCH = argv.includes('--watch');
const INTERVAL = Number(process.env.REFUNDPROBE_INTERVAL_MS || 30 * 60e3);
const GAP_MS = Number(process.env.REFUNDPROBE_GAP_MS || 220); // 每次 eth_call 之間的間隔，避免被節點限流

const RPCS = [
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc.publicnode.com',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
];
let ri = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (s) => /rate limit|too many|capacity|exceeded|busy|try again/i.test(String(s || ''));

async function rpc(method, params) {
  let lastErr = null;
  for (let k = 0; k < RPCS.length * 2; k++) {
    const u = RPCS[ri++ % RPCS.length];
    try {
      const r = await fetch(u, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      if (j.result !== undefined) return { ok: true, result: j.result };
      if (j.error) {
        lastErr = j.error;
        if (isRateLimit(j.error.message)) { await sleep(400 + k * 200); continue; }
        return { ok: false, error: j.error };
      }
    } catch (e) { lastErr = { message: e.message }; }
    await sleep(300);
  }
  return { ok: false, error: lastErr || { message: 'rpc failed' }, exhausted: true };
}
const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
const say = (s) => { const line = `[${stamp()}] ${s}`; console.log(line); try { appendFileSync(OUTL, line + '\r\n'); } catch {} };

// keccak 借用 watch.mjs 那一份（第 377–395 行），確保選擇器算得跟正式邏輯一致
const wl = readFileSync(join(HERE, 'watch.mjs'), 'utf8').split(/\r?\n/);
const keccakHex = new Function(wl.slice(376, 395).join('\n') + '\nreturn keccakHex;')();
if (keccakHex('') !== 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') throw new Error('keccak 抽取失敗');
const selOf = (sig) => '0x' + keccakHex(Buffer.from(sig, 'utf8').toString('hex')).slice(0, 8);

const REFUND_SIGS = ['refund()', 'claimRefund()', 'refundAll()', 'refundUser(address)'];
const refundSels = REFUND_SIGS.map((s) => ({ name: s, sel: selOf(s) }));
const CTRL = { name: '對照組(不存在)', sel: '0xdeadbeef' };

// 常見自訂錯誤：拿來把 0x13112018 這種代碼翻成人話
const ERR_NAMES = [
  'NotEnded()', 'SaleNotEnded()', 'NotStarted()', 'SaleNotStarted()', 'TooEarly()',
  'NothingToRefund()', 'NoRefund()', 'NotRefundable()', 'RefundNotAvailable()',
  'NotParticipant()', 'NotOwner()', 'OwnableUnauthorizedAccount(address)', 'NotRefunding()',
  'RefundPeriodOver()', 'RefundClosed()', 'AlreadyRefunded()', 'NotEnoughEth()', 'SoldOut()',
  'ExceedsMaxSupply()', 'InvalidTime()', 'MintNotActive()', 'NotWhitelisted()',
];
const ERR_MAP = new Map(ERR_NAMES.map((n) => [selOf(n).slice(2), n]));

function reasonOf(err) {
  const msg = String(err?.message || '');
  const m = msg.match(/execution reverted:?\s*(.*)$/i);
  return m ? m[1].trim() : '';
}
// revert 原因清洗：控制字元、空白、單獨的 "0x" 都算「沒有原因」
function norm(s) {
  const t = String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (t === '' || t === '0x' || t === 'execution reverted') ? '' : t;
}

function classify(res, ctrl) {
  if (res.ok) return { level: 'ok', label: '✅ 可退', detail: `回傳 ${String(res.result || '0x').slice(0, 20)}` };
  if (res.exhausted || isRateLimit(res.error?.message)) return { level: 'ratelimit', label: '⚠️ 限流', detail: '多節點重試仍失敗' };
  const reason = norm(reasonOf(res.error));
  if (reason && !reason.startsWith('0x')) return { level: 'valid', label: '⏳ 帶原因', detail: reason.slice(0, 90) };
  if (/^0x[0-9a-fA-F]{8}/.test(reason)) {
    const s = reason.slice(0, 10).toLowerCase().slice(2);
    return { level: 'valid', label: '⏳ 自訂錯誤', detail: `${reason.slice(0, 10)}${ERR_MAP.has(s) ? ' = ' + ERR_MAP.get(s) : ''}` };
  }
  const ctrlReason = ctrl && !ctrl.ok ? norm(reasonOf(ctrl.error)) : '';
  if (!reason && !ctrlReason) return { level: 'unknown', label: '⚠️ 不可判定', detail: 'refund 與對照組都是空 revert' };
  if (!reason && ctrlReason) return { level: 'unknown', label: '⚠️ 空 revert', detail: `對照組有原因：${ctrlReason.slice(0, 50)}` };
  return { level: 'unknown', label: '⚠️ 空 revert', detail: '沒有原因字串' };
}

const codeCache = new Map();
async function codeOf(a) {
  const k = String(a).toLowerCase();
  if (!codeCache.has(k)) { const r = await rpc('eth_getCode', [k, 'latest']); codeCache.set(k, String(r.ok ? r.result : '').toLowerCase()); }
  return codeCache.get(k);
}

function loadTargets() {
  const cfg = JSON.parse(readFileSync(CFGF, 'utf8').replace(/^\uFEFF/, ''));
  const name2addr = {};
  for (const w of cfg.wallets || []) name2addr[w.name] = String(w.address).toLowerCase();
  let lines = [];
  try { lines = readFileSync(LOGF, 'utf8').split(/\r?\n/); } catch { return { targets: [] }; }
  const seen = new Set(); const targets = [];
  for (const l of lines) {
    const m = l.match(/^\[[^\]]+\]\s+\[([^\]]+)\]\s+(0x[a-fA-F0-9]{40})\s+🤖/);
    if (!m) continue;
    const tok = m[2].toLowerCase(); const wname = m[1];
    const key = tok + '|' + wname;
    if (seen.has(key)) continue; seen.add(key);
    targets.push({ tok, wallet: name2addr[wname] || null, walletName: wname });
  }
  return { targets };
}

async function pass() {
  const { targets } = loadTargets();
  const pick = targets.slice(-LIMIT);
  const rows = [];
  for (const t of pick) {
    const code = await codeOf(t.tok);
    await sleep(GAP_MS);
    if (!code || code.length < 10) { rows.push({ ...t, label: '❌ 沒有入口', level: 'none', detail: '讀不到位元碼' }); continue; }
    const bits = code.replace(/^0x/, '');
    const present = refundSels.filter((r) => bits.includes(r.sel.slice(2)));
    if (!present.length) { rows.push({ ...t, label: '❌ 沒有入口', level: 'none', detail: '位元碼沒有 refund 選擇器' }); continue; }
    if (!t.wallet) { rows.push({ ...t, label: '⚠️ 跳過', level: 'unknown', detail: '找不到錢包地址對應' }); continue; }
    const used = present[0];
    const res = await rpc('eth_call', [{ from: t.wallet, to: t.tok, data: used.sel }, 'latest']);
    await sleep(GAP_MS);
    const ctrl = await rpc('eth_call', [{ from: t.wallet, to: t.tok, data: CTRL.sel }, 'latest']);
    await sleep(GAP_MS);
    const c = classify(res, ctrl);
    rows.push({ ...t, sel: used.name, label: c.label, level: c.level, detail: c.detail });
  }
  const by = {};
  for (const r of rows) by[r.label] = (by[r.label] || 0) + 1;
  say(`探測 ${rows.length} 筆（真實錢包 eth_call 呼叫 refund()，每筆附 0xdeadbeef 對照組）`);
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) say(`  ${k}  ${v}`);
  const bad = rows.filter((x) => x.level !== 'ok' && x.level !== 'valid');
  for (const r of bad.slice(0, 12)) say(`  ${r.label}  ${r.tok}  ${r.walletName}  ${r.detail || ''}`);
  const good = rows.filter((r) => r.level === 'ok' || r.level === 'valid');
  writeFileSync(OUTJ, JSON.stringify({ at: Date.now(), total: rows.length, valid: good.length, by, rows }, null, 1));
  say(`可退／入口有效 ${good.length}/${rows.length}；結果寫入 data/refund-probe.json`);
  return { rows, by, valid: good.length };
}

if (WATCH) {
  say(`退款探測常駐（每 ${Math.round(INTERVAL / 60e3)} 分鐘；只 eth_call、不簽交易）`);
  for (;;) { try { await pass(); } catch (e) { say('本輪出錯：' + e.message); } await sleep(INTERVAL); }
} else {
  await pass();
}
