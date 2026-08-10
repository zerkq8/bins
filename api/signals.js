const { getSignals, jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async () => await getSignals({ scan: 20 }), 45);
