/**
 * بيانات السوق العامة من باينس — موثّقة رسمياً وثابتة (بعكس نقاط Copy Trading).
 * الغرض: تعليم القراءة، لا إعطاء توصيات.
 */

const FAPI = 'https://fapi.binance.com';   // العقود الآجلة
const API  = 'https://api.binance.com';    // الفوري

const HEADERS = { accept: 'application/json' };

async function get(base, path) {
  const res = await fetch(base + path, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`باينس ردّت ${res.status}: ${text.slice(0, 160)}`);
    err.binanceStatus = res.status;
    err.binanceBody = text;
    throw err;
  }
  return JSON.parse(text);
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const isBadSymbol = (e) => e?.binanceBody?.includes('"code":-1121');

/**
 * إحصاءات ٢٤ ساعة + شموع يومية لحساب التقلب والمدى.
 * ⚠️ بعض الرموز (مثل عقود ما-قبل-الاكتتاب Pre-IPO كـ SPCXUSDT) مُدرَجة
 * في سوق العقود الآجلة فقط ولا وجود لها في السوق الفوري — نجرّب الفوري
 * أولاً، وعند رفض باينس له تحديداً (-1121) نعيد المحاولة على الآجلة.
 */
async function getSymbol(symbol) {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s || s.length < 5) throw new Error('رمز غير صالح. مثال: BTCUSDT');

  let base = API, market = 'spot';
  let ticker, klines;
  try {
    [ticker, klines] = await Promise.all([
      get(API, `/api/v3/ticker/24hr?symbol=${s}`),
      get(API, `/api/v3/klines?symbol=${s}&interval=1d&limit=30`),
    ]);
  } catch (e) {
    if (!isBadSymbol(e)) throw e;
    // غير موجود في الفوري — جرّب العقود الآجلة (تغطي عقود Pre-IPO وغيرها)
    try {
      base = FAPI; market = 'futures';
      [ticker, klines] = await Promise.all([
        get(FAPI, `/fapi/v1/ticker/24hr?symbol=${s}`),
        get(FAPI, `/fapi/v1/klines?symbol=${s}&interval=1d&limit=30`),
      ]);
    } catch (e2) {
      if (isBadSymbol(e2)) {
        throw new Error(`الرمز "${s}" غير موجود لا في الفوري ولا في العقود الآجلة. تحقق من كتابته على باينس.`);
      }
      throw e2;
    }
  }

  const candles = klines.map((k) => ({
    time: k[0], open: num(k[1]), high: num(k[2]), low: num(k[3]),
    close: num(k[4]), volume: num(k[5]),
  }));

  const closes = candles.map((c) => c.close);
  const price = num(ticker.lastPrice);

  // المدى الحقيقي المتوسط (ATR) — مقياس التقلب اليومي
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  const atr14 = trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length);

  // الانحراف المعياري للعوائد اليومية — نسبة التقلب
  const rets = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length);

  const ma = (n) => {
    const part = closes.slice(-n);
    return part.length ? part.reduce((a, b) => a + b, 0) / part.length : null;
  };

  const hi30 = Math.max(...candles.map((c) => c.high));
  const lo30 = Math.min(...candles.map((c) => c.low));

  return {
    symbol: s,
    market,   // 'spot' أو 'futures' — لتوضيح مصدر البيانات في الواجهة
    price,
    change24h: num(ticker.priceChangePercent),
    high24h: num(ticker.highPrice),
    low24h: num(ticker.lowPrice),
    volume24h: num(ticker.quoteVolume),
    trades24h: num(ticker.count),
    atr14,
    atrPct: price ? (atr14 / price) * 100 : null,
    volatilityPct: sd * 100,
    ma7: ma(7),
    ma30: ma(30),
    high30: hi30,
    low30: lo30,
    posInRange: (hi30 - lo30) ? ((price - lo30) / (hi30 - lo30)) * 100 : null,
    candles: candles.map((c) => ({ t: c.time, c: c.close })),
    fetchedAt: Date.now(),
  };
}


/**
 * السياق التاريخي — عدّاد صادق، ليس احتمالاً.
 *
 * ⚠️ هذا ليس تنبؤاً ولا نسبة موثوقة. نجلب ~١٨٠ يوماً من الشموع،
 * نحدد "وضع" كل يوم (موقعه في مدى ٣٠ يوماً + اتجاه المتوسطات)،
 * نطابقه بوضع اليوم الحالي، ثم نعدّ: كم مرة تكرر هذا الوضع بالضبط
 * تاريخياً، وماذا حدث للسعر بعده فعلياً (بعد أفق زمني محدد).
 *
 * العيّنات صغيرة حتماً (بيانات يومية محدودة) — لهذا نُرجع دائماً
 * الأعداد الخام (٣ من ٥) لا نسبة مئوية، مع علم صريح إن كانت العيّنة
 * أصغر من حد معقول للثقة الإحصائية.
 */
function regimeOf(candles, i, lookback = 30) {
  if (i < lookback) return null;
  const window = candles.slice(i - lookback + 1, i + 1);
  const hi = Math.max(...window.map((c) => c.high));
  const lo = Math.min(...window.map((c) => c.low));
  const price = candles[i].close;
  const pos = (hi - lo) ? (price - lo) / (hi - lo) : 0.5;

  const posBucket = pos > 0.66 ? 'high' : pos < 0.33 ? 'low' : 'mid';

  const ma = (n) => {
    if (i < n - 1) return null;
    const part = candles.slice(i - n + 1, i + 1).map((c) => c.close);
    return part.reduce((a, b) => a + b, 0) / part.length;
  };
  const ma7 = ma(7), ma30 = ma(Math.min(30, lookback));
  if (ma7 === null || ma30 === null) return null;
  const trendBucket = ma7 > ma30 * 1.005 ? 'up' : ma7 < ma30 * 0.995 ? 'down' : 'flat';

  return { posBucket, trendBucket, key: `${posBucket}|${trendBucket}` };
}

async function getHistoricalContext(symbol, { horizonDays = 3, lookbackDays = 180 } = {}) {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s || s.length < 5) throw new Error('رمز غير صالح. مثال: BTCUSDT');

  let base = API, market = 'spot', klines;
  try {
    klines = await get(API, `/api/v3/klines?symbol=${s}&interval=1d&limit=${lookbackDays}`);
  } catch (e) {
    if (!isBadSymbol(e)) throw e;
    base = FAPI; market = 'futures';
    klines = await get(FAPI, `/fapi/v1/klines?symbol=${s}&interval=1d&limit=${lookbackDays}`);
  }

  const candles = klines.map((k) => ({
    time: k[0], open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]),
  }));

  if (candles.length < 40) {
    return {
      symbol: s, market, available: false,
      reason: 'سجل قصير جداً على باينس لهذا الرمز — لا يكفي لأي مقارنة تاريخية.',
    };
  }

  const lastIdx = candles.length - 1;
  const today = regimeOf(candles, lastIdx);
  if (!today) {
    return { symbol: s, market, available: false, reason: 'تعذّر تحديد وضع اليوم الحالي.' };
  }

  // نبحث في الماضي (باستثناء آخر horizonDays حتى لا نطابق نفس اليوم)
  let up = 0, down = 0, flat = 0;
  const upMoves = [], downMoves = [];   // لحساب متوسط حجم الحركة الفعلي، لا العدد فقط
  const matches = [];
  for (let i = 30; i <= lastIdx - horizonDays; i++) {
    const r = regimeOf(candles, i);
    if (!r || r.key !== today.key) continue;
    const now_ = candles[i].close;
    const future = candles[i + horizonDays].close;
    const changePct = ((future - now_) / now_) * 100;
    if (changePct > 0.5) { up++; upMoves.push(changePct); }
    else if (changePct < -0.5) { down++; downMoves.push(changePct); }
    else flat++;
    matches.push({ date: candles[i].time, changePct: Math.round(changePct * 100) / 100 });
  }

  const total = up + down + flat;
  const posLabel = { high: 'قرب قمة المدى', mid: 'وسط المدى', low: 'قرب قاع المدى' }[today.posBucket];
  const trendLabel = { up: 'صاعد', down: 'هابط', flat: 'متعادل' }[today.trendBucket];
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

  // أعلى قمة وأدنى قاع خلال كامل فترة البحث — أرقام فعلية، لا نِسَب
  const allHighs = candles.map((c) => c.high);
  const allLows = candles.map((c) => c.low);
  const periodHigh = Math.max(...allHighs);
  const periodLow = Math.min(...allLows);
  const periodHighDate = candles[allHighs.indexOf(periodHigh)].time;
  const periodLowDate = candles[allLows.indexOf(periodLow)].time;
  const currentPrice = candles[lastIdx].close;

  return {
    symbol: s, market, available: true,
    todayLabel: `${posLabel} · اتجاه ${trendLabel}`,
    horizonDays, lookbackDays: candles.length,
    total, up, down, flat,
    avgUpMovePct: avg(upMoves) !== null ? Math.round(avg(upMoves) * 100) / 100 : null,
    avgDownMovePct: avg(downMoves) !== null ? Math.round(avg(downMoves) * 100) / 100 : null,
    smallSample: total < 15,      // أقل من ١٥ تكراراً = عيّنة ضعيفة جداً
    veryHighConfidenceNeeded: total < 5,
    recentExamples: matches.slice(-5),
    period: {
      high: periodHigh, highDate: periodHighDate,
      low: periodLow, lowDate: periodLowDate,
      currentPrice,
      distFromHighPct: periodHigh ? Math.round(((currentPrice - periodHigh) / periodHigh) * 10000) / 100 : null,
      distFromLowPct: periodLow ? Math.round(((currentPrice - periodLow) / periodLow) * 10000) / 100 : null,
    },
  };
}


async function getPeriodExtremes(symbol, days = 180) {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s || s.length < 5) throw new Error('رمز غير صالح.');
  let klines;
  try { klines = await get(API, `/api/v3/klines?symbol=${s}&interval=1d&limit=${days}`); }
  catch (e) {
    if (!isBadSymbol(e)) throw e;
    klines = await get(FAPI, `/fapi/v1/klines?symbol=${s}&interval=1d&limit=${days}`);
  }
  const highs = klines.map((k) => num(k[2]));
  const lows = klines.map((k) => num(k[3]));
  const current = num(klines[klines.length - 1][4]);
  const periodHigh = Math.max(...highs), periodLow = Math.min(...lows);
  const distFromLowPct = periodLow ? ((current - periodLow) / periodLow) * 100 : null;
  const distFromHighPct = periodHigh ? ((current - periodHigh) / periodHigh) * 100 : null;
  return {
    symbol: s, days: klines.length, current, periodHigh, periodLow,
    distFromLowPct: distFromLowPct !== null ? Math.round(distFromLowPct * 100) / 100 : null,
    distFromHighPct: distFromHighPct !== null ? Math.round(distFromHighPct * 100) / 100 : null,
    atLow: distFromLowPct !== null && distFromLowPct <= 1,
    atHigh: distFromHighPct !== null && distFromHighPct >= -1,
  };
}

/* ══════════════════════════════════════════════════════════════
   تحليل فني وصفي — يتبع حدوداً صارمة:
   لا سعر دخول، لا وقف خسارة، لا هدف ربح، لا درجة "قوة صفقة"،
   لا رمز قرار (شراء/بيع). فقط وصف لحالة السوق ومناطق للمراقبة.
   ══════════════════════════════════════════════════════════════ */

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null || values[i] === undefined) continue;
    if (prev === null) { prev = values[i]; out[i] = prev; continue; }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcMACD(closes) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => (e12[i] !== null && e26[i] !== null) ? e12[i] - e26[i] : null);
  const valid = macdLine.filter((v) => v !== null);
  const sigValid = ema(valid, 9);
  const signalLine = new Array(closes.length).fill(null);
  let si = 0;
  for (let i = 0; i < closes.length; i++) if (macdLine[i] !== null) signalLine[i] = sigValid[si++];
  const hist = closes.map((_, i) => (macdLine[i] !== null && signalLine[i] !== null) ? macdLine[i] - signalLine[i] : null);
  return { macdLine, signalLine, hist };
}

function findSwingPoints(candles, lookback = 3) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].high, l = candles[i].low;
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= h) isHigh = false;
      if (candles[j].low <= l) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: h, time: candles[i].time });
    if (isLow) lows.push({ index: i, price: l, time: candles[i].time });
  }
  return { highs, lows };
}

function clusterLevels(points, tolerancePct = 1.5) {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = cur[cur.length - 1];
    if (Math.abs(sorted[i].price - last.price) / last.price * 100 <= tolerancePct) cur.push(sorted[i]);
    else { clusters.push(cur); cur = [sorted[i]]; }
  }
  clusters.push(cur);
  return clusters.map((c) => ({
    price: c.reduce((s, p) => s + p.price, 0) / c.length,
    touches: c.length,
  })).sort((a, b) => b.touches - a.touches || b.price - a.price);
}

function marketStructureLabel(highs, lows) {
  if (highs.length < 2 || lows.length < 2) return { label: 'غير كافٍ لتحديد الهيكل', hh: null, hl: null };
  const [h1, h2] = highs.slice(-2), [l1, l2] = lows.slice(-2);
  const hh = h2.price > h1.price, hl = l2.price > l1.price;
  let label;
  if (hh && hl) label = 'صاعد — قمم وقيعان متصاعدة (Higher Highs / Higher Lows)';
  else if (!hh && !hl) label = 'هابط — قمم وقيعان متنازلة (Lower Highs / Lower Lows)';
  else label = 'متعارض — لا يوجد اتساق واضح بين القمم والقيعان الأخيرة';
  return { label, hh, hl };
}

function fmtLevel(price, current) {
  const d = current > 100 ? 2 : 6;
  return Number(price).toFixed(d);
}

async function getTechnicalAnalysis(symbol) {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s || s.length < 5) throw new Error('رمز غير صالح. مثال: BTCUSDT');

  let base = API, market = 'spot', klines;
  try { klines = await get(API, `/api/v3/klines?symbol=${s}&interval=1d&limit=250`); }
  catch (e) {
    if (!isBadSymbol(e)) throw e;
    base = FAPI; market = 'futures';
    klines = await get(FAPI, `/fapi/v1/klines?symbol=${s}&interval=1d&limit=250`);
  }

  const candles = klines.map((k) => ({
    time: k[0], open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]), volume: num(k[5]),
  }));
  if (candles.length < 60) {
    return { symbol: s, market, available: false, reason: 'سجل قصير جداً لتحليل فني موثوق (أقل من ٦٠ يوماً).' };
  }

  const closes = candles.map((c) => c.close);
  const current = closes[closes.length - 1];
  const lastCandle = candles[candles.length - 1];

  const rsiVal = calcRSI(closes, 14);
  const rsiPrev = calcRSI(closes.slice(0, -1), 14);
  const { hist: macdHist, macdLine, signalLine } = calcMACD(closes);
  const macdNow = macdLine[macdLine.length - 1], macdPrev = macdLine[macdLine.length - 2];
  const sigNow = signalLine[signalLine.length - 1], sigPrev = signalLine[signalLine.length - 2];
  const macdCross = (macdPrev !== null && sigPrev !== null && macdNow !== null && sigNow !== null)
    ? (macdPrev <= sigPrev && macdNow > sigNow ? 'صاعد حديث'
       : macdPrev >= sigPrev && macdNow < sigNow ? 'هابط حديث' : null)
    : null;

  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), ema200 = ema(closes, 200);
  const e20 = ema20[ema20.length - 1], e50 = ema50[ema50.length - 1], e200 = ema200[ema200.length - 1];

  const avgVol = candles.slice(-20).reduce((a, c) => a + c.volume, 0) / 20;
  const volNow = lastCandle.volume;
  const volRatio = avgVol ? volNow / avgVol : null;
  const volLabel = volRatio === null ? 'غير متوفر'
    : volRatio > 1.8 ? 'مرتفع بوضوح عن المتوسط (Volume Spike)'
    : volRatio > 1.2 ? 'أعلى قليلاً من المتوسط'
    : volRatio < 0.6 ? 'منخفض بوضوح عن المتوسط'
    : 'ضمن المعدل الطبيعي';

  const { highs, lows } = findSwingPoints(candles, 3);
  const structure = marketStructureLabel(highs, lows);
  const resistances = clusterLevels(highs.filter((h) => h.price > current)).slice(0, 3);
  const supports = clusterLevels(lows.filter((l) => l.price < current)).slice(0, 3);

  let trend;
  if (e20 && e50 && e200) {
    if (current > e20 && e20 > e50 && e50 > e200) trend = 'صاعد';
    else if (current < e20 && e20 < e50 && e50 < e200) trend = 'هابط';
    else trend = 'جانبي/انتقالي';
  } else trend = structure.hh === true ? 'صاعد' : structure.hh === false ? 'هابط' : 'غير كافٍ';

  let bullSignals = 0, bearSignals = 0, total = 0;
  const bullList = [], bearList = [];
  const vote = (isBull, isBear, label) => {
    total++;
    if (isBull) { bullSignals++; bullList.push(label); }
    else if (isBear) { bearSignals++; bearList.push(label); }
  };
  if (rsiVal !== null) vote(rsiVal > 55, rsiVal < 45, `RSI عند ${rsiVal.toFixed(1)}`);
  if (macdHist[macdHist.length - 1] !== null) vote(macdHist[macdHist.length-1] > 0, macdHist[macdHist.length-1] < 0, 'موقع MACD Histogram');
  if (e20 && e50) vote(e20 > e50, e20 < e50, 'ترتيب المتوسطين ٢٠/٥٠');
  if (structure.hh !== null) vote(structure.hh && structure.hl, !structure.hh && !structure.hl, 'هيكل السوق (قمم/قيعان)');
  if (volRatio !== null) vote(volRatio > 1.2 && current > closes[closes.length-2], volRatio > 1.2 && current < closes[closes.length-2], 'دعم الحجم للحركة الأخيرة');

  let confluence;
  if (total < 3) confluence = 'غير كافية';
  else if (bullSignals >= total - 1 && bullSignals > bearSignals) confluence = 'متوافقة بقوة (صاعد)';
  else if (bearSignals >= total - 1 && bearSignals > bullSignals) confluence = 'متوافقة بقوة (هابط)';
  else if (Math.abs(bullSignals - bearSignals) <= 1) confluence = 'متعارضة';
  else confluence = bullSignals > bearSignals ? 'متوافقة جزئياً (ميل صاعد)' : 'متوافقة جزئياً (ميل هابط)';

  const nearestResistance = resistances[0] || null;
  const nearestSupport = supports[0] || null;
  const nextResistance = resistances[1] || null;
  const nextSupport = supports[1] || null;

  return {
    symbol: s, market, candlesUsed: candles.length,
    current, fetchedAt: Date.now(),
    trend, structure: structure.label,
    indicators: {
      rsi: rsiVal !== null ? Math.round(rsiVal * 10) / 10 : null,
      rsiRising: rsiVal !== null && rsiPrev !== null ? rsiVal > rsiPrev : null,
      rsiZone: rsiVal === null ? null : rsiVal > 70 ? 'منطقة تشبع شرائي تاريخية' : rsiVal < 30 ? 'منطقة تشبع بيعي تاريخية' : 'منطقة محايدة',
      macdHist: macdHist[macdHist.length - 1],
      macdCross,
      ema20: e20, ema50: e50, ema200: e200,
      priceVsEma: e20 && e50 && e200 ? (current > e20 && current > e50 && current > e200 ? 'فوق كل المتوسطات'
        : current < e20 && current < e50 && current < e200 ? 'دون كل المتوسطات' : 'بين المتوسطات') : null,
      volumeRatio: volRatio !== null ? Math.round(volRatio * 100) / 100 : null,
      volumeLabel: volLabel,
    },
    levels: { resistances, supports },
    confluence: { label: confluence, bullCount: bullSignals, bearCount: bearSignals, totalSignals: total, bullFactors: bullList, bearFactors: bearList },
    watchZones: {
      bullishWatch: nearestResistance
        ? `منطقة تستحق المراقبة في حال تحقق شروط التأكيد: إغلاق فوق ${fmtLevel(nearestResistance.price, current)} (لُمست ${nearestResistance.touches} مرة تاريخياً) مع دعم من الحجم.`
        : 'لا توجد منطقة مقاومة واضحة قريبة ضمن البيانات المتاحة.',
      bearishWatch: nearestSupport
        ? `منطقة تستحق المراقبة في حال تحقق شروط التأكيد: كسر وإغلاق دون ${fmtLevel(nearestSupport.price, current)} (لُمست ${nearestSupport.touches} مرة تاريخياً) مع زيادة الحجم البيعي.`
        : 'لا توجد منطقة دعم واضحة قريبة ضمن البيانات المتاحة.',
      invalidation: e50
        ? `إذا أُغلقت شمعة يومية بوضوح على الجانب الآخر من المتوسط ٥٠ يوماً (${fmtLevel(e50, current)})، فإن القراءة الحالية تحتاج إعادة تقييم.`
        : 'بيانات غير كافية لتحديد مستوى إعادة التقييم.',
      nextBullishZones: nextResistance ? [fmtLevel(nextResistance.price, current)] : [],
      nextBearishZones: nextSupport ? [fmtLevel(nextSupport.price, current)] : [],
    },
  };
}

module.exports = { getSymbol, getHistoricalContext, getPeriodExtremes, getTechnicalAnalysis };
