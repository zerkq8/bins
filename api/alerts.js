/**
 * نقطة الفحص — تُستدعى دورياً من cron-job.org كل دقيقتين.
 * تفحص: (١) دفعة من المتداولين (فتح/إغلاق مراكز)، ثم (٢) كل العملات
 * المتابَعة (وصول لأدنى قاع) — كلاهما بنفس الاستدعاء ونفس الجدولة،
 * فلا حاجة لإعداد مهمة cron ثانية.
 *
 * ?report=daily — التقرير اليومي الملخّص (مهمة cron منفصلة، مرة يومياً
 * 18:00 UTC = 21:00 الكويت). مدمج هنا بدل ملف مستقل بسبب حد 12 دالة على
 * خطة Vercel Hobby. هذا الاستدعاء لا يشغّل الفحص الدوري إطلاقاً.
 */
const { runAlerts, runDailyReport } = require('../lib/alerts');
const { runCoinAlerts } = require('../lib/coinalerts');
const { ENDPOINTS, HEADERS, BASE, __internal } = require('../lib/binance');

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
    if (!key || key.length < 4) throw new Error('المفتاح الشخصي مفقود.');

    if (String(req.query?.report || '') === 'daily') {
      const report = await runDailyReport({ deviceKey: key });
      res.status(200).end(JSON.stringify({ ok: true, ...report, at: Date.now() }));
      return;
    }

    const traderResult = await runAlerts({ callPositions, deviceKey: key });

    let coinResult = { coinsChecked: 0, coinsSent: 0 };
    try { coinResult = await runCoinAlerts(key); }
    catch (e) { coinResult = { coinsChecked: 0, coinsSent: 0, coinError: e.message }; }

    res.status(200).end(JSON.stringify({ ok: true, ...traderResult, ...coinResult, at: Date.now() }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: e.message }));
  }
};
