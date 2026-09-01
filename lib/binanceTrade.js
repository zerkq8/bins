/**
 * lib/binanceTrade.js
 * وحدة الاتصال بـ Binance Futures Demo Trading (USDS-M).
 * ⚠️ هذه فقط طبقة الاتصال الأساسية — لا منطق دخول/خروج بعد، ولا أوامر
 * تُنفَّذ تلقائياً. أول خطوة: التحقق أن الاتصال والتوقيع يعملان بنجاح
 * ضد حسابك الحقيقي، قبل بناء أي منطق تداول فوقها.
 *
 * المفاتيح تُقرأ حصراً من متغيرات البيئة — لا تظهر أبداً في أي كود
 * يراه المتصفح (index.html)، ولا في أي رد API نصي.
 */
const crypto = require('crypto');

const BASE = 'https://demo-fapi.binance.com';
const API_KEY = process.env.BINANCE_DEMO_API_KEY;
const API_SECRET = process.env.BINANCE_DEMO_API_SECRET;

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

/** طلب عام موقّع (SIGNED) — يستخدمه أي استدعاء يحتاج هوية الحساب */
async function signedRequest(method, path, params = {}) {
  if (!API_KEY || !API_SECRET) {
    throw new Error('مفاتيح Binance Demo غير مُعدّة في متغيرات البيئة');
  }
  const qs = buildSignedQuery(params);
  const url = `${BASE}${path}?${qs}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': API_KEY },
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
  const res = await fetch(`${BASE}${path}`);
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

/** المراكز المفتوحة حالياً على حساب Demo Trading. قراءة فقط */
async function getPositions() {
  return signedRequest('GET', '/fapi/v2/positionRisk');
}

module.exports = { ping, getAccountInfo, getPositions, signedRequest, publicRequest };
