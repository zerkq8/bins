/**
 * api/balance.js
 * قراءة فقط: الرصيد المتاح للتداول (availableBalance) من الحساب الفعّال
 * حالياً (Demo أو Real حسب BINANCE_MODE) — محمي بنفس المفتاح الإداري
 * المستخدم في لوحة إعدادات البوت (BOT_ADMIN_KEY).
 */
const trade = require('../lib/binanceTrade');

const ADMIN_KEY = (process.env.BOT_ADMIN_KEY || '').trim();

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const key = String(req.query?.key || '').trim();
    if (!ADMIN_KEY) throw new Error('BOT_ADMIN_KEY غير مُعدّ في متغيرات البيئة');
    if (!key || key !== ADMIN_KEY) throw new Error('مفتاح إداري غير صحيح');

    const account = await trade.getAccountInfo();
    res.status(200).end(JSON.stringify({ ok: true, availableBalance: account.availableBalance }));
  } catch (e) {
    res.status(401).end(JSON.stringify({ ok: false, error: e.message }));
  }
};
