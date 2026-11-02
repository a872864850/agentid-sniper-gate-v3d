// site.mjs —— 「官方網站」檢查模組（使用者 11/2 11:46：沒有官方網站的项目就不打）
//
// 為什麼要單獨一支：官網資訊不在合約的「總量／refund／權限」那一套判斷裡，
// 而且來源分散（位元碼字串、鏈上 getter、群裡傳的網址、DexScreener、人工白名單），
// 全部塞進 gate.mjs 會讓那支變得太肥、也讓回測變慢。這裡只做「有沒有官網」。
//
// 判定順序（找到就停，先便宜後貴）：
//   ① 人工白名單 data/site_allow.txt（一行一個合約地址或網域）——使用者自己認可的
//   ② 群裡傳的網址對到這個合約（watch.mjs 的 S.paid[c].fromUrl / fromGroups）——群友已經在傳的官網
//   ③ 合約位元碼裡的網址字串（https://… / xxx.xyz …）
//   ④ 鏈上 getter：website() / site() / url() / homepage() / officialSite() / socials() / info() …
//   ⑤ DexScreener 的代幣資料（info.websites）——只有開池後才有，事後補
//   找到網址後（siteVerify）再開一次首頁確認「打得開」且「頁面有提到這個幣」，
//   打不開或完全沒提到 → 當作沒有官網（假官網／死網址一樣不打）。
//
// 全部 fail-closed：看不到、打不開、看不出關聯 → 沒官網，不打。

export const SITE_VERSION = 'v1';

export const SITE_DEFAULTS = {
  requireWebsite: true,   // 沒有官網就不打
  siteVerify: true,       // 找到網址要真的打得開，且頁面有提到這個幣
  siteDex: true,          // 額外查 DexScreener（開池後才有；沒開池等於沒有）
  siteTimeoutMs: 8000,    // 抓官網首頁的逾時
};

// 這些不是「項目自己的官網」：交易所／瀏覽器／社群平台／發射台（跟 URL_SKIP 同一個思路）
const NOT_OFFICIAL = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.(org|me)|discord\.(gg|com)|facebook\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|medium\.com|mirror\.xyz|linktr\.ee|bit\.ly|tinyurl\.com|bscscan\.com|etherscan\.io|basescan\.org|arbiscan\.io|tronscan\.org|dexscreener\.com|geckoterminal\.com|coingecko\.com|coinmarketcap\.com|dexscreener\.com|dextools\.io|ave\.ai|gmgn\.ai|debot\.ai|xxyy\.io|pancakeswap\.finance|flap\.sh|four\.meme|pump\.fun|binance\.(com|us|info)|bnbchain\.org|okx\.com|bitget\.com|debank\.com|github\.com|gitbook\.io|notion\.(so|site)|docs\.google\.com|reddit\.com|weibo\.com|bilibili\.com|google\.com|apple\.com|claude\.ai|openai\.com|chatgpt\.com|axiom\.trade|bullx\.io|poocoin\.app|birdeye\.so|solscan\.io|web3\.okx\.com|cloudflare\.com|gstatic\.com|googleapis\.com|jsdelivr\.net|unpkg\.com)$/i;

// 常見「官方網站」getter（keccak 由外部傳入，跟 gate.mjs 共用同一套實作）
const GETTER_SIGS = [
  'website()', 'site()', 'url()', 'homepage()', 'officialSite()', 'webSite()', 'websiteUrl()', 'siteUrl()',
  'getWebsite()', 'getSite()', 'info()', 'socials()', 'description()', 'projectUrl()', 'officialUrl()',
];

const TLD = /\.(xyz|com|fun|io|app|site|ai|finance|org|net|pro|club|live|link|cc|me|world|tech|money|gg|top|vip|online|meme|dev|xyz|so|to|in|co|finance|exchange|market|lol|wtf|art|space|store|website|page|cloud|tools|network|digital|game|games|xyz)$/i;

/** 把位元碼 hex 轉成可讀 ASCII（非可列印字元變空白），再抽網址／網域 */
export function asciiOf(hex) {
  const s = String(hex || '').replace(/^0x/, ''); const ch = [];
  for (let i = 0; i + 2 <= s.length; i += 2) { const b = parseInt(s.slice(i, i + 2), 16); ch.push(b >= 32 && b < 127 ? String.fromCharCode(b) : ' '); }
  return ch.join('');
}
export function urlsInText(txt) {
  const out = new Set(); const t = String(txt || '');
  for (const m of t.matchAll(/https?:\/\/[a-zA-Z0-9._\-\/%?=&#+:]+/g)) out.add(m[0].replace(/[.,;:'")]+$/, ''));
  for (const m of t.matchAll(/(?<![a-z0-9@._-])(?:www\.)?[a-z0-9][a-z0-9-]{1,30}(?:\.[a-z0-9-]{1,30})?\.([a-z]{2,12})(?![a-z0-9._-])/gi)) {
    const host = m[0].toLowerCase().replace(/^www\./, '');
    if (TLD.test(host)) out.add(host);
  }
  return [...out];
}
export function hostOf(u) {
  try {
    const s = String(u || '').trim();
    const url = /^https?:\/\//i.test(s) ? s : 'https://' + s;
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return h.includes('.') ? { host: h, url: 'https://' + h + '/' } : null;
  } catch { return null; }
}
export function isOfficialHost(host) { return !!host && host.includes('.') && !NOT_OFFICIAL.test(host); }

function decStr(r) { // ABI 回傳的 string
  if (!r || r.length < 130) return '';
  try {
    const x = String(r).slice(2); const len = Number(BigInt('0x' + x.slice(64, 128)));
    if (!(len > 0 && len < 500)) return '';
    return Buffer.from(x.slice(128, 128 + len * 2), 'hex').toString('utf8');
  } catch { return ''; }
}

/**
 * @param deps.call      (to,data)=>Promise<string|null>
 * @param deps.codeOf    (addr)=>Promise<string>
 * @param deps.fullCode  (addr,code)=>Promise<string>
 * @param deps.keccakHex (hex)=>string
 * @param deps.fetchImpl 測試用，可注入假 fetch
 * @param deps.cfg       覆寫 SITE_DEFAULTS
 * @param deps.log
 */
export function makeSiteFinder(deps) {
  const { call, codeOf, fullCode, keccakHex, log = () => {} } = deps;
  const cfg = { ...SITE_DEFAULTS, ...(deps.cfg || {}) };
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sel = (s) => keccakHex(Buffer.from(s, 'utf8').toString('hex')).slice(0, 8);
  const getters = GETTER_SIGS.map((s) => [sel(s), s]);
  const cache = new Map();
  const hostCache = new Map();

  async function verify(site, ctx) {
    if (!cfg.siteVerify) return { ok: true, why: '未驗證（siteVerify=false）' };
    const key = site.host + '|' + (ctx.hint || '');
    if (hostCache.has(key)) return hostCache.get(key);
    let verdict = { ok: false, why: '首頁打不開' };
    try {
      const r = await fetchImpl(site.url, { headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'follow', signal: AbortSignal.timeout(cfg.siteTimeoutMs) });
      const html = r.ok ? String(await r.text()).slice(0, 400000) : '';
      if (!r.ok) verdict = { ok: false, why: '首頁 HTTP ' + r.status };
      else {
        const low = html.toLowerCase();
        const name = String(ctx.name || '').toLowerCase().trim();
        const sym = String(ctx.symbol || '').toLowerCase().trim();
        const addr = String(ctx.addr || '').toLowerCase();
        const hit = (sym && sym.length >= 2 && low.includes(sym))
          || (name && name.length >= 3 && low.includes(name))
          || (addr && low.includes(addr)) || (addr && low.includes(addr.slice(2)));
        verdict = hit ? { ok: true, why: '首頁打得開且提到這個幣' } : { ok: false, why: '首頁打得開但完全沒提到這個幣（可能是假官網）' };
      }
    } catch (e) { verdict = { ok: false, why: '首頁打不開（' + String(e.message || e).slice(0, 40) + '）' }; }
    hostCache.set(key, verdict);
    return verdict;
  }

  /**
   * @param addr 合約地址
   * @param ctx  { allow:Set<string>, extra:string|string[], name, symbol }
   * @returns {ok, host, url, src, why, candidates}
   */
  async function find(addr, ctx = {}) {
    const a = String(addr).toLowerCase();
    const key = a + '|' + (ctx.name || '');
    const hit = cache.get(key); if (hit && Date.now() - hit.t < 10 * 60e3) return hit.r;
    const allow = ctx.allow instanceof Set ? ctx.allow : new Set(ctx.allow || []);
    const cands = []; const add = (raw, src) => { const h = hostOf(raw); if (!h || !isOfficialHost(h.host)) return; if (!cands.some((c) => c.host === h.host)) cands.push({ ...h, src }); };

    // ① 人工白名單：直接認可（不再驗證）
    for (const k of allow) { const al = String(k).toLowerCase(); if (al === a) { const r = { t: Date.now(), r: { ok: true, host: '(白名單)', url: '', src: 'allow', why: '使用者在 data/site_allow.txt 認可' } }; cache.set(key, r); return r.r; } }

    // ② 群裡傳的網址 / 已記錄的官網
    for (const u of [].concat(ctx.extra || [])) add(u, 'group');

    // ③④ 位元碼字串 + 鏈上 getter
    if (!cands.length) {
      const base = String((await codeOf(a).catch(() => '')) || '');
      const code = base && base !== '0x' ? String((await fullCode(a, base).catch(() => base)) || base) : '';
      if (code && code.length > 2) {
        for (const u of urlsInText(asciiOf(code))) add(u, 'code');
        if (!cands.length) for (const [s, n] of getters) {
          if (!code.toLowerCase().includes(s)) continue;
          const r = await call(a, '0x' + s).catch(() => null);
          const txt = decStr(r); if (!txt) continue;
          for (const u of urlsInText(txt)) add(u, 'getter:' + n);
        }
      }
    }

    // ⑤ DexScreener（開池後才有 websites）
    if (cfg.siteDex && !cands.length) {
      try {
        const j = await (await fetchImpl('https://api.dexscreener.com/latest/dex/tokens/' + a, { signal: AbortSignal.timeout(cfg.siteTimeoutMs) })).json();
        for (const p of (j.pairs || []).slice(0, 3)) for (const w of (p.info?.websites || [])) add(w.url, 'dexscreener');
      } catch {}
    }

    let out = { ok: false, host: '', url: '', src: '', why: cands.length ? '有網址但沒一個通過驗證' : '合約裡看不到任何官網網址', candidates: cands.slice(0, 5) };
    for (const c of cands) {
      // 白名單裡的網域：使用者已認可，不再驗證
      if (allow.has(c.host)) { out = { ok: true, host: c.host, url: c.url, src: 'allow:' + c.src, why: '使用者在 data/site_allow.txt 認可這個網域', candidates: cands.slice(0, 5) }; break; }
      const v = await verify(c, { name: ctx.name, symbol: ctx.symbol, addr: a, hint: a });
      if (v.ok) { out = { ok: true, host: c.host, url: c.url, src: c.src, why: v.why, candidates: cands.slice(0, 5) }; break; }
      out.why = c.host + '：' + v.why;
    }
    cache.set(key, { t: Date.now(), r: out });
    if (out.ok) log(`[site ${SITE_VERSION}] ${a} 官網 ${out.host}（${out.src}，${out.why}）`);
    return out;
  }

  find.cfg = cfg;
  find.inspect = find;
  return find;
}
export { GETTER_SIGS };
