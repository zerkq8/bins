/**
 * فحص ثانٍ: يجلب معرّف متداول حقيقي، ثم يجرّب مسارات
 * التفاصيل والصفقات المغلقة والمراكز المفتوحة.
 */

const BASE = 'https://www.binance.com';
const P = '/bapi/futures/v1/friendly/future/copy-trade';

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

async function hit(method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: HEADERS,
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { http: r.status, json, text };
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  // 1) جلب متداول حقيقي
  const listRes = await hit('POST', `${P}/home-page/query-list`, {
    pageNumber: 1, pageSize: 3, timeRange: '30D', dataType: 'ROI',
    favoriteOnly: false, hideFull: false, nickname: '',
    order: 'DESC', sortType: 'ROI',
  });

  const first = listRes.json?.data?.list?.[0];
  const id = first?.leadPortfolioId || first?.portfolioId;

  if (!id) {
    return res.status(200).end(JSON.stringify({
      step: 'فشل جلب القائمة', http: listRes.http, preview: listRes.text.slice(0, 500),
    }, null, 2));
  }

  // 2) تجربة مسارات التفاصيل
  const CANDIDATES = [
    ['GET',  `${P}/lead-portfolio/detail?portfolioId=${id}`],
    ['GET',  `${P}/home-page/detail?portfolioId=${id}`],
    ['GET',  `${P}/lead-data/detail?portfolioId=${id}`],
    ['GET',  `${P}/lead-portfolio/position?portfolioId=${id}`],
    ['GET',  `${P}/lead-data/positions?portfolioId=${id}`],
    ['GET',  `${P}/home-page/position?portfolioId=${id}`],
    ['GET',  `${P}/lead-portfolio/position-history?portfolioId=${id}&pageNumber=1&pageSize=5`],
    ['GET',  `${P}/lead-data/position-history?portfolioId=${id}&pageNumber=1&pageSize=5`],
    ['GET',  `${P}/home-page/position-history?portfolioId=${id}&pageNumber=1&pageSize=5`],
    ['POST', `${P}/lead-portfolio/position-history`, { portfolioId: id, pageNumber: 1, pageSize: 5 }],
    ['POST', `${P}/home-page/position-history`, { portfolioId: id, pageNumber: 1, pageSize: 5 }],
    ['POST', `${P}/lead-data/position-history`, { portfolioId: id, pageNumber: 1, pageSize: 5 }],
    ['GET',  `${P}/lead-portfolio/performance?portfolioId=${id}&timeRange=90D`],
    ['GET',  `${P}/home-page/performance?portfolioId=${id}&timeRange=90D`],
    ['GET',  `${P}/lead-portfolio/trade-history?portfolioId=${id}&pageNumber=1&pageSize=5`],
    ['GET',  `${P}/home-page/trade-history?portfolioId=${id}&pageNumber=1&pageSize=5`],
  ];

  const results = [];
  for (const [method, path, body] of CANDIDATES) {
    try {
      const r = await hit(method, path, body);
      results.push({
        method,
        path: path.replace(id, '{ID}'),
        http: r.http,
        WORKS: r.http === 200 && !!r.json?.data,
        preview: r.text.slice(0, 220),
      });
    } catch (e) {
      results.push({ method, path, http: 'ERR', WORKS: false, preview: e.message });
    }
  }

  res.status(200).end(JSON.stringify({
    usedPortfolioId: id,
    listItemFields: first ? Object.keys(first) : [],
    listItemSample: first,
    WORKING: results.filter((r) => r.WORKS).map((r) => `${r.method} ${r.path}`),
    results,
  }, null, 2));
};
