const { getRanked, jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async (req) => {
  const mode = req.query?.mode === 'success' ? 'success' : 'trust';
  return await getRanked({ mode, scan: 50 });
}, 90);
