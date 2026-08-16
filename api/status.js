/**
 * ⚠️ يستبدل api/status.js مؤقتاً — يعيد لأصله بعد الاستخدام.
 * يعرض الشكل الخام لحقل chartItems لمتداول واحد.
 * الاستدعاء: /api/status?id=رقم_المتداول
 */
const { BASE, HEADERS, ENDPOINTS } = require('../lib/binance');

/** يستخرج المصفوفة بغض النظر عن شكل الرد (data مباشرة، أو data.list، أو غير ذلك) */
function extractRows(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.data?.list)) return json.data.list;
  if (Array.isArray(json?.data?.data)) return json.data.data;
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const id = String(req.query?.id || '').trim();
    if (!id) throw new Error('أرسل ?id=رقم_متداول من قائمتك.');

    const listRes = await fetch(BASE + ENDPOINTS.list.url, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({
        pageNumber: 1, pageSize: 50, timeRange: '90D', dataType: 'ROI',
        sortType: 'ROI', favoriteOnly: false, hideFull: false, nickname: '', order: 'DESC',
      }),
    });
    const listText = await listRes.text();
    let listJson;
    try { listJson = JSON.parse(listText); }
    catch {
      res.status(200).end(JSON.stringify({
        stage: 'فشل تفسير رد باينس كـ JSON',
        status: listRes.status,
        bodyPreview: listText.slice(0, 400),
      }, null, 2));
      return;
    }

    const rows = extractRows(listJson);

    if (!rows) {
      // لم نتعرف على الشكل — نعرض البنية الخام كاملة للتشخيص اليدوي
      res.status(200).end(JSON.stringify({
        stage: 'تعذّر إيجاد مصفوفة داخل الرد — هذا هو شكله الخام',
        topLevelKeys: Object.keys(listJson || {}),
        dataType: typeof listJson?.data,
        dataKeysIfObject: (listJson?.data && typeof listJson.data === 'object' && !Array.isArray(listJson.data))
          ? Object.keys(listJson.data) : null,
        rawSample: JSON.stringify(listJson).slice(0, 800),
      }, null, 2));
      return;
    }

    const row = rows.find((r) => String(r.leadPortfolioId) === id);

    if (!row) {
      res.status(200).end(JSON.stringify({
        found: false,
        totalRowsReturned: rows.length,
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
