/**
 * نقطة الفحص — تُستدعى دورياً من خدمة جدولة خارجية (cron-job.org).
 * الاستدعاء: /api/alerts?key=مفتاحك
 *
 * ⚠️ يستخدم نفس منطق lib/binance.js (normOpen + isOpenPosition) بدل
 * تكرار منفصل، لأن هذه النقطة تُعيد كل رموز باينس (~٧٧٧) مع أصفار،
 * ولا تحتوي حقل roi جاهزاً — الفلترة والحساب في مكان واحد فقط الآن.
 */
const { runAlerts } = require('../lib/alerts');
const { ENDPOINTS, HEADERS, BASE, __internal } = require('../lib/binance');

/** جلب المراكز المفتوحة الحقيقية فقط (بعد استبعاد الأصفار) */
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
    const result = await runAlerts({ callPositions, deviceKey: key });
    res.status(200).end(JSON.stringify({ ok: true, ...result, at: Date.now() }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: e.message }));
  }
};
