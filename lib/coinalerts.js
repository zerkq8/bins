/**
 * متابعة عملات (لا متداولين) وتنبيه عند وصول السعر لأدنى قاعه خلال
 * فترة محددة (افتراضياً ١٨٠ يوماً — نفس فترة "السياق التاريخي").
 */
const { getPeriodExtremes } = require('./market');
const { tg } = require('./alerts');   // نعيد استخدام دالة الإرسال نفسها

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const MAX_COINS = 15;
const LOOKBACK_DAYS = 180;

async function sb(path, options = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`,
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=representation',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 140)}`);
  try { return text ? JSON.parse(text) : []; } catch { return []; }
}

/* ---------------- إدارة القائمة (تستخدمها الواجهة) ---------------- */
async function listWatchedCoins(deviceKey) {
  return await sb(
    `watched_coins?device_key=eq.${encodeURIComponent(deviceKey)}&select=symbol&order=added_at.asc`
  );
}

async function addCoin(deviceKey, symbol) {
  const s = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s || s.length < 5) throw new Error('رمز غير صالح.');
  await sb('watched_coins', {
    method: 'POST',
    body: JSON.stringify([{ device_key: deviceKey, symbol: s }]),
  });
  return listWatchedCoins(deviceKey);
}

async function removeCoin(deviceKey, symbol) {
  const s = String(symbol).toUpperCase();
  await sb(
    `watched_coins?device_key=eq.${encodeURIComponent(deviceKey)}&symbol=eq.${encodeURIComponent(s)}`,
    { method: 'DELETE' }
  );
  return listWatchedCoins(deviceKey);
}

/** حالة كل عملة الآن — تُستخدم في عرض تبويب متابعتي مباشرة (بلا تنبيه) */
async function getWatchedCoinsStatus(deviceKey) {
  const rows = await listWatchedCoins(deviceKey);
  const results = await Promise.allSettled(
    rows.map((r) => getPeriodExtremes(r.symbol, LOOKBACK_DAYS))
  );
  return rows.map((r, i) => {
    const res = results[i];
    return res.status === 'fulfilled'
      ? { symbol: r.symbol, ok: true, ...res.value }
      : { symbol: r.symbol, ok: false, error: res.reason?.message || 'تعذّر الجلب' };
  });
}

/* ---------------- التنبيهات (يستدعيها api/alerts.js دورياً) ---------------- */
async function runCoinAlerts(deviceKey) {
  const rows = await listWatchedCoins(deviceKey);
  if (!rows.length) return { coinsChecked: 0, coinsSent: 0 };

  const list = rows.slice(0, MAX_COINS);
  const snaps = await sb(
    `coin_snapshots?device_key=eq.${encodeURIComponent(deviceKey)}&select=symbol,at_low`
  );
  const prevMap = Object.fromEntries(snaps.map((s) => [s.symbol, s.at_low]));

  const fetched = await Promise.allSettled(
    list.map((r) => getPeriodExtremes(r.symbol, LOOKBACK_DAYS))
  );

  let sent = 0;
  const upserts = [];
  const messages = [];

  list.forEach((row, i) => {
    const r = fetched[i];
    if (r.status !== 'fulfilled') return;
    const d = r.value;
    const wasAtLow = row.symbol in prevMap ? prevMap[row.symbol] : null;
    const firstRun = wasAtLow === null;

    // تنبيه فقط عند "انتقال جديد" لحالة القاع — لا تكرار كل دورة وهو باقٍ هناك
    if (!firstRun && d.atLow && !wasAtLow) {
      messages.push(`📉 <b>وصلت لأدنى قاعها</b>

💱 العملة: <b>${d.symbol}</b>
🎯 السعر الحالي: <code>${d.current}</code>
📊 أدنى قاع خلال ${LOOKBACK_DAYS} يوماً: <code>${d.periodLow}</code>

<i>هذه ليست توصية شراء — فقط معلومة سياقية. القاع القديم لا يمنع قاعاً أدنى.</i>`);
    }

    upserts.push({
      device_key: deviceKey, symbol: row.symbol,
      at_low: d.atLow, low_price: d.periodLow,
      updated_at: new Date().toISOString(),
    });
  });

  if (messages.length) {
    const results = await Promise.allSettled(messages.map((m) => tg(m)));
    sent = results.filter((r) => r.status === 'fulfilled' && r.value?.ok).length;
  }
  if (upserts.length) {
    await sb('coin_snapshots', { method: 'POST', body: JSON.stringify(upserts) });
  }

  return { coinsChecked: list.length, coinsSent: sent };
}

module.exports = { listWatchedCoins, addCoin, removeCoin, getWatchedCoinsStatus, runCoinAlerts };
