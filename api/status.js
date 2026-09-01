/**
 * api/tradetest.js
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 * يتحقق فقط أن الاتصال بحساب Binance Demo Trading يعمل بنجاح —
 * قراءة فقط (Ping + الرصيد + المراكز المفتوحة)، لا تنفيذ أي أمر إطلاقاً.
 * الاستدعاء: /api/status?key=مفتاحك_الشخصي_في_الموقع
 */
const trade = require('../lib/binanceTrade');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });

  try {
    // ١) فحص أن مفاتيح البيئة موجودة أصلاً، بلا كشف قيمتها
    const hasKey = !!process.env.BINANCE_DEMO_API_KEY;
    const hasSecret = !!process.env.BINANCE_DEMO_API_SECRET;
    check('مفاتيح Demo Trading موجودة في متغيرات البيئة', hasKey && hasSecret,
      { hasKey, hasSecret });

    // ٢) هل الخادم نفسه يستجيب؟ (لا يحتاج مفاتيح)
    const pingResult = await trade.ping();
    check('الاتصال بـ demo-fapi.binance.com', JSON.stringify(pingResult) === '{}', pingResult);

    if (!hasKey || !hasSecret) {
      results.push({ name: 'باقي الفحوصات', ok: false, detail: 'تخطّيناها — المفاتيح غير موجودة بعد' });
    } else {
      // ٣) هل التوقيع صحيح؟ هذا أهم فحص — يثبت المفتاح والسر يعملان فعلياً
      const account = await trade.getAccountInfo();
      check('التحقق من الحساب (المفتاح والتوقيع صحيحان)', !!account?.totalWalletBalance, {
        totalWalletBalance: account?.totalWalletBalance,
        availableBalance: account?.availableBalance,
        canTrade: account?.canTrade,
      });

      // ٤) قراءة المراكز المفتوحة حالياً (يجب أن تكون فارغة أو تعرض ما لديك فعلاً)
      const positions = await trade.getPositions();
      const openOnes = Array.isArray(positions)
        ? positions.filter((p) => Number(p.positionAmt) !== 0)
        : [];
      check('قراءة المراكز المفتوحة', Array.isArray(positions), {
        totalSymbolsReturned: Array.isArray(positions) ? positions.length : 0,
        openPositionsCount: openOnes.length,
        openPositions: openOnes.map((p) => ({ symbol: p.symbol, amt: p.positionAmt })),
      });
    }

    const allOk = results.every((r) => r.ok !== false);
    res.status(200).end(JSON.stringify({
      summary: allOk ? '✅ الاتصال بحساب Demo Trading يعمل بنجاح تام' : '⚠️ توجد مشكلة — راجع التفاصيل',
      allOk,
      results,
    }, null, 2));
  } catch (e) {
    results.push({ name: 'خطأ عام', ok: false, detail: { message: e.message } });
    res.status(200).end(JSON.stringify({ summary: '❌ فشل الاتصال', allOk: false, results }, null, 2));
  }
};
