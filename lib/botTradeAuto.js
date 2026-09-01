/**
 * lib/botTradeAuto.js
 * الطبقة التي تربط إعدادات البوت (من Supabase) بمنطق التنفيذ الأساسي
 * (executeEntry من botTrade.js) — تُستدعى من نظام التنبيهات عند اكتشاف
 * "فتح مركز جديد" لمتداول نتابعه، فقط إن كان البوت مفعّلاً ولم يتجاوز
 * الحد الأقصى للمراكز المتزامنة.
 */
const { executeEntry } = require('./botTrade');
const trade = require('./binanceTrade');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

async function getBotSettings() {
  const res = await fetch(`${SB_URL}/rest/v1/bot_settings?id=eq.1&select=*`, {
    headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` },
  });
  const rows = await res.json();
  return rows?.[0] || null;
}

function countOpenPositions(positions) {
  return positions.filter((p) => Number(p.positionAmt) !== 0).length;
}

/**
 * يُستدعى عند اكتشاف "فتح مركز جديد" من نظام التنبيهات الحالي.
 * @param {Object} p - نفس بنية المركز المستخدمة في openMsg() بـ lib/alerts.js
 * @returns {Object} نتيجة التنفيذ أو سبب التجاهل
 */
async function onPositionOpened(p) {
  const settings = await getBotSettings();
  if (!settings) return { executed: false, reason: 'لا إعدادات موجودة — الجدول فارغ' };
  if (!settings.enabled) return { executed: false, reason: 'البوت مُعطَّل حالياً من لوحة التحكم' };

  const currentPositions = await trade.getPositions();
  const openCount = countOpenPositions(currentPositions);
  if (openCount >= settings.max_concurrent_positions) {
    return { executed: false, reason: `الحد الأقصى للمراكز (${settings.max_concurrent_positions}) مُستَنفَد حالياً (${openCount} مفتوحة)` };
  }

  const isLong = p.side.includes('LONG') || p.side === 'BUY';
  const result = await executeEntry({
    symbol: p.symbol,
    side: isLong ? 'LONG' : 'SHORT',
    settings: {
      positionPct: Number(settings.position_pct),
      leverage: Number(settings.leverage),
      stopLossPct: Number(settings.stop_loss_pct),
      takeProfitPct: Number(settings.take_profit_pct),
    },
  });

  return { executed: true, result };
}

module.exports = { onPositionOpened, getBotSettings };
