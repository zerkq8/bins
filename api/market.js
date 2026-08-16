/**
 * قراءة عملة — نقطة موحّدة بلا إضافة ملف جديد:
 * ?symbol=X                              → بيانات السوق الأساسية
 * ?symbol=X&mode=technical               → تحليل فني (يومي افتراضياً)
 * ?symbol=X&mode=technical&interval=4h   → تحليل فني بإطار زمني محدد (1h/4h/1d/1w)
 */
const { getSymbol, getTechnicalAnalysis } = require('../lib/market');
const { jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async (req) => {
  const s = String(req.query?.symbol || 'BTCUSDT').trim();
  if (req.query?.mode === 'technical') {
    return await getTechnicalAnalysis(s, String(req.query?.interval || '1d'));
  }
  return await getSymbol(s);
}, 20);
