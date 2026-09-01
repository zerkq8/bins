/**
 * api/tradetest.js
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 *
 * تحديث مهم بعد اكتشاف حقيقي: أُضيفت حماية "لا مركز مكرر على نفس
 * العملة" — قبل أي شراء، نتحقق أولاً هل يوجد مركز مفتوح بالفعل على
 * نفس الرمز. إن وُجد، نتوقف فوراً بدل تكرار الصفقة. هذا يحمي من أي
 * تنفيذ مزدوج عرضي (نقرة مزدوجة، إعادة تحميل، إلخ) — ونفس المنطق
 * سيكون جوهرياً في البوت الكامل لاحقاً (قاعدة "مركز واحد لكل عملة").
 *
 * الاستدعاء العادي:     /api/status?key=مفتاحك
 * الاستدعاء التنفيذي:   /api/status?key=مفتاحك&confirm=yes-place-order&symbol=ETHUSDT
 */
const trade = require('../lib/binanceTrade');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });
  const wantsLiveTest = req.query?.confirm === 'yes-place-order';
  const SYMBOL = String(req.query?.symbol || 'ETHUSDT').toUpperCase();

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
      check('الوضع الحالي', true, 'قراءة فقط — أضِف &confirm=yes-place-order&symbol=ETHUSDT لاختبار تنفيذ حقيقي');
      const allOk = results.every((r) => r.ok !== false);
      res.status(200).end(JSON.stringify({
        summary: allOk ? '✅ فحص القراءة نجح — لم يُنفَّذ أي أمر بعد' : '⚠️ مشكلة — راجع التفاصيل',
        allOk, results,
      }, null, 2));
      return;
    }

    /* ---------------- ⚠️ الحماية الجديدة: لا مركز مكرر ---------------- */
    const positionsBeforeAnything = await trade.getPositions();
    const existingPos = positionsBeforeAnything.find(
      (p) => p.symbol === SYMBOL && Number(p.positionAmt) !== 0
    );
    if (existingPos) {
      check('فحص مركز مكرر', false, {
        message: `⚠️ يوجد مركز مفتوح بالفعل على ${SYMBOL} — تم إيقاف التنفيذ لمنع التكرار`,
        existingPosition: { symbol: existingPos.symbol, positionAmt: existingPos.positionAmt, entryPrice: existingPos.entryPrice },
      });
      res.status(200).end(JSON.stringify({
        summary: '⛔ تم إيقاف التنفيذ — مركز مكرر مكتشف على نفس العملة',
        allOk: false, results,
      }, null, 2));
      return;
    }
    check('فحص مركز مكرر', true, `لا مركز موجود مسبقاً على ${SYMBOL} — آمن للمتابعة`);

    /* ---------------- الاختبار التنفيذي ---------------- */
    const exchangeInfo = await trade.publicRequest('/fapi/v1/exchangeInfo');
    const symbolInfo = exchangeInfo.symbols.find((s) => s.symbol === SYMBOL);
    if (!symbolInfo) throw new Error(`لم يوجد الرمز ${SYMBOL} في exchangeInfo`);

    const lotSize = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE');
    const minNotionalFilter = symbolInfo.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
    const stepSize = parseFloat(lotSize.stepSize);
    const minQty = parseFloat(lotSize.minQty);
    const minNotional = parseFloat(minNotionalFilter?.notional || '5');

    const priceData = await trade.publicRequest(`/fapi/v1/ticker/price?symbol=${SYMBOL}`);
    const currentPrice = parseFloat(priceData.price);

    const rawQty = minNotional / currentPrice;
    const steps = Math.ceil(rawQty / stepSize);
    let qty = Math.max(steps * stepSize, minQty);
    const decimals = (stepSize.toString().split('.')[1] || '').length;
    qty = Number(qty.toFixed(decimals));

    check('حساب أصغر كمية مسموحة', qty > 0, {
      symbol: SYMBOL, currentPrice, stepSize, minQty, minNotional, computedQty: qty,
      estimatedValueUSD: Number((qty * currentPrice).toFixed(2)),
    });

    const buyOrder = await trade.signedRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: qty,
    });
    check('تنفيذ أمر الشراء', buyOrder?.orderId != null, {
      orderId: buyOrder?.orderId, symbol: buyOrder?.symbol, side: buyOrder?.side,
      origQty: buyOrder?.origQty, status: buyOrder?.status,
    });

    await new Promise((r) => setTimeout(r, 800));
    const positionsAfterBuy = await trade.getPositions();
    const openPos = positionsAfterBuy.find((p) => p.symbol === SYMBOL && Number(p.positionAmt) !== 0);
    check('تأكيد فتح المركز فعلياً', !!openPos, openPos
      ? { symbol: openPos.symbol, positionAmt: openPos.positionAmt, entryPrice: openPos.entryPrice }
      : 'لم يظهر مركز مفتوح بعد الشراء');

    const sellOrder = await trade.signedRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity: qty, reduceOnly: 'true',
    });
    check('تنفيذ أمر الإغلاق', sellOrder?.orderId != null, {
      orderId: sellOrder?.orderId, symbol: sellOrder?.symbol, side: sellOrder?.side,
      origQty: sellOrder?.origQty, status: sellOrder?.status,
    });

    await new Promise((r) => setTimeout(r, 800));
    const positionsAfterSell = await trade.getPositions();
    const stillOpen = positionsAfterSell.find((p) => p.symbol === SYMBOL && Number(p.positionAmt) !== 0);
    check('تأكيد إغلاق المركز', !stillOpen, stillOpen || 'المركز مغلق بنجاح — لا كمية متبقية');

    const allOk = results.every((r) => r.ok !== false);
    res.status(200).end(JSON.stringify({
      summary: allOk
        ? `✅ اختبار التنفيذ نجح على ${SYMBOL} — شراء وإغلاق فعليان، بلا تكرار`
        : '⚠️ توجد مشكلة — راجع التفاصيل',
      allOk, results,
    }, null, 2));
  } catch (e) {
    results.push({ name: 'خطأ عام', ok: false, detail: { message: e.message } });
    res.status(200).end(JSON.stringify({ summary: '❌ فشل الاختبار', allOk: false, results }, null, 2));
  }
};
