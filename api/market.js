/**
 * قراءة عملة — نقطة موحّدة تخدم وضعين بلا إضافة ملف جديد:
 * ?symbol=BTCUSDT              → بيانات السوق الأساسية (سعر، ATR، مدى)
 * ?symbol=BTCUSDT&mode=technical → تحليل فني وصفي كامل (RSI/MACD/دعم/مقاومة)
 */
const { getSymbol, getTechnicalAnalysis } = require('../lib/market');
const { jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async (req) => {
  const s = String(req.query?.symbol || 'BTCUSDT').trim();
  if (req.query?.mode === 'technical') return await getTechnicalAnalysis(s);
  return await getSymbol(s);
}, 20);
