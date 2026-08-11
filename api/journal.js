const { listTrades, addTrade, closeTrade, deleteTrade } = require('../lib/watchdb');

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

    let trades;
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (b.close) trades = await closeTrade(key, b.close, b.exit_price, b.result_note);
      else if (b.remove) trades = await deleteTrade(key, b.remove);
      else if (b.trade) { await addTrade(key, b.trade); trades = await listTrades(key); }
      else trades = await listTrades(key);
    } else {
      trades = await listTrades(key);
    }
    res.status(200).end(JSON.stringify({ trades, fetchedAt: Date.now() }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ error: e.message }));
  }
};
