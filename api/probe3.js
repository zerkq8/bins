/** فحص ثالث: يعرض الحقول الحقيقية لتفاصيل المتداول وصفقة مغلقة. */

const BASE = 'https://www.binance.com';
const P = '/bapi/futures/v1/friendly/future/copy-trade';

const HEADERS = {
  'accept': 'application/json, text/plain, */*',
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
  return (await r.json())?.data;
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const list = await hit('POST', `${P}/home-page/query-list`, {
    pageNumber: 1, pageSize: 1, timeRange: '30D', dataType: 'ROI',
    favoriteOnly: false, hideFull: false, nickname: '', order: 'DESC', sortType: 'ROI',
  });
  const id = list?.list?.[0]?.leadPortfolioId;

  const detail = await hit('GET', `${P}/lead-portfolio/detail?portfolioId=${id}`);
  const hist = await hit('POST', `${P}/lead-portfolio/position-history`,
    { portfolioId: id, pageNumber: 1, pageSize: 10 });

  const trades = hist?.list || [];
  const loser = trades.find((t) => Object.values(t).some((v) => typeof v === 'number' && v < 0));

  res.status(200).end(JSON.stringify({
    detailFields: detail ? Object.keys(detail) : [],
    detail,
    tradeFields: trades[0] ? Object.keys(trades[0]) : [],
    firstTrade: trades[0] || null,
    losingTrade: loser || null,
  }, null, 2));
};
