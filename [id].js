const { getTrader, jsonHandler } = require('../../lib/binance');
module.exports = jsonHandler(async (req) => {
  const id = req.query?.id;
  if (!id) throw new Error('معرّف المتداول مفقود.');
  return await getTrader(id);
}, 20);
