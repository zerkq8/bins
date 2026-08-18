/**
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 * يفحص: هل الدالة التي يستخدمها نظام التنبيهات فعلياً (callPositions)
 * تُرجع حقول الهامش أصلاً، أم أنها مفقودة من المصدر قبل وصولها لرسائلنا؟
 * الاستدعاء: /api/status?id=رقم_متداول
 */
const { BASE, HEADERS, ENDPOINTS, __internal } = require('../lib/binance');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const id = String(req.query?.id || '').trim();
    if (!id) throw new Error('أرسل ?id=رقم_متداول (استخدم متداولاً له مركز مفتوح الآن).');

    const url = BASE + ENDPOINTS.openPositions.url.replace('{id}', id);
    const res2 = await fetch(url, { headers: HEADERS });
    const j = await res2.json();
    const rawList = Array.isArray(j?.data) ? j.data : (j?.data?.list || []);

    // ١) بيانات باينس الخام، بلا أي معالجة — نتأكد الحقول موجودة من الأساس
    const rawSampleWithPosition = rawList.find((p) => Number(p.positionAmount) !== 0);

    // ٢) نفس الدالة التي يستخدمها نظام التنبيهات فعلياً حرفياً
    const normalized = __internal.normalizeOpenPositions
      ? __internal.normalizeOpenPositions(rawList)
      : null;

    // ٣) دالة normOpen المباشرة للمقارنة (نفس المستخدمة في صفحة تفاصيل المتداول)
    const normOpenDirect = (__internal.normOpen && rawSampleWithPosition)
      ? __internal.normOpen(rawSampleWithPosition) : null;

    res.status(200).end(JSON.stringify({
      totalOpenPositions: rawList.filter((p) => Number(p.positionAmount) !== 0).length,

      rawFieldsAvailable: rawSampleWithPosition ? {
        isolated: rawSampleWithPosition.isolated,
        isolatedWallet: rawSampleWithPosition.isolatedWallet,
        notionalValue: rawSampleWithPosition.notionalValue,
      } : 'لا مركز مفتوح حالياً لهذا المتداول',

      viaNormalizeOpenPositions_usedByAlerts: normalized?.[0]
        ? { marginReported: normalized[0].marginReported, notional: normalized[0].notional, marginMode: normalized[0].marginMode }
        : 'فارغة أو غير موجودة',

      viaNormOpenDirect_usedByWebsite: normOpenDirect
        ? { marginReported: normOpenDirect.marginReported, notional: normOpenDirect.notional, marginMode: normOpenDirect.marginMode }
        : null,

      diagnosis: (normalized?.[0]?.marginReported === undefined && normOpenDirect?.marginReported !== undefined)
        ? '🎯 وجدنا المشكلة بدقة: normalizeOpenPositions (التي يستخدمها التنبيهات) لا تحسب الهامش، بينما normOpen (المستخدمة في الموقع) تحسبه بنجاح.'
        : 'الحقول تبدو متطابقة — السبب في مكان آخر، أرسل هذا الرد كاملاً للفحص.',
    }, null, 2));
  } catch (e) {
    res.status(500).end(JSON.stringify({ error: e.message, stack: (e.stack || '').split('\n').slice(0, 6) }));
  }
};
