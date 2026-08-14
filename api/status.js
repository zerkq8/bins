/**
 * ⚠️ اختبار شامل مؤقت — يستبدل api/status.js مؤقتاً.
 * يفحص كل حلقة في السلسلة على حدة، ويرسل رسالة تيليجرام تجريبية
 * حقيقية لتأكيد وصولها فعلياً — لا مجرد فحص نظري.
 * الاستدعاء: /api/status?key=مفتاحك
 */
const { runAlerts, tg } = require('../lib/alerts');
const { runCoinAlerts } = require('../lib/coinalerts');
const { ENDPOINTS, HEADERS, BASE, __internal } = require('../lib/binance');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

async function sb(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

async function callPositions(id) {
  const url = BASE + ENDPOINTS.openPositions.url.replace('{id}', id);
  const res = await fetch(url, { headers: HEADERS });
  const j = await res.json();
  const list = Array.isArray(j?.data) ? j.data : (j?.data?.list || []);
  return __internal.normalizeOpenPositions(list);
}

const check = (name, ok, detail) => ({ name, ok, detail });

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  const key = String(req.query?.key || '').trim();
  const results = [];

  try {
    if (!key) throw new Error('المفتاح مفقود. استخدم ?key=مفتاحك');

    /* ١) متغيرات البيئة */
    results.push(check('متغيرات البيئة',
      !!SB_URL && !!SB_KEY && !!process.env.TELEGRAM_TOKEN && !!process.env.TELEGRAM_CHAT_ID,
      { hasSupabaseUrl: !!SB_URL, hasSupabaseKey: !!SB_KEY,
        hasTgToken: !!process.env.TELEGRAM_TOKEN, hasTgChat: !!process.env.TELEGRAM_CHAT_ID }));

    /* ٢) الجداول الأربعة موجودة */
    const tables = ['watchlist', 'position_snapshots', 'alert_cursor', 'watched_coins', 'coin_snapshots'];
    const tableChecks = {};
    for (const t of tables) {
      const r = await sb(`${t}?limit=1`);
      tableChecks[t] = r.ok || r.status === 200;
    }
    results.push(check('الجداول موجودة', Object.values(tableChecks).every(Boolean), tableChecks));

    /* ٣) قائمة المتابعة تُقرأ */
    const watchRows = await sb(`watchlist?device_key=eq.${encodeURIComponent(key)}&select=trader_id,nickname`);
    const watchList = watchRows.ok ? JSON.parse(watchRows.body || '[]') : [];
    results.push(check('قراءة قائمة المتداولين', watchRows.ok && watchList.length > 0,
      { count: watchList.length, sample: watchList.slice(0, 3).map(r => r.nickname) }));

    /* ٤) مؤشر الدفعات يعمل ويتقدم */
    const cursorRow = await sb(`alert_cursor?device_key=eq.${encodeURIComponent(key)}&select=*`);
    const cursorData = cursorRow.ok ? JSON.parse(cursorRow.body || '[]') : [];
    results.push(check('مؤشر الدفعات (alert_cursor)', cursorRow.ok && cursorData.length > 0,
      { row: cursorData[0] || null }));

    /* ٥) الاتصال بباينس يعمل فعلياً لمتداول حقيقي */
    let binanceOk = false, binanceDetail = null;
    if (watchList.length) {
      try {
        const positions = await callPositions(String(watchList[0].trader_id));
        binanceOk = true;
        binanceDetail = { trader: watchList[0].nickname, openPositions: positions.length };
      } catch (e) { binanceDetail = { error: e.message }; }
    }
    results.push(check('الاتصال بباينس (مباشر)', binanceOk, binanceDetail));

    /* ٦) تشغيل الفحص الحقيقي الكامل (متداولون + عملات) */
    let runResult = null, runError = null;
    try { runResult = await runAlerts({ callPositions, deviceKey: key }); }
    catch (e) { runError = e.message; }
    results.push(check('تشغيل فحص المتداولين', !runError, runResult || { error: runError }));

    let coinResult = null, coinError = null;
    try { coinResult = await runCoinAlerts(key); }
    catch (e) { coinError = e.message; }
    results.push(check('تشغيل فحص العملات', !coinError, coinResult || { error: coinError }));

    /* ٧) الكتابة الفعلية في قاعدة البيانات (نقارن قبل/بعد) */
    const snapAfter = await sb(
      `position_snapshots?device_key=eq.${encodeURIComponent(key)}&select=trader_id,updated_at&order=updated_at.desc&limit=3`
    );
    const snapData = snapAfter.ok ? JSON.parse(snapAfter.body || '[]') : [];
    const freshWrites = snapData.filter(s => (Date.now() - new Date(s.updated_at).getTime()) < 30000);
    results.push(check('الكتابة الفعلية لقاعدة البيانات (آخر ٣٠ ثانية)',
      freshWrites.length > 0, { recentUpdates: snapData }));

    /* ٨) اختبار الإرسال الفعلي عبر تيليجرام — رسالة حقيقية تصلك الآن */
    const testMsg = `🧪 <b>اختبار شامل</b>

هذه رسالة اختبار حقيقية — إن وصلتك، فسلسلة الإرسال بأكملها تعمل:
فحص ← مطابقة ← إرسال ← استلام.

⏱ ${new Date().toLocaleString('ar')}`;
    const tgResult = await tg(testMsg);
    results.push(check('إرسال رسالة اختبار فعلية لتيليجرام', tgResult?.ok === true, tgResult));

    const allOk = results.every(r => r.ok);
    res.status(200).end(JSON.stringify({
      summary: allOk ? '✅ كل الحلقات تعمل بنجاح' : '⚠️ توجد حلقة معطّلة — راجع التفاصيل',
      allOk,
      results,
    }, null, 2));
  } catch (e) {
    results.push(check('خطأ عام أوقف الاختبار', false, { error: e.message }));
    res.status(200).end(JSON.stringify({ summary: '❌ توقف الاختبار', allOk: false, results }, null, 2));
  }
};
