/**
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 * يعرض الشكل الخام لحقل chartItems لمتداول واحد، لنبني عليه
 * حساب Sharpe Ratio وMax Drawdown بثقة، لا تخميناً.
 * الاستدعاء: /api/status?id=رقم_المتداول
 */
const { BASE, HEADERS, ENDPOINTS } = require('../lib/binance');

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const id = String(req.query?.id || '').trim();
    if (!id) throw new Error('أرسل ?id=رقم_متداول من قائمتك.');

    // نجلب القائمة (تحتوي chartItems) لصفحة واحدة كبيرة ونبحث عن المتداول المطلوب
    const listRes = await fetch(BASE + ENDPOINTS.list.url, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({
        pageNumber: 1, pageSize: 50, timeRange: '90D', dataType: 'ROI',
        sortType: 'ROI', favoriteOnly: false, hideFull: false, nickname: '', order: 'DESC',
      }),
    });
    const listJson = await listRes.json();
    const rows = listJson?.data || [];
    const row = rows.find((r) => String(r.leadPortfolioId) === id);

    if (!row) {
      res.status(200).end(JSON.stringify({
        found: false,
        note: 'لم يوجد ضمن أعلى ٥٠ متداولاً بعائد ٩٠ يوماً. جرّب متداولاً من "الأفضل خلال ٩٠ يوماً" في موقعك.',
        availableIdsSample: rows.slice(0, 5).map((r) => ({ id: r.leadPortfolioId, nickname: r.nickname })),
      }, null, 2));
      return;
    }

    const chartItems = row.chartItems;
    res.status(200).end(JSON.stringify({
      found: true,
      nickname: row.nickname,
      roi: row.roi,
      mdd: row.mdd,
      chartItemsType: Array.isArray(chartItems) ? 'array' : typeof chartItems,
      chartItemsLength: Array.isArray(chartItems) ? chartItems.length : null,
      chartItemsFirst5: Array.isArray(chartItems) ? chartItems.slice(0, 5) : chartItems,
      chartItemsLast5: Array.isArray(chartItems) ? chartItems.slice(-5) : null,
      rawRowKeys: Object.keys(row),
    }, null, 2));
  } catch (e) {
    res.status(500).end(JSON.stringify({ error: e.message, stack: (e.stack || '').split('\n').slice(0, 5) }));
  }
};
