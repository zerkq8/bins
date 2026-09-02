/**
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 * يجلب سجل "الدخل" الكامل من باينس (/fapi/v1/income) — يشمل كل شيء
 * أثّر على رصيدك: أرباح/خسائر محققة، رسوم، تمويل. هذا يعطينا الصورة
 * الكاملة الحقيقية مباشرة من المصدر، بلا نسخ يدوي عرضة للخطأ.
 * الاستدعاء: /api/status  (بلا أي معامل)
 */
const trade = require('../lib/binanceTrade');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    // آخر ٧ أيام كافية لتغطية "منذ الليلة الماضية" بأمان
    const startTime = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const income = await trade.signedRequest('GET', '/fapi/v1/income', {
      startTime, limit: 1000,
    });

    const byType = {};
    let totalNet = 0;
    for (const item of income) {
      const type = item.incomeType;
      const amount = parseFloat(item.income);
      byType[type] = (byType[type] || 0) + amount;
      totalNet += amount;
    }

    // نجمع أيضاً حسب العملة، لنرى أي عملة ساهمت أكثر في التغيّر
    const bySymbol = {};
    for (const item of income) {
      if (!item.symbol) continue;
      const amount = parseFloat(item.income);
      bySymbol[item.symbol] = (bySymbol[item.symbol] || 0) + amount;
    }

    const account = await trade.getAccountInfo();

    res.status(200).end(JSON.stringify({
      summary: `مجموع كل التغيرات المالية آخر 7 أيام: ${totalNet.toFixed(2)}$`,
      currentBalance: account.totalWalletBalance,
      totalEventsFound: income.length,
      breakdownByType: Object.fromEntries(
        Object.entries(byType).map(([k, v]) => [k, Number(v.toFixed(2))])
      ),
      breakdownBySymbol: Object.fromEntries(
        Object.entries(bySymbol).map(([k, v]) => [k, Number(v.toFixed(2))])
          .sort((a, b) => a[1] - b[1])  // الأكثر خسارة أولاً
      ),
      note: 'REALIZED_PNL = أرباح/خسائر الصفقات المغلقة | COMMISSION = رسوم التداول | FUNDING_FEE = رسوم تمويل دورية',
    }, null, 2));
  } catch (e) {
    res.status(500).end(JSON.stringify({ error: e.message }));
  }
};
