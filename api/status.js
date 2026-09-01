/**
 * api/tradetest.js
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 *
 * الاختبار الجوهري "غير القابل للتفاوض": نفتح مركزاً صغيراً، ثم نضع
 * وقف خسارة (STOP_MARKET) وهدف ربح (TAKE_PROFIT_MARKET) كأمرين
 * فعليين مستقلين على خوادم باينس نفسها — لا كمنطق يراقبه كودنا. نتحقق
 * أنهما يظهران كأوامر معلّقة حقيقية عبر /fapi/v1/openOrders (لا مجرد
 * رد نجاح من طلبنا)، ثم ننظّف كل شيء (نلغي الأمرين ونغلق المركز يدوياً)
 * لأننا لا ننتظر السعر الحقيقي ليصل لأي منهما خلال اختبار قصير كهذا.
 *
 * الاستدعاء: /api/status?key=مفتاحك&confirm=yes-test-sltp&symbol=ETHUSDT
 */
const trade = require('../lib/binanceTrade');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

async function sb(path, options = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`,
      'content-type': 'application/json', ...(options.headers || {}),
    },
  });
  return { ok: res.ok, status: res.status };
}
/**
 * ⚠️ إصلاح إضافي بعد اكتشاف حقيقي: قفل بلا صلاحية زمنية قد "يعلق" للأبد
 * إن قُتلت الدالة في المنتصف (تجاوز حد Vercel ١٠ ثوانٍ) قبل الوصول
 * لسطر التحرير. الحل: قفل "ذكي" — يرفض التزامن الحقيقي القريب (أقل من
 * ٣٠ ثانية)، لكن يتعافى تلقائياً من قفل أقدم من ذلك (على الأرجح عالق).
 */
const STALE_LOCK_MS = 30000;

async function tryAcquireLock(lockKey) {
  const insertResult = await sb('trade_locks', {
    method: 'POST', headers: { prefer: 'return=minimal' },
    body: JSON.stringify([{ lock_key: lockKey }]),
  });
  if (insertResult.ok) return true; // لا قفل موجود مسبقاً — نجحنا فوراً

  // فشل الإدراج (القفل موجود) — نتحقق: هل هو قديم بما يكفي ليكون عالقاً؟
  const res = await fetch(`${SB_URL}/rest/v1/trade_locks?lock_key=eq.${encodeURIComponent(lockKey)}&select=created_at`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  const data = await res.json();
  const createdAt = data?.[0]?.created_at ? new Date(data[0].created_at).getTime() : null;
  const age = createdAt ? Date.now() - createdAt : Infinity;

  if (age < STALE_LOCK_MS) return false; // تزامن حقيقي قريب — رفض حقيقي

  // قفل قديم جداً — على الأرجح عالق من دالة سابقة ماتت في المنتصف. نحرره ونحاول مجدداً
  await releaseLock(lockKey);
  const retryResult = await sb('trade_locks', {
    method: 'POST', headers: { prefer: 'return=minimal' },
    body: JSON.stringify([{ lock_key: lockKey }]),
  });
  return retryResult.ok;
}
async function releaseLock(lockKey) {
  await sb(`trade_locks?lock_key=eq.${encodeURIComponent(lockKey)}`, { method: 'DELETE' });
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });
  const wantsTest = req.query?.confirm === 'yes-test-sltp';
  const SYMBOL = String(req.query?.symbol || 'ETHUSDT').toUpperCase();
  const lockKey = `trade:${SYMBOL}`;
  let lockAcquired = false;
  let qty = null;

  try {
    if (!wantsTest) {
      res.status(200).end(JSON.stringify({
        summary: 'أضِف &confirm=yes-test-sltp&symbol=ETHUSDT لتشغيل اختبار وقف الخسارة/هدف الربح',
        allOk: true, results: [],
      }, null, 2));
      return;
    }

    lockAcquired = await tryAcquireLock(lockKey);
    if (!lockAcquired) {
      check('حجز القفل الذري', false, `⛔ طلب آخر يحمل القفل على ${SYMBOL} بالفعل`);
      res.status(200).end(JSON.stringify({ summary: '⛔ مرفوض — قفل محجوز', allOk: false, results }, null, 2));
      return;
    }
    check('حجز القفل الذري', true, `تم حجز القفل على ${SYMBOL}`);

    // ١) فتح مركز صغير (نفس منطق مُختبَر سابقاً)
    const exchangeInfo = await trade.publicRequest('/fapi/v1/exchangeInfo');
    const symbolInfo = exchangeInfo.symbols.find((s) => s.symbol === SYMBOL);
    const lotSize = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE');
    const minNotionalFilter = symbolInfo.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
    const pricePrecision = symbolInfo.pricePrecision;
    const stepSize = parseFloat(lotSize.stepSize);
    const minQty = parseFloat(lotSize.minQty);
    const minNotional = parseFloat(minNotionalFilter?.notional || '5');

    const priceData = await trade.publicRequest(`/fapi/v1/ticker/price?symbol=${SYMBOL}`);
    const entryPrice = parseFloat(priceData.price);

    const rawQty = minNotional / entryPrice;
    const steps = Math.ceil(rawQty / stepSize);
    qty = Math.max(steps * stepSize, minQty);
    const qDecimals = (stepSize.toString().split('.')[1] || '').length;
    qty = Number(qty.toFixed(qDecimals));

    const buyOrder = await trade.signedRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: qty,
    });
    check('فتح المركز', buyOrder?.orderId != null, { orderId: buyOrder?.orderId, qty });

    await new Promise((r) => setTimeout(r, 400));

    // ٢) حساب مستويات وقف/هدف بسيطة (١٪ للاختبار فقط — لا النسب النهائية بعد)
    const stopPrice = Number((entryPrice * 0.99).toFixed(pricePrecision));   // ١٪ تحت الدخول
    const targetPrice = Number((entryPrice * 1.01).toFixed(pricePrecision)); // ١٪ فوق الدخول

    /**
     * ⚠️ إصلاح حرج بعد اكتشاف حقيقي: باينس نقلت الأوامر الشرطية
     * (STOP_MARKET/TAKE_PROFIT_MARKET) إلزامياً لنقطة API جديدة
     * (/fapi/v1/algoOrder) اعتباراً من 2025-12-09 — النقطة القديمة
     * (/fapi/v1/order) ترفضها الآن صراحة بخطأ -4120. هذا تغيير من
     * باينس نفسها، موثّق رسمياً، لا خطأ في منطقنا.
     */
    const stopOrder = await trade.signedRequest('POST', '/fapi/v1/algoOrder', {
      symbol: SYMBOL, side: 'SELL', type: 'STOP_MARKET',
      stopPrice, closePosition: 'true',
    });
    check('وضع أمر وقف الخسارة (STOP_MARKET عبر Algo API)', stopOrder?.algoId != null, {
      algoId: stopOrder?.algoId, stopPrice, type: stopOrder?.type,
    });

    const targetOrder = await trade.signedRequest('POST', '/fapi/v1/algoOrder', {
      symbol: SYMBOL, side: 'SELL', type: 'TAKE_PROFIT_MARKET',
      stopPrice: targetPrice, closePosition: 'true',
    });
    check('وضع أمر هدف الربح (TAKE_PROFIT_MARKET عبر Algo API)', targetOrder?.algoId != null, {
      algoId: targetOrder?.algoId, targetPrice, type: targetOrder?.type,
    });

    // ٥) التحقق الحاسم: هل الأمران يظهران فعلياً كأوامر شرطية معلّقة على باينس؟
    await new Promise((r) => setTimeout(r, 300));
    const openAlgoOrders = await trade.signedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol: SYMBOL });
    const algoList = Array.isArray(openAlgoOrders) ? openAlgoOrders : (openAlgoOrders?.algoOrders || []);
    const foundStop = algoList.find((o) => o.algoId === stopOrder?.algoId);
    const foundTarget = algoList.find((o) => o.algoId === targetOrder?.algoId);
    check('تأكيد ظهور الأمرين كأوامر شرطية معلّقة حقيقية على باينس', !!foundStop && !!foundTarget, {
      totalOpenAlgoOrders: algoList.length,
      stopOrderVisible: !!foundStop, targetOrderVisible: !!foundTarget,
    });

    // ٦) تنظيف: نُلغي الأمرين الشرطيين واحداً واحداً بمعرّف algoId (الطريقة المؤكدة رسمياً)
    if (stopOrder?.algoId) {
      await trade.signedRequest('DELETE', '/fapi/v1/algoOrder', { algoId: stopOrder.algoId });
    }
    if (targetOrder?.algoId) {
      await trade.signedRequest('DELETE', '/fapi/v1/algoOrder', { algoId: targetOrder.algoId });
    }
    check('إلغاء الأمرين المعلّقين (تنظيف الاختبار)', true, 'أُلغيا بنجاح — كانا اختباراً، لا مقصودَين للبقاء');

    const positionsNow = await trade.getPositions();
    const stillOpenPos = positionsNow.find((p) => p.symbol === SYMBOL && Number(p.positionAmt) !== 0);
    if (stillOpenPos) {
      const closeOrder = await trade.signedRequest('POST', '/fapi/v1/order', {
        symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity: qty, reduceOnly: 'true',
      });
      check('إغلاق المركز يدوياً (تنظيف نهائي)', closeOrder?.orderId != null, { orderId: closeOrder?.orderId });
    } else {
      check('إغلاق المركز يدوياً', true, 'لم يكن هناك مركز مفتوح للإغلاق — غير متوقع لكن آمن');
    }

    const allOk = results.every((r) => r.ok !== false);
    res.status(200).end(JSON.stringify({
      summary: allOk
        ? '✅ وقف الخسارة وهدف الربح يعملان كأوامر فعلية حقيقية على باينس — مؤكَّد'
        : '⚠️ توجد مشكلة — راجع التفاصيل',
      allOk, results,
    }, null, 2));
  } catch (e) {
    results.push({ name: 'خطأ عام', ok: false, detail: { message: e.message } });
    // محاولة تنظيف طارئة إن فشل شيء في المنتصف
    try {
      await trade.signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: SYMBOL });
      const pos = await trade.getPositions();
      const openPos = pos.find((p) => p.symbol === SYMBOL && Number(p.positionAmt) !== 0);
      if (openPos && qty) {
        await trade.signedRequest('POST', '/fapi/v1/order', {
          symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity: qty, reduceOnly: 'true',
        });
      }
      results.push({ name: 'تنظيف طارئ بعد الخطأ', ok: true, detail: 'حاولنا إغلاق كل شيء بأمان رغم الخطأ' });
    } catch (cleanupErr) {
      results.push({ name: 'تنظيف طارئ فشل أيضاً', ok: false, detail: {
        message: cleanupErr.message,
        warning: '⚠️ قد يبقى مركز أو أمر مفتوح — تحقق يدوياً من demo.binance.com فوراً',
      }});
    }
    res.status(200).end(JSON.stringify({ summary: '❌ فشل الاختبار', allOk: false, results }, null, 2));
  } finally {
    if (lockAcquired) { try { await releaseLock(lockKey); } catch { /* غير حرج */ } }
  }
};
