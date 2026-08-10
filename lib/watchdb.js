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

module.exports = { listIds, addId, removeId, purge };
