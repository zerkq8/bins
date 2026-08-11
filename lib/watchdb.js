/**
 * قائمة المتابعة عبر Supabase — تعمل من أي متصفح.
 * المفاتيح تُقرأ من متغيرات Vercel، ولا تظهر أبداً في الصفحة.
 */

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
const TABLE = 'watchlist';

function assertEnv() {
  if (!URL || !KEY) {
    throw new Error('إعدادات Supabase ناقصة. تأكد من SUPABASE_URL و SUPABASE_KEY في Vercel ثم أعد النشر.');
  }
}

const headers = () => ({
  apikey: KEY,
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
  prefer: 'resolution=merge-duplicates,return=representation',
});

async function sb(path, options = {}) {
  assertEnv();
  const res = await fetch(`${URL}/rest/v1/${path}`, { ...options, headers: headers() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`خطأ من قاعدة البيانات (${res.status}): ${text.slice(0, 160)}`);
  }
  try { return text ? JSON.parse(text) : []; } catch { return []; }
}

/** قراءة معرّفات المتداولين المحفوظين لهذا المفتاح */
async function listIds(deviceKey) {
  const rows = await sb(
    `${TABLE}?device_key=eq.${encodeURIComponent(deviceKey)}&select=trader_id,nickname&order=added_at.asc`
  );
  return rows.map((r) => ({ id: String(r.trader_id), nickname: r.nickname }));
}

/** إضافة متداول */
async function addId(deviceKey, traderId, nickname) {
  await sb(TABLE, {
    method: 'POST',
    body: JSON.stringify([{
      device_key: deviceKey,
      trader_id: String(traderId),
      nickname: nickname || null,
    }]),
  });
  return listIds(deviceKey);
}

/** حذف متداول */
async function removeId(deviceKey, traderId) {
  await sb(
    `${TABLE}?device_key=eq.${encodeURIComponent(deviceKey)}&trader_id=eq.${encodeURIComponent(traderId)}`,
    { method: 'DELETE' }
  );
  return listIds(deviceKey);
}

/** حذف كل بيانات مستخدم — لا رجعة فيه */
async function purge(deviceKey) {
  const before = await listIds(deviceKey);
  await sb(`${TABLE}?device_key=eq.${encodeURIComponent(deviceKey)}`, { method: 'DELETE' });
  return { deleted: before.length };
}

/* ---------------- دفتر الصفقات ---------------- */
const JOURNAL = 'journal';

async function listTrades(deviceKey) {
  return await sb(
    `${JOURNAL}?device_key=eq.${encodeURIComponent(deviceKey)}&select=*&order=opened_at.desc&limit=100`
  );
}

async function addTrade(deviceKey, t) {
  const rows = await sb(JOURNAL, {
    method: 'POST',
    body: JSON.stringify([{
      device_key: deviceKey,
      symbol: String(t.symbol || '').toUpperCase().slice(0, 20),
      side: t.side === 'SHORT' ? 'SHORT' : 'LONG',
      entry: t.entry ?? null,
      stop: t.stop ?? null,
      target: t.target ?? null,
      size: t.size ?? null,
      reason: String(t.reason || '').slice(0, 500),
      exit_price: t.exit_price ?? null,
      result_note: String(t.result_note || '').slice(0, 500),
      opened_at: t.opened_at || new Date().toISOString(),
    }]),
  });
  return rows;
}

async function closeTrade(deviceKey, id, exitPrice, note) {
  await sb(
    `${JOURNAL}?device_key=eq.${encodeURIComponent(deviceKey)}&id=eq.${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify({
        exit_price: exitPrice ?? null,
        result_note: String(note || '').slice(0, 500),
        closed_at: new Date().toISOString(),
      }) }
  );
  return listTrades(deviceKey);
}

async function deleteTrade(deviceKey, id) {
  await sb(
    `${JOURNAL}?device_key=eq.${encodeURIComponent(deviceKey)}&id=eq.${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
  return listTrades(deviceKey);
}

module.exports = { listIds, addId, removeId, purge, listTrades, addTrade, closeTrade, deleteTrade };
