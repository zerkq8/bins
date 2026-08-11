const { getSymbol } = require('../lib/market');
const { jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async (req) => {
  const s = String(req.query?.symbol || 'BTCUSDT').trim();
  return await getSymbol(s);
}, 20);
