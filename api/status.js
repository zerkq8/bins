/**
 * حالة عرض المراكز لعدة متداولين دفعة واحدة — يُستخدم لرسم علامة
 * 🟢 ظاهرة / 🔴 مخفية بجانب كل اسم في القوائم، بلا تحميل صفحة كاملة.
 * الاستدعاء: /api/status?ids=id1,id2,id3
 */
const { getPositionStatusBulk, jsonHandler } = require('../lib/binance');
module.exports = jsonHandler(async (req) => {
  const ids = String(req.query?.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return { statuses: {} };
  const statuses = await getPositionStatusBulk(ids);
  return { statuses, fetchedAt: Date.now() };
}, 30);
