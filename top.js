const { getTop, jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async () => ({ traders: await getTop() }), 45);
