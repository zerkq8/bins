/**
 * lib/botTrade.js
 * الدالة المركزية: تنفيذ دخول كامل محمي — تدمج كل القطع المُختبَرة
 * الليلة (الاتصال، القفل الذري، وضع الرافعة والهامش المعزول، الدخول،
 * وقف الخسارة وهدف الربح كأوامر Algo حقيقية).
 *
 * حساب النسب المؤكد:
 * - الهامش = نسبة٪ من الرصيد الحالي (لا الأصلي)
 * - الرافعة = رقم ثابت من الإعدادات (لا من رسالة الإشارة)
 * - وقف الخسارة/هدف الربح = نسبة٪ من الهامش نفسه، تُترجَم لحركة سعرية
 *   فعلية بقسمتها على الرافعة (مثال: هدف ٢٥٪ من الهامش برافعة ×١٠ =
 *   حركة سعرية فعلية ٢.٥٪ فقط)
 */
const trade = require('./binanceTrade');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const STALE_LOCK_MS = 30000;

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

async function releaseLock(lockKey) {
  await sb(`trade_locks?lock_key=eq.${encodeURIComponent(lockKey)}`, { method: 'DELETE' });
}

async function tryAcquireLock(lockKey) {
  const insertResult = await sb('trade_locks', {
    method: 'POST', headers: { prefer: 'return=minimal' },
    body: JSON.stringify([{ lock_key: lockKey }]),
  });
  if (insertResult.ok) return true;

  const res = await fetch(`${SB_URL}/rest/v1/trade_locks?lock_key=eq.${encodeURIComponent(lockKey)}&select=created_at`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  const data = await res.json();
  const createdAt = data?.[0]?.created_at ? new Date(data[0].created_at).getTime() : null;
  const age = createdAt ? Date.now() - createdAt : Infinity;
  if (age < STALE_LOCK_MS) return false;

  await releaseLock(lockKey);
  const retryResult = await sb('trade_locks', {
    method: 'POST', headers: { prefer: 'return=minimal' },
    body: JSON.stringify([{ lock_key: lockKey }]),
  });
  return retryResult.ok;
}

/**
 * ينفّذ دخولاً كاملاً محمياً بالكامل: هامش + رافعة + دخول + وقف + هدف.
 * @param {Object} p
 * @param {string} p.symbol - مثال: 'ETHUSDT'
 * @param {string} p.side - 'LONG' أو 'SHORT'
 * @param {Object} p.settings - { positionPct, leverage, stopLossPct, takeProfitPct }
 * @returns {Object} سجل كامل بكل خطوة، لتتبّع دقيق
 */
async function executeEntry({ symbol, side, settings }) {
  const SYMBOL = symbol.toUpperCase();
  const isLong = side === 'LONG';
  const lockKey = `trade:${SYMBOL}`;
  const log = [];
  const step = (name, ok, detail) => log.push({ name, ok, detail });
  let lockAcquired = false;

  try {
    lockAcquired = await tryAcquireLock(lockKey);
    if (!lockAcquired) {
      step('حجز القفل الذري', false, 'مرفوض — طلب آخر يحمل القفل بالفعل');
      return { success: false, log };
    }
    step('حجز القفل الذري', true, `تم حجزه على ${SYMBOL}`);

    // فحص إضافي: لا مركز موجود مسبقاً (حماية مزدوجة فوق القفل نفسه)
    const existingPositions = await trade.getPositions();
    const already = existingPositions.find((pos) => pos.symbol === SYMBOL && Number(pos.positionAmt) !== 0);
    if (already) {
      step('فحص مركز مكرر', false, `يوجد مركز مفتوح بالفعل على ${SYMBOL} — تم إيقاف الدخول`);
      return { success: false, log };
    }
    step('فحص مركز مكرر', true, 'لا مركز موجود مسبقاً — آمن للمتابعة');

    // وضع الهامش المعزول (Isolated) — نتجاهل الخطأ إن كان معزولاً بالفعل (-4046)
    try {
      await trade.signedRequest('POST', '/fapi/v1/marginType', { symbol: SYMBOL, marginType: 'ISOLATED' });
      step('ضبط وضع الهامش (Isolated)', true, 'تم التعيين بنجاح');
    } catch (e) {
      const alreadyIsolated = /No need to change margin type/i.test(e.message);
      step('ضبط وضع الهامش (Isolated)', alreadyIsolated, alreadyIsolated ? 'معزول بالفعل مسبقاً' : e.message);
      if (!alreadyIsolated) throw e;
    }

    // ضبط الرافعة الثابتة من الإعدادات
    await trade.signedRequest('POST', '/fapi/v1/leverage', { symbol: SYMBOL, leverage: settings.leverage });
    step('ضبط الرافعة', true, `×${settings.leverage}`);

    // حساب الهامش والكمية
    const account = await trade.getAccountInfo();
    const balance = parseFloat(account.availableBalance);
    const margin = balance * (settings.positionPct / 100);

    const exchangeInfo = await trade.publicRequest('/fapi/v1/exchangeInfo');
    const symbolInfo = exchangeInfo.symbols.find((s) => s.symbol === SYMBOL);
    if (!symbolInfo) throw new Error(`الرمز ${SYMBOL} غير موجود`);
    const lotSize = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE');
    const stepSize = parseFloat(lotSize.stepSize);
    const minQty = parseFloat(lotSize.minQty);
    const pricePrecision = symbolInfo.pricePrecision;

    const priceData = await trade.publicRequest(`/fapi/v1/ticker/price?symbol=${SYMBOL}`);
    const currentPrice = parseFloat(priceData.price);

    const notional = margin * settings.leverage;
    let qty = notional / currentPrice;
    const qSteps = Math.floor(qty / stepSize);
    qty = Math.max(qSteps * stepSize, minQty);
    const qDecimals = (stepSize.toString().split('.')[1] || '').length;
    qty = Number(qty.toFixed(qDecimals));

    step('حساب الهامش والكمية', true, {
      balance, margin: Number(margin.toFixed(2)), leverage: settings.leverage,
      notional: Number(notional.toFixed(2)), qty, currentPrice,
    });

    // الدخول الفعلي
    const entryOrder = await trade.signedRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL, side: isLong ? 'BUY' : 'SELL', type: 'MARKET', quantity: qty,
    });
    step('تنفيذ أمر الدخول', entryOrder?.orderId != null, { orderId: entryOrder?.orderId, qty });

    await new Promise((r) => setTimeout(r, 400));
    const posAfterEntry = await trade.getPositions();
    const openPos = posAfterEntry.find((p) => p.symbol === SYMBOL && Number(p.positionAmt) !== 0);
    if (!openPos) throw new Error('لم يظهر المركز بعد الدخول — توقف فوري');
    const entryPrice = parseFloat(openPos.entryPrice);
    step('تأكيد فتح المركز', true, { entryPrice, positionAmt: openPos.positionAmt });

    // حساب مستويات الوقف والهدف من نسبة الهامش، عبر الرافعة
    const stopMovePct = settings.stopLossPct / settings.leverage;
    const targetMovePct = settings.takeProfitPct / settings.leverage;
    const stopPrice = Number((isLong
      ? entryPrice * (1 - stopMovePct / 100)
      : entryPrice * (1 + stopMovePct / 100)).toFixed(pricePrecision));
    const targetPrice = Number((isLong
      ? entryPrice * (1 + targetMovePct / 100)
      : entryPrice * (1 - targetMovePct / 100)).toFixed(pricePrecision));

    step('حساب مستويات الوقف والهدف', true, { stopMovePct, targetMovePct, stopPrice, targetPrice });

    const closeSide = isLong ? 'SELL' : 'BUY';
    const stopOrder = await trade.signedRequest('POST', '/fapi/v1/algoOrder', {
      symbol: SYMBOL, side: closeSide, type: 'STOP_MARKET', algoType: 'CONDITIONAL',
      triggerPrice: stopPrice, closePosition: 'true',
    });
    step('وضع وقف الخسارة (Algo)', stopOrder?.algoId != null, { algoId: stopOrder?.algoId, stopPrice });

    const targetOrder = await trade.signedRequest('POST', '/fapi/v1/algoOrder', {
      symbol: SYMBOL, side: closeSide, type: 'TAKE_PROFIT_MARKET', algoType: 'CONDITIONAL',
      triggerPrice: targetPrice, closePosition: 'true',
    });
    step('وضع هدف الربح (Algo)', targetOrder?.algoId != null, { algoId: targetOrder?.algoId, targetPrice });

    return {
      success: true, log,
      summary: { symbol: SYMBOL, side, entryPrice, qty, margin, leverage: settings.leverage, stopPrice, targetPrice },
    };
  } catch (e) {
    log.push({ name: 'خطأ عام', ok: false, detail: { message: e.message } });
    return { success: false, log };
  } finally {
    if (lockAcquired) { try { await releaseLock(lockKey); } catch { /* غير حرج */ } }
  }
}

module.exports = { executeEntry };
