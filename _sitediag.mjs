// 偵察：最近通過閘門的項目長什麼樣、有沒有官網線索（狀態檔／DexScreener／鏈上位元碼）
import { readFileSync, existsSync } from 'node:fs';

const log = readFileSync('data/watch.log', 'utf8').split(/\r?\n/);
const pass = log.filter((l) => /進場條件通過/.test(l)).slice(-8);
console.log('=== 最近閘門通過 ===');
for (const l of pass) console.log(l.slice(0, 220));

console.log('\n=== 最近自動鑄造 ===');
for (const l of log.filter((l) => /已自動鑄造/.test(l)).slice(-6)) console.log(l.slice(0, 200));

const S = JSON.parse(readFileSync('data/watch_state.json', 'utf8'));
const paid = Object.entries(S.paid || {});
console.log('\n追蹤項目 total =', paid.length);
const withUrl = paid.filter(([, P]) => P.fromUrl);
const withGroups = paid.filter(([, P]) => P.fromGroups || P.fromCall);
console.log('有 fromUrl（群裡傳的網址） =', withUrl.length, withUrl.slice(0, 5).map(([c, P]) => c + ' ← ' + P.fromUrl));
console.log('有 fromGroups/fromCall =', withGroups.length);
const doneFree = paid.filter(([, P]) => P.done && Object.values(P.done).includes('free'));
console.log('真的打過的 =', doneFree.length);
console.log('打過且有 fromUrl =', doneFree.filter(([, P]) => P.fromUrl).length);

// DexScreener：有沒有代幣資料（會帶 websites / socials）
export {};
const addrs = doneFree.slice(-6).map(([c]) => c);
for (const a of addrs) {
  try {
    const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + a, { signal: AbortSignal.timeout(12000) })).json();
    const pair = (j.pairs || [])[0];
    const info = pair?.info || null;
    console.log(`\n${a} pairs=${(j.pairs || []).length} base=${pair?.baseToken?.symbol || '-'} websites=${JSON.stringify((info?.websites || []).map((w) => w.url))} socials=${JSON.stringify((info?.socials || []).map((w) => w.type + ':' + w.url))} name=${pair?.baseToken?.name || '-'}`);
  } catch (e) { console.log(a, 'dexscreener err', e.message); }
}
