/**
 * lib/botTrade.js
 * الدالة المركزية: تنفيذ دخول كامل محمي — تدمج كل القطع المُختبَرة
 * الليلة (الاتصال، القفل الذري، وضع الرافعة والهامش المعزول، الدخول،
 * وقف الخسارة وهدف الربح كأوامر Algo حقيقية).
 *
 * حساب النسب المؤكد:
 * - الهامش = مبلغ ثابت بالدولار من الإعدادات (settings.positionAmount)،
 *   لا نسبة من الرصيد — يُتحقَّق من كفاية الرصيد فوراً قبل أي خطوة أخرى
 * - الرافعة = رقم ثابت من الإعدادات (لا من رسالة الإشارة)
 * - وقف الخسارة/هدف الربح:
 *   - إذا atrEnabled = false (أو غير موجود): نسبة٪ ثابتة تماماً كما
 *     أُدخلت في الإعدادات — مبلغ مضمون بالدولار دائماً.
 *   - إذا atrEnabled = true: نسبة٪ بمنطق "حد أدنى مضمون" = القيمة
 *     المُدخلة، مع إمكانية التوسع حتى 3× على العملات شديدة التقلب
 *     (حسب ATR الخاص بكل عملة وقت الدخول).
 */
const trade = require('./binanceTrade');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const STALE_LOCK_MS = 30000;

const ATR_REFERENCE_PCT = 20;
const ATR_MULTIPLIER_MIN = 0.5;
const ATR_MULTIPLIER_MAX = 3;
const MAX_EXPANSION_FACTOR = 3;

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

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
 * ATR% (متوسط المدى الحقيقي كنسبة من السعر) لعملة معيّنة — من آخر 14
 * شمعة 1 ساعة، بيانات عامة بلا توقيع. تُرجع null عند أي تعذّر.
 * ⚠️ 14 شمعة تعطي 13 قيمة True Range فقط (كل TR يحتاج إغلاق الشمعة
 * السابقة كمرجع) — تقريب مقصود بدل جلب شمعة خامسة عشرة إضافية.
 */
const ATR_FETCH_TIMEOUT_MS = 5000;

async function computeAtrPercent(symbol, referencePrice) {
  if (!referencePrice || !Number.isFinite(referencePrice)) return null;
  const klines = await Promise.race([
    trade.publicRequest(`/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=14`),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`تجاوز مهلة جلب الشموع (${ATR_FETCH_TIMEOUT_MS}ms)`)), ATR_FETCH_TIMEOUT_MS)),
  ]);
  if (!Array.isArray(klines) || klines.length < 2) return null;

  const trueRanges = [];
  for (let i = 1; i < klines.length; i++) {
    const high = parseFloat(klines[i][2]);
    const low = parseFloat(klines[i][3]);
    const prevClose = parseFloat(klines[i - 1][4]);
    if (![high, low, prevClose].every(Number.isFinite)) continue;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (!trueRanges.length) return null;

  const atr = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
  if (!Number.isFinite(atr) || atr <= 0) return null;
  return (atr / referencePrice) * 100;
}

/**
 * يحسب النسبة النهائية بمنطق "حد أدنى مضمون": لا تقل أبداً عن basePct،
 * ويمكن أن تكبر حتى basePct × MAX_EXPANSION_FACTOR كحد أقصى.
 */
function computeFlooredPct(basePct, atrPct) {
  if (!atrPct || !Number.isFinite(atrPct) || atrPct <= 0) return basePct;
  const multiplier = clamp(basePct / ATR_REFERENCE_PCT, ATR_MULTIPLIER_MIN, ATR_MULTIPLIER_MAX);
  const proposed = atrPct * multiplier;
  const maxAllowed = basePct * MAX_EXPANSION_FACTOR;
  return Math.max(basePct, Math.min(proposed, maxAllowed));
}

/**
 * ينفّذ دخولاً كاملاً محمياً بالكامل: هامش + رافعة + دخول + وقف + هدف.
 * @param {Object} p
 * @param {string} p.symbol - مثال: 'ETHUSDT'
 * @param {string} p.side - 'LONG' أو 'SHORT'
 * @param {Object} p.settings - { positionAmount, leverage, stopLossPct, takeProfitPct, atrEnabled }
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

    const existingPositions = await trade.getPositions();
    const already = existingPositions.find((pos) => pos.symbol === SYMBOL && Number(pos.positionAmt) !== 0);
    if (already) {
      step('فحص مركز مكرر', false, `يوجد مركز مفتوح بالفعل على ${SYMBOL} — تم إيقاف الدخول`);
      return { success: false, log };
    }
    step('فحص مركز مكرر', true, 'لا مركز موجود مسبقاً — آمن للمتابعة');

    // فحص كفاية الرصيد للمبلغ الثابت — فوراً، قبل أي إعداد أو أمر آخر.
    // لو الرصيد غير كافٍ، توقف هنا تماماً: لا ضبط هامش/رافعة، لا حساب
    // كمية، لا أمر دخول.
    const account = await trade.getAccountInfo();
    const balance = parseFloat(account.availableBalance);
    const margin = settings.positionAmount;
    if (balance < margin) {
      step('فحص كفاية الرصيد', false,
        `الرصيد المتاح ($${balance.toFixed(2)}) أقل من المبلغ الثابت المطلوب ($${margin.toFixed(2)}) — تم تجاهل الدخول دون تنفيذ أي شيء`);
      return { success: false, log };
    }
    step('فحص كفاية الرصيد', true, `الرصيد المتاح ($${balance.toFixed(2)}) كافٍ للمبلغ الثابت ($${margin.toFixed(2)})`);

    try {
      await trade.signedRequest('POST', '/fapi/v1/marginType', { symbol: SYMBOL, marginType: 'ISOLATED' });
      step('ضبط وضع الهامش (Isolated)', true, 'تم التعيين بنجاح');
    } catch (e) {
      const alreadyIsolated = /No need to change margin type/i.test(e.message);
      step('ضبط وضع الهامش (Isolated)', alreadyIsolated, alreadyIsolated ? 'معزول بالفعل مسبقاً' : e.message);
      if (!alreadyIsolated) throw e;
    }

    await trade.signedRequest('POST', '/fapi/v1/leverage', { symbol: SYMBOL, leverage: settings.leverage });
    step('ضبط الرافعة', true, `×${settings.leverage}`);

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

    // وقف/هدف — يعتمد على مفتاح التفعيل atrEnabled في الإعدادات:
    // false (أو غير موجود) → القيمة المُدخلة كما هي، بلا أي تعديل
    // true → منطق "حد أدنى مضمون" مع ATR (كما كان سابقاً)
    let atrInfo = null;
    let stopLossPct = settings.stopLossPct;
    let takeProfitPct = settings.takeProfitPct;
    const atrEnabled = settings.atrEnabled === true;

    if (!atrEnabled) {
      step('الوقف/الهدف المتكيّف (ATR)', true, 'معطَّل من الإعدادات — استُخدمت النسبة الثابتة المُدخلة كما هي');
    } else {
      try {
        const atrPct = await computeAtrPercent(SYMBOL, entryPrice);
        if (atrPct && Number.isFinite(atrPct) && atrPct > 0) {
          stopLossPct = computeFlooredPct(settings.stopLossPct, atrPct);
          takeProfitPct = computeFlooredPct(settings.takeProfitPct, atrPct);
          atrInfo = { atrPct: Number(atrPct.toFixed(3)) };
          step('حساب ATR وتطبيق الحد الأدنى/الأقصى', true, {
            atrPct: Number(atrPct.toFixed(3)),
            baseStopLossPct: settings.stopLossPct, finalStopLossPct: Number(stopLossPct.toFixed(2)),
            baseTakeProfitPct: settings.takeProfitPct, finalTakeProfitPct: Number(takeProfitPct.toFixed(2)),
          });
        } else {
          step('حساب ATR', false, 'ATR غير صالح — استُخدمت القيمة المُدخلة كما هي بلا تعديل');
        }
      } catch (e) {
        step('حساب ATR', false, `فشل جلب/حساب ATR: ${e.message} — استُخدمت القيمة المُدخلة كما هي بلا تعديل`);
      }
    }

    const stopMovePct = stopLossPct / settings.leverage;
    const targetMovePct = takeProfitPct / settings.leverage;
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
      summary: {
        symbol: SYMBOL, side, entryPrice, qty, margin, leverage: settings.leverage, stopPrice, targetPrice,
        stopLossPct: Number(stopLossPct.toFixed(2)), takeProfitPct: Number(takeProfitPct.toFixed(2)),
        atrEnabled, atrInfo,
      },
    };
  } catch (e) {
    log.push({ name: 'خطأ عام', ok: false, detail: { message: e.message } });
    return { success: false, log };
  } finally {
    if (lockAcquired) { try { await releaseLock(lockKey); } catch { /* غير حرج */ } }
  }
}


/**
 * ⚠️ الإغلاق الطارئ الكامل — تُلغي كل الأوامر الشرطية المعلّقة على كل
 * العملات، ثم تُغلق كل مركز مفتوح حالياً بأمر سوق فوري. تُستخدم فقط
 * من زر "إغلاق كل شيء الآن" في لوحة التحكم، لا من المسار التلقائي.
 */
async function emergencyStopAll() {
  const log = [];
  const step = (name, ok, detail) => log.push({ name, ok, detail });

  try {
    const allPositions = await trade.getPositions();
    const openPositions = allPositions.filter((p) => Number(p.positionAmt) !== 0);
    step('اكتشاف المراكز المفتوحة', true, {
      count: openPositions.length, symbols: openPositions.map((p) => p.symbol),
    });

    if (!openPositions.length) {
      step('النتيجة', true, 'لا مراكز مفتوحة أصلاً — لا شيء يحتاج إغلاقاً');
      return { success: true, log };
    }

    for (const pos of openPositions) {
      const symbol = pos.symbol;
      try {
        const openAlgo = await trade.signedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol });
        const algoList = Array.isArray(openAlgo) ? openAlgo : (openAlgo?.algoOrders || []);
        for (const o of algoList) {
          await trade.signedRequest('DELETE', '/fapi/v1/algoOrder', { algoId: o.algoId });
        }
        step(`إلغاء أوامر ${symbol} الشرطية`, true, `أُلغي ${algoList.length} أمراً`);
      } catch (e) {
        step(`إلغاء أوامر ${symbol} الشرطية`, false, e.message);
      }

      try {
        const amt = Number(pos.positionAmt);
        const closeSide = amt > 0 ? 'SELL' : 'BUY';
        const closeOrder = await trade.signedRequest('POST', '/fapi/v1/order', {
          symbol, side: closeSide, type: 'MARKET', quantity: Math.abs(amt), reduceOnly: 'true',
        });
        step(`إغلاق مركز ${symbol}`, closeOrder?.orderId != null, {
          orderId: closeOrder?.orderId, closedAmount: Math.abs(amt),
        });
      } catch (e) {
        step(`إغلاق مركز ${symbol}`, false, e.message);
      }
    }

    const allOk = log.every((l) => l.ok !== false);
    return { success: allOk, log };
  } catch (e) {
    log.push({ name: 'خطأ عام في الإغلاق الطارئ', ok: false, detail: e.message });
    return { success: false, log };
  }
}

module.exports = { executeEntry, emergencyStopAll };
