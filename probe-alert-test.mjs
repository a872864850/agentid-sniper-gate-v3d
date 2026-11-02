// probe-alert-test.mjs —— 退款探測「變化告警」的離線單元測試（不碰 BSC、不碰真 Telegram）
//
// 測兩層：
//   A. probe-diff.mjs 的純邏輯（哪種轉折該告警、哪種不該、會不會重複吵）
//   B. notify.mjs 的出口（沒 token 落檔／有 token 真的 POST 出去／推送失敗要落檔）
// B 用本機 127.0.0.1 起一個假 Telegram API，驗證送出的 chat_id 與 text 內容。
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { planAlerts, formatAlerts, keyOf } from './probe-diff.mjs';
import { alert } from './notify.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`); } };
const row = (tok, walletName, level, label, detail = '') => ({ tok, walletName, level, label, detail });

// ---------- A. 純邏輯 ----------
{
  const prev = [row('0xaaa', '二号', 'valid', '⏳ 自訂錯誤', '0x13112018 = RefundClosed()')];
  const now = [row('0xaaa', '二号', 'none', '❌ 沒有入口', '位元碼沒有 refund 選擇器')];
  const { alerts } = planAlerts(prev, now, {});
  ok(alerts.length === 1 && alerts[0].kind === 'gone', 'A1 有效→沒有入口 = 🚨 gone', JSON.stringify(alerts));
}
{
  const prev = [row('0xbbb', '二号', 'ok', '✅ 可退')];
  const now = [row('0xbbb', '二号', 'unknown', '⚠️ 不可判定')];
  const r1 = planAlerts(prev, now, {});
  ok(r1.alerts.length === 0 && r1.suppressed.length === 1, 'A2 有效→不可判定：第一輪只待確認、不告警（避免節點抖動誤報）', JSON.stringify(r1.alerts));
  const r2 = planAlerts(prev, now, r1.state);
  ok(r2.alerts.length === 1 && r2.alerts[0].kind === 'blind', 'A2b 連兩輪都是不可判定 → 才告警 ⚠️ blind');
}
{
  const prev = [row('0xccc', '二号', 'none', '❌ 沒有入口')];
  const now = [row('0xccc', '二号', 'valid', '⏳ 帶原因')];
  const { alerts } = planAlerts(prev, now, {});
  ok(alerts.length === 1 && alerts[0].kind === 'recovered', 'A3 沒有入口→有效 = ✅ recovered');
}
{
  const prev = [row('0xddd', '二号', 'valid', '⏳ 自訂錯誤')];
  const now = [row('0xddd', '二号', 'valid', '⏳ 自訂錯誤')];
  const { alerts } = planAlerts(prev, now, {});
  ok(alerts.length === 0, 'A4 狀態沒變 = 不告警');
}
{
  const prev = [row('0xeee', '二号', 'valid', '⏳ 自訂錯誤')];
  const now = [row('0xeee', '二号', 'none', '❌ 沒有入口')];
  const first = planAlerts(prev, now, {});
  const second = planAlerts(prev, now, first.state);
  ok(first.alerts.length === 1 && second.alerts.length === 0, 'A5 同一個變化不會重複告警（去重）');
}
{
  const prev = [row('0xfff', '二号', 'valid', '⏳ 自訂錯誤')];
  const now = [row('0xfff', '二号', 'ratelimit', '⚠️ 限流', '多節點重試')];
  ok(planAlerts(prev, now, {}).alerts.length === 0, 'A6 限流不算狀態變化');
}
{
  const prev = [];
  const now = [row('0x111', '二号', 'none', '❌ 沒有入口')];
  const r = planAlerts(prev, now, {});
  ok(r.alerts.length === 0 && Object.keys(r.state).length === 0, 'A7 首輪新合約不告警，也不建立告警狀態');
}
{
  const a = planAlerts([row('0x1', 'w', 'valid', 'x')], [row('0x1', 'w', 'none', 'y')], {});
  const text = formatAlerts(a.alerts);
  ok(text.includes('🚨 退款入口消失') && text.includes('之前：x') && text.includes('現在：y') && text.includes('https://bscscan.com/address/0x1'), 'A8 告警文字含標題／前後狀態／bscscan 連結');
}
{
  const gone = planAlerts([row('0x2', 'w', 'valid', 'x')], [row('0x2', 'w', 'none', 'y')], {}).alerts;
  const p3 = [row('0x3', 'w', 'valid', 'x')], n3 = [row('0x3', 'w', 'unknown', 'z')];
  const blind = planAlerts(p3, n3, planAlerts(p3, n3, {}).state).alerts;
  const text = formatAlerts([...gone, ...blind]);
  ok(gone.length === 1 && blind.length === 1 && text.indexOf('退款入口消失') < text.indexOf('不可判定'), 'A9 多筆告警依嚴重度排序（gone 在 blind 之前）');
}

{
  const prev = [row('0xflap', '二号', 'valid', '⏳ 自訂錯誤')];
  const unknown = [row('0xflap', '二号', 'unknown', '⚠️ 不可判定')];
  const valid = [row('0xflap', '二号', 'valid', '⏳ 自訂錯誤')];
  const r1 = planAlerts(prev, unknown, {});
  const r2 = planAlerts(unknown, valid, r1.state);
  const r3 = planAlerts(valid, unknown, r2.state);
  const r4 = planAlerts(unknown, valid, r3.state);
  ok(r1.alerts.length === 0 && r2.alerts.length === 1 && r3.alerts.length === 0 && r4.alerts.length === 0, 'A10 抖動（有效↔不可判定）只告警一次（恢復那次），不重複洗版');
}
{
  const s2 = planAlerts([row('0x5', 'w', 'unknown', 'z')], [row('0x5', 'w', 'valid', 'x')], {});
  ok(s2.alerts.length === 1 && s2.alerts[0].kind === 'cleared', 'A11 不可判定→有效：改善方向立即告警 ✅ cleared');
  const s3 = planAlerts([row('0x5', 'w', 'unknown', 'z')], [row('0x5', 'w', 'valid', 'x')], s2.state);
  ok(s3.alerts.length === 0, 'A12 同一個 cleared 變化不重複告警');
}

// ---------- B. 通知出口 ----------
const mktmp = () => mkdtempSync(join(tmpdir(), 'refundalerts-'));
const writeCfg = (dir, tg) => { const f = join(dir, 'config.json'); writeFileSync(f, JSON.stringify({ telegram: tg })); return f; };

{
  const dir = mktmp();
  const cfg = writeCfg(dir, { botToken: '', chatId: '' });
  const r = await alert('測試：沒有 token', { tag: 'REFUND', dataDir: dir, cfgFile: cfg });
  const f = join(dir, 'REFUND-ALERT.txt');
  ok(r.channel === 'file' && existsSync(f) && readFileSync(f, 'utf8').includes('測試：沒有 token'), 'B1 沒有 token = 落檔 REFUND-ALERT.txt');
  ok(readFileSync(join(dir, 'alerts.log'), 'utf8').includes('[REFUND]'), 'B2 alerts.log 一定有稽核行');
}

{
  const dir = mktmp();
  let got = null;
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cfg = writeCfg(dir, { botToken: '123:FAKE', chatId: '-100999' });
  const r = await alert('🚨 測試告警內容', { tag: 'REFUND', dataDir: dir, cfgFile: cfg, apiBase: base });
  srv.close();
  ok(r.channel === 'telegram', 'B3 有 token = 走 Telegram 推送', r.reason);
  ok(got && got.chat_id === '-100999' && got.text.includes('🚨 測試告警內容'), 'B4 送出的 chat_id / text 正確', JSON.stringify(got));
}

{
  const dir = mktmp();
  const srv = createServer((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"ok":false,"description":"Unauthorized"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cfg = writeCfg(dir, { botToken: '999:BAD', chatId: '42' });
  const r = await alert('推送會失敗的內容', { tag: 'REFUND', dataDir: dir, cfgFile: cfg, apiBase: base });
  srv.close();
  ok(r.channel === 'file' && readFileSync(join(dir, 'REFUND-ALERT.txt'), 'utf8').includes('推送失敗'), 'B5 推送失敗 = 退回落檔（不吞訊息）');
}

{
  const dir = mktmp();
  const cfg = writeCfg(dir, { botToken: '123:FAKE', chatId: '', groupChatId: '-100777' });
  let got = null;
  const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const r = await alert('群組回退測試', { tag: 'REFUND', dataDir: dir, cfgFile: cfg, apiBase: base });
  srv.close();
  ok(r.channel === 'telegram' && got.chat_id === '-100777', 'B6 沒 chatId 時回退 groupChatId');
}

console.log(`\n${fail === 0 ? '✅ 全部通過' : '❌ 有失敗'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
