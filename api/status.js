/**
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 * يتحقق من قائمة كل العملات المتاحة فعلياً في Demo Trading (USDⓈ-M)،
 * ويقارنها بعينة من عملات معروفة (قديمة وحديثة نسبياً) للتأكد هل
 * الدعم شامل أم محدود بمجموعة قديمة فقط.
 * الاستدعاء: /api/status
 */
const trade = require('../lib/binanceTrade');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const info = await trade.publicRequest('/fapi/v1/exchangeInfo');
    const allSymbols = info.symbols
      .filter((s) => s.status === 'TRADING')
      .map((s) => s.symbol);

    // عينة من عملات "قديمة جداً" وأخرى "أحدث نسبياً" للتأكد من التغطية
    const testSample = [
      'BTCUSDT', 'ETHUSDT',           // قديمة جداً، الأساسية
      'SOLUSDT', 'DOGEUSDT',          // معروفة، متوسطة العمر
      'PENDLEUSDT', 'ARBUSDT',        // أحدث نسبياً
      'WIFUSDT', 'ORDIUSDT',          // حديثة جداً نسبياً
    ];
    const availability = Object.fromEntries(
      testSample.map((s) => [s, allSymbols.includes(s)])
    );

    res.status(200).end(JSON.stringify({
      summary: `إجمالي العملات المتاحة للتداول حالياً في Demo Trading: ${allSymbols.length}`,
      sampleAvailability: availability,
      lastTwentySymbolsAlphabetically: allSymbols.sort().slice(-20),
      note: 'إن ظهرت العملات "الحديثة" في sampleAvailability بـ true، فالدعم شامل لا محدود بالقديمة فقط',
    }, null, 2));
  } catch (e) {
    res.status(500).end(JSON.stringify({ error: e.message }));
  }
};
