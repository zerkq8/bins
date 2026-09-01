/**
 * api/tradetest.js
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 *
 * الاختبار النهائي: يستدعي executeEntry() الكاملة من lib/botTrade.js
 * بإعداداتك الحقيقية المؤكَّدة (١٠٪ هامش، ×١٠ رافعة، وقف ٣٠٪، هدف ٢٥٪)
 * على ETHUSDT، ثم ينظّف كل شيء تلقائياً (يلغي الأوامر المعلّقة، يغلق
 * المركز) — هذا اختبار تحقق، لا نية للبقاء طويلاً بلا مراقبة.
 *
 * الاستدعاء: /api/status?key=مفتاحك&confirm=yes-full-entry-test&symbol=ETHUSDT&side=LONG
 */
const { executeEntry } = require('../lib/botTrade');
const trade = require('../lib/binanceTrade');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const CODE_VERSION = 'full-entry-test-v1';
  const wantsTest = req.query?.confirm === 'yes-full-entry-test';
  const SYMBOL = String(req.query?.symbol || 'ETHUSDT').toUpperCase();
  const SIDE = String(req.query?.side || 'LONG').toUpperCase();

  if (!wantsTest) {
    res.status(200).end(JSON.stringify({
      codeVersion: CODE_VERSION,
      summary: 'أضِف &confirm=yes-full-entry-test&symbol=ETHUSDT&side=LONG لتشغيل الاختبار الكامل',
      allOk: true,
    }, null, 2));
    return;
  }

  const settings = { positionPct: 10, leverage: 10, stopLossPct: 30, takeProfitPct: 25 };
  const cleanupLog = [];

  try {
    const result = await executeEntry({ symbol: SYMBOL, side: SIDE, settings });

    // ---------------- تنظيف: نلغي الأوامر المعلّقة ونغلق المركز يدوياً ----------------
    try {
      const openAlgo = await trade.signedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol: SYMBOL });
      const algoList = Array.isArray(openAlgo) ? openAlgo : (openAlgo?.algoOrders || []);
      for (const o of algoList) {
        await trade.signedRequest('DELETE', '/fapi/v1/algoOrder', { algoId: o.algoId });
      }
      cleanupLog.push({ name: 'إلغاء الأوامر المعلّقة', ok: true, detail: `أُلغي ${algoList.length} أمراً` });
    } catch (e) {
      cleanupLog.push({ name: 'إلغاء الأوامر المعلّقة', ok: false, detail: e.message });
    }

    try {
      const positions = await trade.getPositions();
      const openPos = positions.find((p) => p.symbol === SYMBOL && Number(p.positionAmt) !== 0);
      if (openPos) {
        const amt = Number(openPos.positionAmt);
        const closeSide = amt > 0 ? 'SELL' : 'BUY';
        await trade.signedRequest('POST', '/fapi/v1/order', {
          symbol: SYMBOL, side: closeSide, type: 'MARKET', quantity: Math.abs(amt), reduceOnly: 'true',
        });
        cleanupLog.push({ name: 'إغلاق المركز يدوياً', ok: true, detail: `أُغلق مركز بحجم ${amt}` });
      } else {
        cleanupLog.push({ name: 'إغلاق المركز يدوياً', ok: true, detail: 'لا مركز مفتوح — ربما أُغلق بالفعل أو لم يُفتَح' });
      }
    } catch (e) {
      cleanupLog.push({ name: 'إغلاق المركز يدوياً', ok: false, detail: e.message });
    }

    res.status(200).end(JSON.stringify({
      codeVersion: CODE_VERSION,
      summary: result.success
        ? '✅ الدالة الكاملة نجحت من أولها لآخرها — الدخول والوقف والهدف كأوامر حقيقية'
        : '⚠️ فشلت في مكان ما — راجع entryLog بالتفصيل',
      entrySuccess: result.success,
      entryLog: result.log,
      entrySummary: result.summary || null,
      cleanupLog,
    }, null, 2));
  } catch (e) {
    res.status(200).end(JSON.stringify({
      codeVersion: CODE_VERSION,
      summary: '❌ خطأ عام غير متوقع',
      error: e.message,
      cleanupLog,
    }, null, 2));
  }
};
