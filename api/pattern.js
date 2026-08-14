/**
 * السياق التاريخي — يعرض تكرار "وضع" السوق الحالي في الماضي بصدق تام.
 * ⚠️ ليس توصية ولا احتمالاً موثوقاً — أعداد خام مع تحذير حجم العيّنة.
 * الاستدعاء: /api/pattern?symbol=BTCUSDT&horizon=3
 */
const { getHistoricalContext } = require('../lib/market');
const { jsonHandler } = require('../lib/binance');

module.exports = jsonHandler(async (req) => {
  const symbol = String(req.query?.symbol || '').trim();
  const horizon = Math.min(14, Math.max(1, parseInt(req.query?.horizon) || 3));
  if (!symbol) throw new Error('الرمز مفقود.');
  return await getHistoricalContext(symbol, { horizonDays: horizon });
}, 300);   // ذاكرة مؤقتة أطول — البيانات التاريخية لا تتغير كل دقيقة
