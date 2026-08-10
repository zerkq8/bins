/**
 * منطق الاتصال بباينس + توحيد شكل البيانات.
 * تستخدمه دوال Vercel في مجلد api/ والخادم المحلي server.js.
 *
 * ⚠️ بلوك ENDPOINTS أدناه هو المكان الوحيد الذي قد تحتاج تعديله
 *    إذا غيّرت باينس مساراتها. الطريقة مشروحة في README.
 */

const BASE = 'https://www.binance.com';

const ENDPOINTS = {
  search: [
    { method: 'POST', url: '/bapi/futures/v1/public/future/copy-trade/lead-portfolio/search' },
    { method: 'POST', url: '/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/search' },
  ],
  detail: [
    { method: 'GET', url: '/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId={id}' },
    { method: 'GET', url: '/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail?portfolioId={id}' },
  ],
  openPositions: [
    { method: 'GET', url: '/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position?portfolioId={id}' },
    { method: 'GET', url: '/bapi/futures/v1/public/future/copy-trade/lead-portfolio/position?portfolioId={id}' },
  ],
  closedTrades: [
    { method: 'GET', url: '/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position-history?portfolioId={id}&pageNumber=1&pageSize=20' },
    { method: 'POST', url: '/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position-history', body: { pageNumber: 1, pageSize: 20, portfolioId: '{id}' } },
  ],
};

const HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/json',
  'clienttype': 'web',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'referer': 'https://www.binance.com/en/copy-trading',
  'origin': 'https://www.binance.com',
};

const fill = (obj, id) => JSON.parse(JSON.stringify(obj).replace(/\{id\}/g, String(id)));

async function callBinance(candidates, { id, body: extraBody } = {}) {
  const tried = [];
  for (const raw of candidates) {
    const c = id ? fill(raw, id) : raw;
    try {
      const res = await fetch(BASE + c.url, {
        method: c.method,
        headers: HEADERS,
        body: c.method === 'POST' ? JSON.stringify({ ...(c.body || {}), ...(extraBody || {}) }) : undefined,
      });
      const text = await res.text();
      if (!res.ok) { tried.push(`HTTP ${res.status} ← ${c.url}`); continue; }
      let json;
      try { json = JSON.parse(text); }
      catch { tried.push(`رد غير JSON ← ${c.url} :: ${text.slice(0, 120)}`); continue; }
      if (json.success === false) { tried.push(`${json.message || json.code} ← ${c.url}`); continue; }
      return json.data !== undefined ? json.data : json;
    } catch (e) {
      tried.push(`${c.url} :: ${e.message}`);
    }
  }
  const err = new Error('تعذّر جلب البيانات من باينس.');
  err.tried = tried;
  throw err;
}

/* ---------------- توحيد الحقول ---------------- */
const num = (...v) => {
  for (const x of v) {
    const n = Number(x);
    if (x !== null && x !== undefined && x !== '' && Number.isFinite(n)) return n;
  }
  return null;
};
const pct = (v) => (v === null ? null : Math.abs(v) <= 1.5 ? v * 100 : v);

function normTrader(p = {}) {
  return {
    id: p.leadPortfolioId || p.portfolioId || p.id || null,
    nickname: p.nickname || p.userName || p.name || 'بدون اسم',
    roi: pct(num(p.roi, p.totalRoi, p.roiValue)),
    pnl: num(p.pnl, p.totalPnl, p.pnlValue),
    winRate: pct(num(p.winRate, p.winningRate, p.winRatio)),
    copiers: num(p.currentCopyCount, p.copyCount, p.followerCount),
  };
}

function normClosed(t = {}) {
  return {
    symbol: t.symbol || t.pair || '—',
    side: String(t.positionSide || t.side || t.direction || '').toUpperCase(),
    leverage: num(t.leverage, t.maxLeverage),
    entryPrice: num(t.avgCost, t.entryPrice, t.openPrice, t.avgEntryPrice),
    exitPrice: num(t.avgClosePrice, t.closePrice, t.exitPrice),
    pnl: num(t.closingPnl, t.realizedPnl, t.pnl, t.netProfit),
    roi: pct(num(t.roi, t.closingPnlRate, t.pnlRate, t.roe)),
    openTime: num(t.opened, t.openTime, t.startTime, t.createTime, t.entryTime),
    closeTime: num(t.closed, t.closeTime, t.endTime, t.updateTime, t.exitTime),
  };
}

function normOpen(t = {}) {
  return {
    symbol: t.symbol || t.pair || '—',
    side: String(t.positionSide || t.side || '').toUpperCase(),
    leverage: num(t.leverage),
    entryPrice: num(t.entryPrice, t.avgCost, t.openPrice),
    pnl: num(t.unrealizedProfit, t.pnl, t.unrealizedPnl),
    roi: pct(num(t.roe, t.roi, t.pnlRate)),
    openTime: num(t.updateTime, t.openTime, t.createTime, t.opened),
  };
}

const listOf = (d) =>
  Array.isArray(d) ? d
  : Array.isArray(d?.list) ? d.list
  : Array.isArray(d?.data) ? d.data
  : Array.isArray(d?.records) ? d.records
  : Array.isArray(d?.positions) ? d.positions
  : [];

/* ---------------- الوظائف العامة ---------------- */
const searchBody = (nickname, pageSize) => ({
  pageNumber: 1, pageSize, timeRange: '30D', dataType: 'ROI',
  favoriteOnly: false, hideFull: false, nickname,
  order: 'DESC', sortType: 'ROI',
});

async function getTop() {
  const data = await callBinance(ENDPOINTS.search, { body: searchBody('', 10) });
  return listOf(data).map(normTrader).filter((t) => t.id);
}

async function searchTraders(q) {
  const data = await callBinance(ENDPOINTS.search, { body: searchBody(q, 20) });
  const all = listOf(data).map(normTrader).filter((t) => t.id);
  const needle = q.toLowerCase();
  const hits = all.filter((t) => t.nickname.toLowerCase().includes(needle));
  return hits.length ? hits : all;
}

async function getTrader(id) {
  const [detail, closed, open] = await Promise.allSettled([
    callBinance(ENDPOINTS.detail, { id }),
    callBinance(ENDPOINTS.closedTrades, { id }),
    callBinance(ENDPOINTS.openPositions, { id }),
  ]);
  const val = (r) => (r.status === 'fulfilled' ? r.value : null);

  const closedList = listOf(val(closed)).map(normClosed)
    .sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0))
    .slice(0, 10);
  const openList = listOf(val(open)).map(normOpen);

  if (!val(detail) && !closedList.length && !openList.length) {
    const err = new Error('لم تصل أي بيانات لهذا المتداول. قد تكون محفظته مخفية، أو تغيّرت نقاط الاتصال.');
    err.tried = [detail, closed, open].flatMap((r) => (r.reason?.tried) || []);
    throw err;
  }

  return {
    trader: normTrader(val(detail) || {}),
    closed: closedList,
    open: openList,
    hiddenHistory: closedList.length === 0,
    fetchedAt: Date.now(),
  };
}

/** يغلّف أي دالة ليكون الرد JSON دائماً — حتى عند الخطأ */
function jsonHandler(fn, cacheSeconds = 30) {
  return async (req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', `s-maxage=${cacheSeconds}, stale-while-revalidate=120`);
    try {
      const data = await fn(req);
      res.status(200).end(JSON.stringify(data));
    } catch (e) {
      res.status(502).end(JSON.stringify({ error: e.message, tried: e.tried || [] }));
    }
  };
}

module.exports = { getTop, searchTraders, getTrader, jsonHandler, callBinance, ENDPOINTS, BASE, HEADERS };
