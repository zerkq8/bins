const { getRanked, jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async () => await getRanked({ pages: 6 }), 120);
