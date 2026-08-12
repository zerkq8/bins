/**
 * نقطة الفحص — تُستدعى دورياً من خدمة جدولة خارجية (cron-job.org)
 * أو يدوياً من الصفحة لاختبارها.
 *
 * الاستدعاء: /api/alerts?key=مفتاحك
 */
const { runAlerts } = require('../lib/alerts');
const { ENDPOINTS, HEADERS, BASE } = require('../lib/binance');

/** جلب المراكز المفتوحة لمتداول */
async function callPositions(id) {
  const url = BASE + ENDPOINTS.openPositions.url.replace('{id}', id);
  const res = await fetch(url, { headers: HEADERS });
  const j = await res.json();
  const list = Array.isArray(j?.data) ? j.data : (j?.data?.list || []);
  return list.map((t) => ({
    symbol: t.symbol || '—',
    side: String(t.positionSide || t.side || '').toUpperCase(),
    entryPrice: Number(t.entryPrice ?? t.avgCost ?? t.openPrice) || null,
    leverage: Number(t.leverage) || null,
    roi: Number(t.roe ?? t.roi ?? t.pnlRate) || null,
  })).filter((p) => p.symbol !== '—');
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const key = String(req.query?.key || '').trim();
    if (!key || key.length < 4) throw new Error('المفتاح الشخصي مفقود.');
    const result = await runAlerts({ callPositions, deviceKey: key });
    res.status(200).end(JSON.stringify({ ok: true, ...result, at: Date.now() }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ ok: false, error: e.message }));
  }
};
