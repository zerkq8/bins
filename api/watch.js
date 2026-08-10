const { getWatch, jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async (req) => {
  const ids = String(req.query?.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 12);
  if (!ids.length) return { traders: [], missing: [] };
  return await getWatch(ids);
}, 60);
