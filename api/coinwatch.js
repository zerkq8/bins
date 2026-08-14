/**
 * إدارة قائمة العملات المتابَعة + عرض حالتها الحالية (بلا تنبيه).
 * الاستدعاء: /api/coinwatch?key=مفتاحك
 * POST body: {add:"BTCUSDT"} أو {remove:"BTCUSDT"}
 */
const { getWatchedCoinsStatus, addCoin, removeCoin } = require('../lib/coinalerts');

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const key = String(req.query?.key || '').trim();
    if (!key || key.length < 4) throw new Error('سجّل الدخول أولاً من تبويب متابعتي.');

    if (req.method === 'POST') {
      const b = await readBody(req);
      if (b.add) await addCoin(key, b.add);
      else if (b.remove) await removeCoin(key, b.remove);
    }

    const coins = await getWatchedCoinsStatus(key);
    res.status(200).end(JSON.stringify({ coins, fetchedAt: Date.now() }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ error: e.message }));
  }
};
