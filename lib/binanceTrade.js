/**
 * lib/binanceTrade.js
 * وحدة الاتصال بـ Binance Futures (USDS-M) — تدعم وضعين عبر BINANCE_MODE:
 *  - demo (افتراضي): اتصال مباشر بـ demo-fapi.binance.com
 *  - real: الحساب الحقيقي، عبر وكيل IP ثابت على Hetzner
 *    (mhmd-binance-bot.duckdns.org) لأن باينس تشترط تقييد IP لمفاتيح
 *    Futures الحقيقية. الوكيل يتحقق من هيدر X-Proxy-Secret قبل التمرير.
 *
 * المفاتيح تُقرأ حصراً من متغيرات البيئة — لا تظهر أبداً في أي كود
 * يراه المتصفح (index.html)، ولا في أي رد API نصي.
 */
const crypto = require('crypto');

const MODE = (process.env.BINANCE_MODE || 'demo').trim().toLowerCase();
const IS_REAL = MODE === 'real';

const BASE = IS_REAL ? 'https://mhmd-binance-bot.duckdns.org' : 'https://demo-fapi.binance.com';
const API_KEY = IS_REAL ? process.env.BINANCE_REAL_API_KEY : process.env.BINANCE_DEMO_API_KEY;
const API_SECRET = IS_REAL ? process.env.BINANCE_REAL_API_SECRET : process.env.BINANCE_DEMO_API_SECRET;
const PROXY_SECRET = process.env.PROXY_SECRET;

function sign(queryString) {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

function buildSignedQuery(params = {}) {
  const withTimestamp = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const queryString = Object.entries(withTimestamp)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const signature = sign(queryString);
  return `${queryString}&signature=${signature}`;
}

/** هيدرز الطلب — يضيف X-Proxy-Secret تلقائياً فقط في وضع real */
function requestHeaders(extra = {}) {
  if (!IS_REAL) return extra;
  if (!PROXY_SECRET) {
    throw new Error('PROXY_SECRET غير مُعدّ في متغيرات البيئة (مطلوب في وضع real)');
  }
  return { ...extra, 'X-Proxy-Secret': PROXY_SECRET };
}

/** طلب عام موقّع (SIGNED) — يستخدمه أي استدعاء يحتاج هوية الحساب */
async function signedRequest(method, path, params = {}) {
  if (!API_KEY || !API_SECRET) {
    throw new Error(IS_REAL
      ? 'مفاتيح Binance الحقيقية غير مُعدّة في متغيرات البيئة (BINANCE_REAL_API_KEY/BINANCE_REAL_API_SECRET)'
      : 'مفاتيح Binance Demo غير مُعدّة في متغيرات البيئة');
  }
  const qs = buildSignedQuery(params);
  const url = `${BASE}${path}?${qs}`;
  const res = await fetch(url, {
    method,
    headers: requestHeaders({ 'X-MBX-APIKEY': API_KEY }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Binance ${res.status}: ${data?.msg || JSON.stringify(data)}`);
  }
  return data;
}

/** طلب عام بلا توقيع (PUBLIC) — للفحوصات الأساسية فقط */
async function publicRequest(path) {
  const res = await fetch(`${BASE}${path}`, { headers: requestHeaders() });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/* ---------------- دوال القراءة فقط (آمنة تماماً، بلا أي تنفيذ) ---------------- */

/** هل الخادم يعمل؟ لا يحتاج توقيعاً */
async function ping() {
  return publicRequest('/fapi/v1/ping');
}

/** معلومات الحساب — الرصيد، الهامش المتاح، إلخ. قراءة فقط، لا خطر */
async function getAccountInfo() {
  return signedRequest('GET', '/fapi/v2/account');
}

/** المراكز المفتوحة حالياً على الحساب (Demo أو Real حسب BINANCE_MODE). قراءة فقط */
async function getPositions() {
  return signedRequest('GET', '/fapi/v2/positionRisk');
}

module.exports = { ping, getAccountInfo, getPositions, signedRequest, publicRequest, MODE };
