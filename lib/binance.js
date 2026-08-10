/**
 * منطق الاتصال بباينس — المسارات مؤكدة بالفحص (تعمل فعلياً).
 * إذا توقفت مستقبلاً، افتح /api/probe2 لإعادة اكتشاف المسارات.
 */

const BASE = 'https://www.binance.com';
const P = '/bapi/futures/v1/friendly/future/copy-trade';

const ENDPOINTS = {
  list:          { method: 'POST', url: `${P}/home-page/query-list` },
  detail:        { method: 'GET',  url: `${P}/lead-portfolio/detail?portfolioId={id}` },
  openPositions: { method: 'GET',  url: `${P}/lead-data/positions?portfolioId={id}` },
  closedTrades:  { method: 'POST', url: `${P}/lead-portfolio/position-history` },
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

async function call(ep, { id, body } = {}) {
  const url = BASE + (id ? ep.url.replace('{id}', id) : ep.url);
  const res = await fetch(url, {
    method: ep.method,
    headers: HEADERS,
    body: ep.method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`رد غير متوقع من باينس (${res.status}): ${text.slice(0, 100)}`); }
  if (json.success === false) throw new Error(json.message || `رفض من باينس (${json.code})`);
  return json.data;
}

/* ---------------- توحيد الحقول ---------------- */
const num = (...v) => {
  for (const x of v) {
    const n = Number(x);
    if (x !== null && x !== undefined && x !== '' && Number.isFinite(n)) return n;
  }
  return null;
};
/** قيم النسب في قوائم باينس تأتي كنسبة مئوية جاهزة (3867.77 = 3867%)،
 *  وفي الصفقات أحياناً ككسر (0.15 = 15%). نحوّل الكسور فقط. */
const asPct = (v) => (v === null ? null : Math.abs(v) <= 1.5 ? v * 100 : v);

function normTrader(p = {}) {
  return {
    id: p.leadPortfolioId || p.portfolioId || null,
    nickname: p.nickname || 'بدون اسم',
    avatar: p.avatarUrl || null,
    roi: num(p.roi),
    pnl: num(p.pnl),
    winRate: num(p.winRate),
    mdd: num(p.mdd),
    aum: num(p.aum),
    copiers: num(p.currentCopyCount),
    maxCopiers: num(p.maxCopyCount),
    isPublic: p.portfolioType ? p.portfolioType === 'PUBLIC' : true,
    startTime: num(p.startTime),
  };
}

function normClosed(t = {}) {
  const entry = num(t.avgCost, t.entryPrice, t.avgEntryPrice, t.openPrice);
  const exit  = num(t.avgClosePrice, t.closePrice, t.exitPrice);
  const pnl   = num(t.closingPnl, t.realizedPnl, t.pnl, t.netProfit);
  let roi = num(t.roi, t.closingPnlRate, t.pnlRate, t.roe);
  roi = asPct(roi);
  return {
    symbol: t.symbol || '—',
    side: String(t.positionSide || t.side || t.direction || '').toUpperCase(),
    leverage: num(t.leverage, t.maxLeverage),
    entryPrice: entry,
    exitPrice: exit,
    pnl,
    roi,
    openTime: num(t.opened, t.openTime, t.startTime),
    closeTime: num(t.closed, t.closeTime, t.endTime, t.updateTime),
  };
}

function normOpen(t = {}) {
  return {
    symbol: t.symbol || '—',
    side: String(t.positionSide || t.side || '').toUpperCase(),
    leverage: num(t.leverage),
    entryPrice: num(t.entryPrice, t.avgCost, t.openPrice),
    pnl: num(t.unrealizedProfit, t.unrealizedPnl, t.pnl),
    roi: asPct(num(t.roe, t.roi, t.pnlRate)),
    openTime: num(t.opened, t.updateTime, t.openTime, t.createTime),
  };
}

const listOf = (d) =>
  Array.isArray(d) ? d
  : Array.isArray(d?.list) ? d.list
  : Array.isArray(d?.data) ? d.data
  : [];

/* ---------------- الوظائف ---------------- */
const listBody = (page, size) => ({
  pageNumber: page, pageSize: size, timeRange: '30D', dataType: 'ROI',
  favoriteOnly: false, hideFull: false, nickname: '',
  order: 'DESC', sortType: 'ROI',
});

async function getTop() {
  const data = await call(ENDPOINTS.list, { body: listBody(1, 10) });
  return listOf(data).map(normTrader).filter((t) => t.id);
}

/** بحث بالاسم: باينس لا تدعم بحثاً نصياً هنا، فنجلب عدة صفحات ونصفّي محلياً */
async function searchTraders(q) {
  const needle = q.trim().toLowerCase();
  const found = [];
  for (let page = 1; page <= 6; page++) {
    const data = await call(ENDPOINTS.list, { body: listBody(page, 50) });
    const rows = listOf(data).map(normTrader).filter((t) => t.id);
    if (!rows.length) break;
    found.push(...rows.filter((t) => t.nickname.toLowerCase().includes(needle)));
    if (found.length >= 20) break;
  }
  return found.slice(0, 20);
}

async function getTrader(id) {
  const [detail, closed, open] = await Promise.allSettled([
    call(ENDPOINTS.detail, { id }),
    call(ENDPOINTS.closedTrades, { body: { portfolioId: id, pageNumber: 1, pageSize: 10 } }),
    call(ENDPOINTS.openPositions, { id }),
  ]);
  const val = (r) => (r.status === 'fulfilled' ? r.value : null);

  const closedList = listOf(val(closed)).map(normClosed)
    .sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0))
    .slice(0, 10);
  const openList = listOf(val(open)).map(normOpen);

  if (!val(detail)) {
    const e = [detail, closed, open].map((r) => r.reason?.message).filter(Boolean);
    throw new Error(e[0] || 'لم تصل بيانات هذا المتداول.');
  }

  return {
    trader: normTrader(val(detail)),
    closed: closedList,
    open: openList,
    totalClosed: val(closed)?.total ?? null,
    hiddenHistory: closedList.length === 0,
    fetchedAt: Date.now(),
    raw: closedList.length ? undefined : null,
  };
}

/** يضمن أن الرد JSON دائماً — حتى عند الخطأ */
function jsonHandler(fn, cacheSeconds = 30) {
  return async (req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', `s-maxage=${cacheSeconds}, stale-while-revalidate=120`);
    try {
      res.status(200).end(JSON.stringify(await fn(req)));
    } catch (e) {
      res.status(502).end(JSON.stringify({ error: e.message }));
    }
  };
}

module.exports = { getTop, searchTraders, getTrader, jsonHandler, BASE, HEADERS, ENDPOINTS };
