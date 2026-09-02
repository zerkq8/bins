/**
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 * يعرض كل حقول الرصيد ذات الصلة من حساب Demo Trading معاً، جنباً
 * لجنب، لفهم الفارق بين ما يظهر في واجهة التطبيق وما يستخدمه كودنا
 * فعلياً في حساب حجم المركز.
 * الاستدعاء: /api/status?key=أي_شيء (لا يحتاج مفتاحك العادي فعلياً)
 */
const trade = require('../lib/binanceTrade');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const account = await trade.getAccountInfo();
    const positions = await trade.getPositions();
    const openPositions = positions.filter((p) => Number(p.positionAmt) !== 0);

    res.status(200).end(JSON.stringify({
      summary: 'مقارنة حقول الرصيد — لفهم الفارق بين واجهة التطبيق وما يستخدمه كودنا',
      balanceFields: {
        totalWalletBalance: account.totalWalletBalance,
        availableBalance: account.availableBalance,
        totalMarginBalance: account.totalMarginBalance,
        totalUnrealizedProfit: account.totalUnrealizedProfit,
        totalPositionInitialMargin: account.totalPositionInitialMargin,
        totalOpenOrderInitialMargin: account.totalOpenOrderInitialMargin,
      },
      openPositionsCount: openPositions.length,
      openPositionsDetail: openPositions.map((p) => ({
        symbol: p.symbol,
        positionAmt: p.positionAmt,
        entryPrice: p.entryPrice,
        unrealizedProfit: p.unRealizedProfit || p.unrealizedProfit,
        initialMargin: p.initialMargin,
        isolatedMargin: p.isolatedMargin,
      })),
      note: 'قارن totalWalletBalance (على الأرجح ما تراه في التطبيق) بـ availableBalance (ما يستخدمه البوت فعلياً في الحساب)',
    }, null, 2));
  } catch (e) {
    res.status(500).end(JSON.stringify({ error: e.message }));
  }
};
