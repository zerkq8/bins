/**
 * تشخيص مؤقت: يمسح متابعيك ويعرض البيانات الخام لأول مركز مفتوح يجده.
 * الاستدعاء: /api/probe4?key=مفتاحك
 * يُستخدم مرة لمعرفة أسماء الحقول الحقيقية، ثم يمكن حذفه.
 */

const { ENDPOINTS, HEADERS, BASE } = require('../lib/binance');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

async function sb(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  return res.json();
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const key = String(req.query?.key || '').trim();
    if (!key) throw new Error('استخدم /api/probe4?key=مفتاحك');

    const rows = await sb(
      `watchlist?device_key=eq.${encodeURIComponent(key)}&select=trader_id,nickname&limit=20`
    );

    const results = [];
    for (const r of rows) {
      const url = BASE + ENDPOINTS.openPositions.url.replace('{id}', r.trader_id);
      const resp = await fetch(url, { headers: HEADERS });
      const j = await resp.json();
      const list = Array.isArray(j?.data) ? j.data : (j?.data?.list || []);
      results.push({ nickname: r.nickname, trader_id: r.trader_id, count: list.length, raw: list });
    }

    const withData = results.find((r) => r.count > 0);

    res.status(200).end(JSON.stringify({
      totalWatched: rows.length,
      withOpenPositions: results.filter((r) => r.count > 0).map((r) => r.nickname),
      sample: withData || null,
      fieldNames: withData ? Object.keys(withData.raw[0]) : 'لا توجد مراكز مفتوحة حالياً لدى أي متابَع',
      allResults: results,
    }, null, 2));
  } catch (e) {
    res.status(500).end(JSON.stringify({ error: e.message }));
  }
};
