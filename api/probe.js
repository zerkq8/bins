/**
 * ملف فحص مؤقت: يجرّب كل المسارات المحتملة ويخبرك أيها يعمل.
 * افتحه مرة واحدة، أرسل النتيجة، ثم يمكن حذفه.
 */

const BASE = 'https://www.binance.com';

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

const BODY = {
  pageNumber: 1, pageSize: 3, timeRange: '30D', dataType: 'ROI',
  favoriteOnly: false, hideFull: false, nickname: '',
  order: 'DESC', sortType: 'ROI',
};

const CANDIDATES = [
  ['POST', '/bapi/futures/v1/public/future/copy-trade/lead-portfolio/search'],
  ['POST', '/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/search'],
  ['POST', '/bapi/futures/v2/public/future/copy-trade/lead-portfolio/search'],
  ['POST', '/bapi/futures/v1/public/future/copy-trade/lead-portfolio/list'],
  ['POST', '/bapi/futures/v1/public/future/copy-trade/lead-data/portfolio-list'],
  ['POST', '/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list'],
  ['POST', '/bapi/futures/v1/public/future/copy-trade/lead-data/rank/list'],
  ['POST', '/bapi/composite/v1/public/future/copy-trade/lead-portfolio/search'],
  ['POST', '/bapi/futures/v1/public/future/copy-trade/portfolio/search'],
  ['POST', '/bapi/futures/v1/public/future/copy-trade/lead-portfolio/query-list'],
  ['GET',  '/bapi/futures/v1/public/future/copy-trade/lead-portfolio/search?pageNumber=1&pageSize=3&timeRange=30D&dataType=ROI'],
  ['POST', '/bapi/futures/v1/public/future/leaderboard/searchNickname'],
  ['POST', '/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank'],
  ['GET',  '/bapi/futures/v1/public/future/copy-trade/lead-portfolio/rank?timeRange=30D&pageSize=3'],
];

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');

  const results = [];
  for (const [method, path] of CANDIDATES) {
    try {
      const r = await fetch(BASE + path, {
        method,
        headers: HEADERS,
        body: method === 'POST' ? JSON.stringify(BODY) : undefined,
      });
      const text = await r.text();
      let works = false;
      try {
        const j = JSON.parse(text);
        works = r.ok && j.success !== false && !!j.data;
      } catch {}
      results.push({
        method, path,
        http: r.status,
        WORKS: works,
        preview: text.slice(0, 150),
      });
    } catch (e) {
      results.push({ method, path, http: 'ERR', WORKS: false, preview: e.message });
    }
  }

  const winners = results.filter((r) => r.WORKS).map((r) => `${r.method} ${r.path}`);
  res.status(200).end(JSON.stringify({
    region: process.env.VERCEL_REGION || 'local',
    WORKING_ENDPOINTS: winners.length ? winners : 'لا يوجد — أرسل القائمة كاملة',
    results,
  }, null, 2));
};
