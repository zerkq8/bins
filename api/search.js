const { searchTraders, jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async (req) => {
  const q = (req.query?.q || '').trim();
  if (!q) return { traders: [] };
  return { traders: await searchTraders(q) };
}, 30);
