// notify.mjs —— 統一告警出口（有 Telegram 就推、沒設就落地檔案）
//
// 使用者 11/2 11:56「好的」＝把退款探測的變化推給他。但 config.json 的
// telegram.botToken / chatId 目前都是空的（先前只有 data/watch.log 裡的 "TG:" 行，
// 那是紀錄不是推送），所以這裡做成「先備好推送路徑，憑證一填就生效」：
//
//   ① 永遠寫 data/alerts.log（一行一筆，可稽核）
//   ② 有 token + chatId → POST api.telegram.org/sendMessage
//   ③ 沒 token 或推送失敗 → 寫 data/<TAG>-ALERT.txt，由每小時的 DSH 巡檢讀出來報給使用者
//
// 憑證來源：config.json 的 telegram.botToken / telegram.chatId，或環境變數
// TG_BOT_TOKEN / TG_CHAT_ID（環境變數優先度高於空字串，但不覆蓋已填的設定值）。
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function readTg(cfgFile) {
  let c = {};
  try { c = JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); } catch { c = {}; }
  const t = c.telegram || {};
  return {
    token: String(t.botToken || process.env.TG_BOT_TOKEN || '').trim(),
    chat: String(t.chatId || process.env.TG_CHAT_ID || '').trim(),
    group: String(t.groupChatId || '').trim(),
  };
}

export async function sendTelegram(token, chatId, text, opts = {}) {
  const apiBase = (opts.apiBase || process.env.TG_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const r = await fetch(`${apiBase}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, disable_notification: false }),
    signal: AbortSignal.timeout(12000),
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok || j.ok !== true) throw new Error(`HTTP ${r.status} ${j.description || 'sendMessage 失敗'}`);
  return j;
}

/**
 * 送出一則告警。
 * @returns {{channel:'telegram'|'file', reason?:string}}
 */
export async function alert(text, opts = {}) {
  const dataDir = opts.dataDir;
  const tag = opts.tag || 'ALERT';
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  mkdirSync(dataDir, { recursive: true });
  const logLine = (s) => { try { appendFileSync(join(dataDir, 'alerts.log'), s + '\r\n'); } catch {} };

  logLine(`[${ts}] [${tag}] ${String(text).replace(/\r?\n/g, ' ⏎ ')}`);

  const { token, chat, group } = readTg(opts.cfgFile);
  const to = chat || group;
  if (!token || !to) {
    const why = !token ? '沒有 botToken' : '沒有 chatId';
    try { appendFileSync(join(dataDir, `${tag}-ALERT.txt`), `[${ts}] ${why}\n${text}\n\n`); } catch {}
    logLine(`[${ts}] [${tag}] 未推送（${why}），已寫 ${tag}-ALERT.txt`);
    return { channel: 'file', reason: why };
  }

  try {
    await sendTelegram(token, to, text, opts);
    logLine(`[${ts}] [${tag}] 已推送 Telegram ${to}`);
    return { channel: 'telegram' };
  } catch (e) {
    try { appendFileSync(join(dataDir, `${tag}-ALERT.txt`), `[${ts}] 推送失敗：${e.message}\n${text}\n\n`); } catch {}
    logLine(`[${ts}] [${tag}] 推送失敗（${e.message}），已寫 ${tag}-ALERT.txt`);
    return { channel: 'file', reason: e.message };
  }
}
