// Agent ID Sniper — 進場條件模組 v3（使用者 11/2 10:25 追加的「關鍵安全機制」）
//
// v2 的三條（10:14 版）保留：
//  1) 總量讀得到（數值不限）
//  2) 合約自己「打滿自動加 LP」：Router 位址 + addLiquidity(ETH) 選擇器
//  3) 沒有跑路後門
//
// v3 新增四條（10:25 使用者指定，對應一份已審計模板的行為）：
//  4) 退款機制：合約必須有買家自己呼叫的 refund()（3 天沒打滿 100% 退款，只燒 gas）
//     —— 位元碼要有 refund 選擇器；若有 3 天常數（259200）會額外記錄
//  5) LP 進死地址：位元碼要出現 0x…dEaD 常數（LP 直接鑄／送死址，沒人能抽池子）
//  6) 沒有提款函式：withdraw/rescue/sweep/emergencyWithdraw 一個都不能有
//  7) 管理權限上限 2 個、且只能是 pause 家族 + setMintStart 家族
//     —— 其餘（改稅、黑名單、改上限、手動開盤、換 Router、升級、改價、改 treasury）一律否決
//
// 全部 fail-closed：讀不到、看不出來 → 不打。回傳「不打」的理由字串；全過回傳 ''。
// watch.mjs 與 gate-backtest.mjs 共用本檔，正式邏輯與回測不會漂移。
//
// v3c（11/2 10:35 使用者選 C 方案）：關掉 ②「合約自己加 LP」與 ⑤「位元碼出現 LP 死址」兩條——
//   實測 250 個合約裡 ② 只有 1 個過、⑤ 0 個過（死址位址通常是建構子參數，不在 runtime bytecode，
//   事前掃不出來）。LP 改由 lpwatch.mjs 在「開池後」直接讀 pair 的 balanceOf(0x…dEaD) 事後驗證。
//   保留：①總量讀得到 ④退款入口 ⑥無提款函式 ⑦權限≤2（pause + setMintStart）。

// v3d（11/2 10:44 使用者追加）：退款窗口不強制 3 天，**1～10 天內都接受**；
//   另外把「refund() 只有選擇器」升級成「事後真實模擬」——refundprobe.mjs 會用 eth_call
//   從真的打過幣的錢包呼叫 refund()，看它回傳什麼，而不是只信位元碼裡有那 4 個位元組。
//
//   requireRefundWindow：'auto'（預設）= 位元碼若掃到窗口常數，就必須落在 1～10 天；
//                        掃不到不因此否決（改由 refundprobe 事後證明），
//                        true = 一定要掃到窗口且在範圍內（最嚴），false = 不看窗口。
//   refundWindowMinDays / refundWindowMaxDays = 1 / 10
//
// v3e（11/2 11:46 使用者追加）：**沒有官方網站的项目不打**。
//   官網判定不在本檔做（來源分散：位元碼字串／鏈上 getter／群裡傳的網址／DexScreener／人工白名單），
//   由 site.mjs 提供，watch.mjs 用 deps.siteFind 注入。本檔只負責：
//     requireWebsite=true 時，siteFind 說沒官網 → 攔下；沒接 siteFind（例如回測）→ 直接攔（fail-closed）。

export const GATE_VERSION = 'v3e';

export const GATE_DEFAULTS = {
  // v2
  requireCap: true,
  capMin: 5,
  capMax: 1e9,
  requireAutoLp: false,
  lpMode: 'off',
  denyBackdoor: true,
  requireRenouncedOwner: false,
  softAsBackdoor: false,
  // v3 安全機制
  requireRefund: true,          // 必須有買家退款入口（refund 類選擇器）
  requireRefundWindow: 'auto',  // 'auto' | true | false —— 見檔頭 v3d 說明
  refundWindowMinDays: 1,       // 使用者 11/2：退款期 1～10 天都算合格
  refundWindowMaxDays: 10,
  requireLpBurn: false,       // v3c 關閉：改由 lpwatch.mjs 開池後驗證
  requireNoWithdraw: true,    // 完全不允許提款函式
  maxAdminPerms: 2,           // 管理權限上限（pause 算 1、setMintStart 算 1）
  allowPause: true,           // pause／unpause／setPaused 允許（使用者明示許可）
  allowStartTime: true,       // setMintStart／setStartTime 允許（使用者明示許可）
  // v3e
  requireWebsite: false,      // 沒有官方網站就不打（預設關；watch.mjs 依 config 打開，回測不開）
};

const ROUTER_HEX = '10ed43c718714eb63d5aa57b78b54704e256024e'; // PancakeSwap V2 Router
const FACTORY_HEX = 'ca143ce32fe78f1f7019d7d551a6402fc5350c73'; // PancakeSwap V2 Factory
const WBNB_HEX = 'bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const DEAD_HEX = '000000000000000000000000000000000000dead';   // 0x…dEaD
const DAY_SEC = 86400;          // 1 天（秒）
const DAY_BLOCKS = 28800;       // BSC 3 秒一塊 → 1 天 = 28800 塊

// v3d：從位元碼掃「天數常數」，認得秒與 BSC 區塊兩種寫法（1～60 天，超出範圍的交給呼叫端判斷）
function detectRefundWindows(hex) {
  const bits = String(hex || '').replace(/^0x/, '');
  const map = new Map();
  const take = (v) => {
    if (!Number.isFinite(v) || v <= 0) return;
    if (v % DAY_SEC === 0 && v / DAY_SEC >= 1 && v / DAY_SEC <= 60) map.set('秒' + v / DAY_SEC, { unit: '秒', days: v / DAY_SEC });
    else if (v % DAY_BLOCKS === 0 && v / DAY_BLOCKS >= 1 && v / DAY_BLOCKS <= 60) map.set('塊' + v / DAY_BLOCKS, { unit: '區塊', days: v / DAY_BLOCKS });
  };
  for (const m of bits.matchAll(/62([0-9a-f]{6})/g)) take(parseInt(m[1], 16));
  for (const m of bits.matchAll(/63([0-9a-f]{8})/g)) take(parseInt(m[1], 16));
  return [...map.values()];
}
const LP_SELS = ['f305d719', 'e8e33700'];                       // addLiquidityETH / addLiquidity
const SIZE_SELS = ['d5abeb01', '32cb6b0c', '355274ea', 'e985e367', 'f1aee5a2', '0f2cdd6c',
  'a0e23ebd', 'd8f93498', 'c65b61ca', '3a98ef39', 'b6b6f0c3', 'cce132d1', '06517a29',
  '2163837f', 'aa2d9a02', '76c71ca1', '98f1312e', '85e3f997', 'cef6feda', '29b80536', '3a1d8d3a'];

// ⑥ 提款函式：能直接把合約裡的 BNB／代幣抽走（使用者要求「開盤前沒有提款函式」，這裡直接全禁）
const WITHDRAW_SIGS = [
  'withdraw()', 'withdraw(uint256)', 'withdrawETH()', 'withdrawETH(uint256)',
  'withdrawToken(address)', 'withdrawToken(address,uint256)', 'withdrawAll()',
  'emergencyWithdraw()', 'emergencyWithdraw(address)',
  'rescueToken(address)', 'rescueToken(address,uint256)', 'rescueETH()', 'rescueERC20(address,uint256)',
  'claimStuckTokens(address)', 'sweep(address)', 'sweep(address,uint256)', 'skim(address)',
];

// ④ 退款入口（買家自己呼叫）
const REFUND_SIGS = ['refund()', 'claimRefund()', 'refundAll()', 'refundUser(address)'];

// ⑦ 允許的兩組管理權限
const PERM_PAUSE = ['pause()', 'unpause()', 'setPaused(bool)'];
const PERM_START = ['setMintStart(uint256)', 'setStartTime(uint256)', 'setMintTime(uint256)', 'setMintStartTime(uint256)'];

// ⑦ 其餘管理／治理函式：出現就否決（v2 後門清單扣掉 pause 家族與 start 家族）
const DENY_SIGS = [
  'upgradeTo(address)', 'upgradeToAndCall(address,bytes)',
  'blacklist(address)', 'setBlacklist(address,bool)', 'addBlacklist(address)', 'removeBlacklist(address)',
  'setBot(address,bool)', 'setBots(address,bool)', 'setBots(address[],bool)',
  'setTax(uint256)', 'setFee(uint256)', 'setBuyTax(uint256)', 'setSellTax(uint256)',
  'setFees(uint256,uint256)', 'setBuyFee(uint256)', 'setSellFee(uint256)',
  'setMaxTxAmount(uint256)', 'setMaxWalletAmount(uint256)', 'setLimits(uint256,uint256)',
  'setMaxTx(uint256)', 'setMaxWallet(uint256)', 'setCooldown(uint256)',
  'setMaxSupply(uint256)', 'setMintPrice(uint256)', 'setPrice(uint256)', 'setCost(uint256)',
  'enableTrading()', 'openTrading()', 'setTradingOpen(bool)', 'setTrading(bool)',
  'setRouter(address)', 'setPool(address)', 'setMarketPair(address)', 'setPair(address)',
  'setSwapEnabled(bool)', 'migrate(address)', 'setFeeReceiver(address)', 'setMarketingWallet(address)',
  'setTreasury(address)', 'setDevWallet(address)', 'setTeamWallet(address)',
  'setMintStart(uint64)', 'setSaleStart(uint256)', 'setEndTime(uint256)',
];

// 次要（不直接抽資金，但能改規則）：預設只記錄
const SOFT_SIGS = [
  'setBaseURI(string)', 'setTokenURI(uint256,string)',
  'excludeFromFee(address)', 'setExcludedFromFee(address,bool)',
  'setWhitelist(address,bool)', 'addWhitelist(address)', 'setAirdrop(address)',
  'transferOwnership(address)', 'renounceOwnership()',
];

/**
 * @param deps.call       (to, data) => Promise<string|null>
 * @param deps.codeOf     (addr) => Promise<string>
 * @param deps.fullCode   (addr, code) => Promise<string>
 * @param deps.keccakHex  (hexString) => string
 * @param deps.cfg        覆寫 GATE_DEFAULTS
 * @param deps.siteFind   (addr) => Promise<{ok,host,src,why}> —— 官網檢查（site.mjs），requireWebsite 時必備
 * @param deps.log        logger
 */
export function makeGate(deps) {
  const { call, codeOf, fullCode, keccakHex, siteFind = null, log = () => {} } = deps;
  const cfg = { ...GATE_DEFAULTS, ...(deps.cfg || {}) };
  const sel = (s) => keccakHex(Buffer.from(s, 'utf8').toString('hex')).slice(0, 8);
  const map = (arr) => arr.map((s) => [sel(s), s]);
  const withdrawMap = map(WITHDRAW_SIGS);
  const refundMap = map(REFUND_SIGS);
  const denyMap = map(DENY_SIGS);
  const pauseMap = map(PERM_PAUSE);
  const startMap = map(PERM_START);
  const softMap = map(SOFT_SIGS);
  const cache = new Map();

  async function readSizes(addr, code) {
    const out = [];
    for (const s of SIZE_SELS) {
      if (!code.includes(s)) continue;
      const r = await call(addr, '0x' + s).catch(() => null);
      if (!r || r.length < 66) continue;
      let x = Number(BigInt(r.slice(0, 66)));
      if (!Number.isFinite(x) || x <= 0) continue;
      if (x % 1e18 === 0 && x / 1e18 >= 1 && x / 1e18 <= 1e9) x = x / 1e18;
      if (Number.isInteger(x) && x >= cfg.capMin && x <= cfg.capMax) out.push(x);
    }
    return [...new Set(out)];
  }

  const found = (code, m) => m.filter(([s]) => code.includes(s)).map(([, n]) => n);

  async function inspect(addr) {
    const key = String(addr).toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < 30 * 60e3) return hit;

    const base = ((await codeOf(key).catch(() => '')) || '').toLowerCase();
    if (!base || base === '0x' || base.length < 10) {
      const rec = { t: Date.now(), v: '讀不到合約位元碼，不打', info: { noCode: true } };
      cache.set(key, rec); return rec;
    }
    const code = (await fullCode(key, base).catch(() => base)).toLowerCase();
    const info = { addr: key, len: code.length };

    // ① 總量
    const sizes = await readSizes(key, code);
    info.sizes = sizes;
    info.capOk = sizes.length > 0;

    // ② 打滿自動加 LP
    info.router = code.includes(ROUTER_HEX);
    info.factory = code.includes(FACTORY_HEX);
    info.wbnb = code.includes(WBNB_HEX);
    info.lpSels = LP_SELS.filter((s) => code.includes(s));
    info.lpOk = cfg.lpMode === 'loose'
      ? (info.router || info.factory) && info.lpSels.length > 0
      : info.router && info.lpSels.length > 0;

    // ④ 退款機制（v3d：窗口 1～10 天都接受，3 天不再寫死）
    info.refunds = found(code, refundMap);
    info.refundSels = refundMap.filter(([s]) => code.includes(s)).map(([s, n]) => ({ sel: '0x' + s, name: n }));
    info.refundWins = detectRefundWindows(code);
    info.refundWinDays = [...new Set(info.refundWins.map((w) => w.days))].sort((a, b) => a - b);
    info.refundWin = info.refundWinDays.length > 0;
    info.refundWinOk = info.refundWin && info.refundWinDays.some((d) => d >= cfg.refundWindowMinDays && d <= cfg.refundWindowMaxDays);
    info.refundWinMode = cfg.requireRefundWindow;
    info.refundOk = info.refunds.length > 0 && (cfg.requireRefundWindow === true ? info.refundWinOk : true);

    // ⑤ LP 送死地址
    info.dead = code.includes(DEAD_HEX);
    info.lpBurnOk = info.dead;

    // ⑥ 提款函式
    info.withdraws = found(code, withdrawMap);
    info.noWithdrawOk = info.withdraws.length === 0;

    // ⑦ 管理權限：只允許 pause 家族 + setMintStart 家族，最多 maxAdminPerms 個
    const pPause = found(code, pauseMap);
    const pStart = found(code, startMap);
    info.permPause = pPause;
    info.permStart = pStart;
    info.denyPerms = found(code, denyMap);
    info.softs = found(code, softMap);
    const allowed = (cfg.allowPause ? 1 : 0) * (pPause.length ? 1 : 0)
      + (cfg.allowStartTime ? 1 : 0) * (pStart.length ? 1 : 0);
    info.permCount = allowed;
    info.adminOk = info.denyPerms.length === 0 && allowed <= cfg.maxAdminPerms;

    // 後門 = 提款 + 否決清單（v2 相容欄位）
    info.backdoors = info.withdraws.concat(info.denyPerms);
    info.permClean = info.adminOk && info.noWithdrawOk;

    const o = await call(key, '0x8da5cb5b').catch(() => null); // owner()
    info.owner = o && o.length >= 66 && !/^0x0{64}$/i.test(o) ? '0x' + o.slice(26, 66) : null;
    info.ownerOk = !cfg.requireRenouncedOwner || !info.owner;

    // 先把「便宜」的條件算完（位元碼／鏈上讀數），再決定要不要花時間查官網
    const fails = [];
    if (cfg.requireCap && !info.capOk) fails.push('讀不到合約總量（打滿沒有依據）');
    if (cfg.requireAutoLp && !info.lpOk) {
      fails.push(!info.router && !info.factory
        ? '合約裡沒有 PancakeSwap Router／Factory，不是「打滿自動加 LP」那種類型'
        : '有 Router 但沒有 addLiquidity，加 LP 交給外部合約做');
    }
    if (cfg.requireRefund && !info.refundOk) {
      fails.push(cfg.requireRefundWindow === true && info.refunds.length
        ? `有 refund() 但掃不到 ${cfg.refundWindowMinDays}～${cfg.refundWindowMaxDays} 天的退款期常數`
        : '沒有買家退款入口（refund），打不滿無法退錢');
    }
    if (cfg.requireRefund && cfg.requireRefundWindow === 'auto' && info.refundWin && !info.refundWinOk) {
      fails.push(`退款期 ${info.refundWinDays.join('/')} 天，不在 ${cfg.refundWindowMinDays}～${cfg.refundWindowMaxDays} 天內`);
    }
    if (cfg.requireLpBurn && !info.lpBurnOk) fails.push('看不到 LP 送死地址（0x…dEaD），池子可被抽走');
    if (cfg.requireNoWithdraw && !info.noWithdrawOk) {
      fails.push(`有提款函式（${info.withdraws.slice(0, 3).join('、')}${info.withdraws.length > 3 ? ' 等 ' + info.withdraws.length + ' 個' : ''}）`);
    }
    if (!info.adminOk) {
      fails.push(info.denyPerms.length
        ? `有超出許可的管理權限（${info.denyPerms.slice(0, 3).join('、')}${info.denyPerms.length > 3 ? ' 等 ' + info.denyPerms.length + ' 個' : ''}）`
        : `管理權限 ${allowed} 個，超過上限 ${cfg.maxAdminPerms}`);
    }
    if (cfg.denyBackdoor && !info.permClean && !fails.length) fails.push('有跑路後門');
    if (!info.ownerOk) fails.push(`合約還有 owner（${info.owner.slice(0, 10)}…），不是放棄所有權`);

    // v3e ⑧：官方網站（前面幾條都過了才查，省掉對註定要攔的合約發 HTTP）
    info.site = null; info.siteWhy = '';
    if (cfg.requireWebsite) {
      if (fails.length) info.siteWhy = '其他條件先沒過，未查官網';
      else if (typeof siteFind !== 'function') info.siteWhy = '官網檢查未接線';
      else {
        try {
          const st = await siteFind(key);
          info.site = st && st.ok ? { host: st.host, url: st.url, src: st.src } : null;
          info.siteWhy = (st && st.why) || '查不到官網';
        } catch (e) { info.site = null; info.siteWhy = '官網檢查出錯：' + String(e.message || e).slice(0, 60); }
      }
      if (!info.site) fails.push(`看不到官方網站（${info.siteWhy || '沒有'}），沒有官網的項目不打`);
    }

    const rec = { t: Date.now(), v: fails.length ? fails.join('；') + '，不打' : '', info };
    cache.set(key, rec);
    if (!rec.v) {
      const bits = [`總量 ${sizes.join('/')}`];
      if (cfg.requireAutoLp) bits.push(`自動加LP ${info.lpOk ? '✅' : '❌'}`);
      else if (info.router && info.lpSels.length) bits.push('自動加LP（合約內建，未強制）');
      else bits.push('自動加LP（不檢查，開池後由 lpwatch 驗）');
      if (cfg.requireRefund) bits.push(`refund ${info.refunds[0]}${info.refundWin
        ? `+窗口 ${info.refundWinDays.join('/')} 天${info.refundWinOk ? '' : '（超範圍）'}`
        : '（窗口未掃到，事後探測）'}`);
      if (cfg.requireLpBurn) bits.push(`LP 死址 ${info.lpBurnOk ? '✅' : '❌'}`);
      bits.push(`提款 ${info.withdraws.length}`);
      bits.push(`權限 ${info.permPause.join('/') || '無'}${info.permStart.length ? '+' + info.permStart.join('/') : ''}`);
      if (cfg.requireWebsite && info.site) bits.push(`官網 ${info.site.host}（${info.site.src}）`);
      log(`[gate ${GATE_VERSION}] 進場條件通過：${key} ` + bits.join(' · ')
        + (info.softs.length ? ` · 次要函式 ${info.softs.slice(0, 3).join('/')}` : ''));
    }
    return rec;
  }

  async function launchGate(addr) {
    const r = await inspect(addr);
    return r.v || '';
  }
  launchGate.inspect = inspect;
  launchGate.cfg = cfg;
  return launchGate;
}
export { detectRefundWindows };
