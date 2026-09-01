/**
 * api/tradetest.js
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 *
 * ⚠️ إصلاح جذري بعد اكتشاف حقيقي: حماية "فحص المركز أولاً" التي بنيت
 * سابقاً فشلت فعلياً — طلبان وصلا بالتزامن (على الأرجح بسبب إعادة
 * محاولة تلقائية من الشبكة/المتصفح بسبب بطء الاستجابة) أنتجا صفقتين
 * مكررتين رغم الحماية، لأن "الفحص ثم التصرف" (Check-then-Act) لا
 * يحمي من التزامن الحقيقي — كلا الطلبين يريان "لا يوجد مركز" معاً.
 *
 * الحل: قفل ذري حقيقي (Atomic Lock) عبر قيد PRIMARY KEY في Supabase.
 * قاعدة البيانات نفسها تضمن أن طلباً واحداً فقط ينجح في "حجز" القفل،
 * بصرف النظر عن التوقيت — لا نعتمد على قراءة ثم قرار، بل على رفض
 * قاعدة البيانات نفسها لأي محاولة ثانية بنفس المفتاح.
 *
 * الاستدعاء العادي:     /api/status?key=مفتاحك
 * الاستدعاء التنفيذي:   /api/status?key=مفتاحك&confirm=yes-place-order&symbol=ETHUSDT
 */
const trade = require('../lib/binanceTrade');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

async function sb(path, options = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

/** يحاول حجز القفل. true = نجح (نملك القفل الآن)، false = محجوز بالفعل */
async function tryAcquireLock(lockKey) {
  const r = await sb('trade_locks', {
    method: 'POST',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify([{ lock_key: lockKey }]),
  });
  // نجاح الإدراج = حصلنا على القفل. فشل بسبب تكرار المفتاح (409/23505) = محجوز بالفعل
  return r.ok;
}

async function releaseLock(lockKey) {
  await sb(`trade_locks?lock_key=eq.${encodeURIComponent(lockKey)}`, { method: 'DELETE' });
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });
  const wantsLiveTest = req.query?.confirm === 'yes-place-order';
  const SYMBOL = String(req.query?.symbol || 'ETHUSDT').toUpperCase();
  const lockKey = `trade:${SYMBOL}`;
  let lockAcquired = false;

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

    /* ---------------- ⚠️ القفل الذري الحقيقي ---------------- */
    lockAcquired = await tryAcquireLock(lockKey);
    if (!lockAcquired) {
      check('حجز القفل الذري', false, {
        message: `⛔ طلب آخر يحمل القفل على ${SYMBOL} بالفعل حالياً — تم رفض هذا الطلب فوراً من قاعدة البيانات نفسها`,
        lockKey,
      });
      res.status(200).end(JSON.stringify({
        summary: '⛔ تم رفض التنفيذ من طرف القفل الذري — طلب مكرر مُكتشَف بيقين رياضي',
        allOk: false, results,
      }, null, 2));
      return;
    }
    check('حجز القفل الذري', true, `تم حجز القفل بنجاح على ${SYMBOL} — لا طلب آخر يستطيع التنفيذ الآن`);

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
      symbol: SYMBOL, currentPrice, computedQty: qty,
      estimatedValueUSD: Number((qty * currentPrice).toFixed(2)),
    });

    const buyOrder = await trade.signedRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL, side: 'BUY', type: 'MARKET', quantity: qty,
    });
    check('تنفيذ أمر الشراء', buyOrder?.orderId != null, {
      orderId: buyOrder?.orderId, origQty: buyOrder?.origQty, status: buyOrder?.status,
    });

    await new Promise((r) => setTimeout(r, 800));
    const positionsAfterBuy = await trade.getPositions();
    const openPos = positionsAfterBuy.find((p) => p.symbol === SYMBOL && Number(p.positionAmt) !== 0);
    check('تأكيد فتح المركز فعلياً', !!openPos, openPos
      ? { positionAmt: openPos.positionAmt, entryPrice: openPos.entryPrice }
      : 'لم يظهر مركز مفتوح بعد الشراء');

    const sellOrder = await trade.signedRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity: qty, reduceOnly: 'true',
    });
    check('تنفيذ أمر الإغلاق', sellOrder?.orderId != null, {
      orderId: sellOrder?.orderId, origQty: sellOrder?.origQty, status: sellOrder?.status,
    });

    await new Promise((r) => setTimeout(r, 800));
    const positionsAfterSell = await trade.getPositions();
    const stillOpen = positionsAfterSell.find((p) => p.symbol === SYMBOL && Number(p.positionAmt) !== 0);
    check('تأكيد إغلاق المركز', !stillOpen, stillOpen || 'المركز مغلق بنجاح — لا كمية متبقية');

    const allOk = results.every((r) => r.ok !== false);
    res.status(200).end(JSON.stringify({
      summary: allOk
        ? `✅ اختبار التنفيذ نجح على ${SYMBOL} — محمي بقفل ذري حقيقي، لا تكرار ممكن`
        : '⚠️ توجد مشكلة — راجع التفاصيل',
      allOk, results,
    }, null, 2));
  } catch (e) {
    results.push({ name: 'خطأ عام', ok: false, detail: { message: e.message } });
    res.status(200).end(JSON.stringify({ summary: '❌ فشل الاختبار', allOk: false, results }, null, 2));
  } finally {
    // ⚠️ نُحرّر القفل دائماً، حتى لو حدث خطأ — وإلا يبقى محجوزاً للأبد
    if (lockAcquired) { try { await releaseLock(lockKey); } catch { /* غير حرج */ } }
  }
};
