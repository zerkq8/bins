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
  if (!res.ok) throw new Error(`باينس ردّت ${res.status}: ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** إحصاءات ٢٤ ساعة + شموع يومية لحساب التقلب والمدى */
async function getSymbol(symbol) {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s || s.length < 5) throw new Error('رمز غير صالح. مثال: BTCUSDT');

  const [ticker, klines] = await Promise.all([
    get(API, `/api/v3/ticker/24hr?symbol=${s}`),
    get(API, `/api/v3/klines?symbol=${s}&interval=1d&limit=30`),
  ]);

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

module.exports = { getSymbol };
