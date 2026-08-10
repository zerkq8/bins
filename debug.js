const { BASE, HEADERS, jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async () => {
  const url = BASE + '/bapi/futures/v1/public/future/copy-trade/lead-portfolio/search';
  const res = await fetch(url, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ pageNumber: 1, pageSize: 3, timeRange: '30D', dataType: 'ROI', nickname: '', order: 'DESC', sortType: 'ROI' }),
  });
  const text = await res.text();
  return {
    status: res.status,
    region: process.env.VERCEL_REGION || 'local',
    blockedByRegion: res.status === 451 || res.status === 403,
    preview: text.slice(0, 400),
  };
}, 0);
