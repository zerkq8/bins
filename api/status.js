/**
 * api/tradetest.js
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 *
 * الوضع الافتراضي (بلا معامل إضافي): فحص قراءة فقط، آمن تماماً —
 * نفس فحص الاتصال والحساب والمراكز الذي نجح سابقاً.
 *
 * ⚠️ الوضع التنفيذي (يحتاج ?confirm=yes-place-order صراحة): ينفّذ
 * أمر شراء حقيقي (Market Buy) بأصغر كمية ممكنة على BTCUSDT، يتحقق من
 * فتح المركز فعلياً، ثم يغلقه فوراً بأمر بيع مطابق. هذا يثبت أن
 * التنفيذ الفعلي (لا القراءة فقط) يعمل بنجاح، قبل بناء أي أتمتة كاملة.
 *
 * الاستدعاء العادي:     /api/status?key=مفتاحك
 * الاستدعاء التنفيذي:   /api/status?key=مفتاحك&confirm=yes-place-order
 */
const trade = require('../lib/binanceTrade');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });
  const wantsLiveTest = req.query?.confirm === 'yes-place-order';

  try {
    const hasKey = !!process.env.BINANCE_DEMO_API_KEY;
    const hasSecret = !!process.env.BINANCE_DEMO_API_SECRET;
    check('مفاتيح Demo Trading موجودة', hasKey && hasSecret, { hasKey, hasSecret });
    if (!hasKey || !hasSecret) throw new Error('لا يمكن المتابعة بلا مفاتيح');

    const pingResult = await trade.ping();
    check('الاتصال بـ demo-fapi.binance.com', JSON.stringify(pingResult) === '{}', pingResult);

    const account = await trade.getAccountInfo();
    check('التحقق من الحساب', !!account?.totalWalletBalance, {
      totalWalletBalance: account?.totalWalletBalance,
      canTrade: account?.canTrade,
    });

    if (!wantsLiveTest) {
      check('الوضع الحالي', true, 'قراءة فقط — أضِف &confirm=yes-place-order لتشغيل اختبار تنفيذ حقيقي محدود');
      const allOk = results.every((r) => r.ok !== false);
      res.status(200).end(JSON.stringify({
        summary: allOk ? '✅ فحص القراءة نجح — لم يُنفَّذ أي أمر بعد' : '⚠️ مشكلة — راجع التفاصيل',
        allOk, results,
      }, null, 2));
      return;
    }

    /* ---------------- الاختبار التنفيذي المحدود ---------------- */
    const SYMBOL = 'BTCUSDT';

    // ١) نجلب فلاتر باينس الحقيقية الحالية لهذا الرمز — لا بيانات افتراضية
    const exchangeInfo = await trade.publicRequest('/fapi/v1/exchangeInfo');
    const symbolInfo = exchangeInfo.symbols.find((s) => s.symbol === SYMBOL);
    if (!symbolInfo) throw new Error(`لم يوجد الرمز ${SYMBOL} في exchangeInfo`);

    const lotSize = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE');
    const minNotionalFilter = symbolInfo.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
    const stepSize = parseFloat(lotSize.stepSize);
    const minQty = parseFloat(lotSize.minQty);
    const minNotional = parseFloat(minNotionalFilter?.notional || '5');

    // ٢) السعر الحالي
    const priceData = await trade.publicRequest(`/fapi/v1/ticker/price?symbol=${SYMBOL}`);
    const currentPrice = parseFloat(priceData.price);

    // ٣) أصغر كمية صحيحة تحقق الحد الأدنى للقيمة
    const rawQty = minNotional / currentPrice;
    const steps = Math.ceil(rawQty / stepSize);
    let qty = Math.max(steps * stepSize, minQty);
    const decimals = (stepSize.toString().split('.')[1] || '').length;
    qty = Number(qty.toFixed(decimals));

    check('حساب أصغر كمية مسموحة', qty > 0, {
      currentPrice, stepSize, minQty, minNotional, computedQty: qty,
      estimatedValueUSD: Number((qty * currentPrice).toFixed(2)),
    });

    // ٤) أمر الشراء الفعلي (Market Buy)
    const buyOrder = await trade.signedRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: qty,
    });
    check('تنفيذ أمر الشراء', buyOrder?.status === 'FILLED' || buyOrder?.orderId != null, buyOrder);

    // ٥) تأكيد أن المركز فُتح فعلياً
    await new Promise((r) => setTimeout(r, 800));
    const positionsAfterBuy = await trade.getPositions();
    const openPos = positionsAfterBuy.find((p) => p.symbol === SYMBOL && Number(p.positionAmt) !== 0);
    check('تأكيد فتح المركز فعلياً', !!openPos, openPos
      ? { symbol: openPos.symbol, positionAmt: openPos.positionAmt, entryPrice: openPos.entryPrice }
      : 'لم يظهر مركز مفتوح بعد الشراء');

    // ٦) إغلاق فوري بأمر بيع مطابق (reduceOnly لضمان أنه إغلاق لا فتح شورت جديد)
    const sellOrder = await trade.signedRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity: qty, reduceOnly: 'true',
    });
    check('تنفيذ أمر الإغلاق', sellOrder?.status === 'FILLED' || sellOrder?.orderId != null, sellOrder);

    // ٧) تأكيد نهائي أن المركز أُغلق فعلاً
    await new Promise((r) => setTimeout(r, 800));
    const positionsAfterSell = await trade.getPositions();
    const stillOpen = positionsAfterSell.find((p) => p.symbol === SYMBOL && Number(p.positionAmt) !== 0);
    check('تأكيد إغلاق المركز', !stillOpen, stillOpen || 'المركز مغلق بنجاح — لا كمية متبقية');

    const allOk = results.every((r) => r.ok !== false);
    res.status(200).end(JSON.stringify({
      summary: allOk
        ? '✅ اختبار التنفيذ الكامل نجح — شراء وإغلاق فعليان على Demo Trading'
        : '⚠️ توجد مشكلة في التنفيذ — راجع التفاصيل بعناية',
      allOk, results,
    }, null, 2));
  } catch (e) {
    results.push({ name: 'خطأ عام', ok: false, detail: { message: e.message } });
    res.status(200).end(JSON.stringify({ summary: '❌ فشل الاختبار', allOk: false, results }, null, 2));
  }
};
