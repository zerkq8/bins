/**
 * تشخيص مؤقت: يشغّل نفس منطق /api/alerts، لكن يعيد تفاصيل إضافية
 * تؤكد هل الكتابة لجدول position_snapshots نجحت فعلاً أم فشلت بصمت.
 * ⚠️ هذا يستبدل مؤقتاً api/status.js الحالي (العلامات 🟢/🔴) — أعده لاحقاً!
 * الاستدعاء: /api/status?key=مفتاحك
 */
const { runAlerts } = require('../lib/alerts');
const { ENDPOINTS, HEADERS, BASE, __internal } = require('../lib/binance');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

async function sb(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text.slice(0, 500) };
}

async function callPositions(id) {
  const url = BASE + ENDPOINTS.openPositions.url.replace('{id}', id);
  const res = await fetch(url, { headers: HEADERS });
  const j = await res.json();
  const list = Array.isArray(j?.data) ? j.data : (j?.data?.list || []);
  return __internal.normalizeOpenPositions(list);
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const key = String(req.query?.key || '').trim();
    if (!key) throw new Error('المفتاح مفقود.');

    // ١) قبل: نقرأ آخر تحديث لجدول الدفعات
    const cursorBefore = await sb(`alert_cursor?device_key=eq.${encodeURIComponent(key)}&select=*`);

    // ٢) نشغّل الفحص الحقيقي
    let alertsResult, alertsError = null;
    try { alertsResult = await runAlerts({ callPositions, deviceKey: key }); }
    catch (e) { alertsError = e.message; }

    // ٣) بعد: نقرأ نفس الجدولين للمقارنة
    const cursorAfter = await sb(`alert_cursor?device_key=eq.${encodeURIComponent(key)}&select=*`);
    const snapsAfter = await sb(
      `position_snapshots?device_key=eq.${encodeURIComponent(key)}&select=trader_id,updated_at&order=updated_at.desc&limit=5`
    );

    res.status(200).end(JSON.stringify({
      alertCursorTableExists: cursorBefore.status !== 404,
      alertCursorTableError: cursorBefore.status === 404 ? cursorBefore.body : null,
      cursorBefore: cursorBefore.ok ? JSON.parse(cursorBefore.body || '[]') : cursorBefore.body,
      alertsResult,
      alertsError,
      cursorAfter: cursorAfter.ok ? JSON.parse(cursorAfter.body || '[]') : cursorAfter.body,
      mostRecentSnapshotUpdates: snapsAfter.ok ? JSON.parse(snapsAfter.body || '[]') : snapsAfter.body,
      serverTimeNow: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    res.status(500).end(JSON.stringify({ error: e.message, stack: (e.stack||'').split('\n').slice(0,5) }));
  }
};
