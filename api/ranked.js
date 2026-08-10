const { getRanked, jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async () => await getRanked({ scan: 50 }), 90);
