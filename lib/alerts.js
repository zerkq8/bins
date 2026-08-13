/**
 * مراقبة المراكز المفتوحة وإرسال تنبيهات تيليجرام.
 * يقارن اللقطة الحالية بالسابقة: ما ظهر = فُتح، ما اختفى = أُغلق.
 *
 * ⚠️ الفحص يعمل بالتوازي (Promise.allSettled) لا بالتتابع — مع ١٤+
 * متداولاً، الفحص المتتابع يتجاوز مهلة Vercel (10s) ويسبب 504.
 * كل طلب لباينس محدود بمهلة داخلية (8s) لمنع تعليق التوازي كله
 * بسبب متداول واحد بطيء الاستجابة.
 */

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

const MAX_TRADERS = 20;
const PER_REQUEST_TIMEOUT_MS = 8000;

const sbHeaders = () => ({
  apikey: SB_KEY,
  authorization: `Bearer ${SB_KEY}`,
  'content-type': 'application/json',
  prefer: 'resolution=merge-duplicates,return=representation',
});

async function sb(path, options = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { ...options, headers: sbHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 140)}`);
  try { return text ? JSON.parse(text) : []; } catch { return []; }
}

/** يلفّ أي Promise بمهلة زمنية حتى لا يعلّق التوازي كله */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/* ---------------- تيليجرام ---------------- */
async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) return { ok: false, reason: 'إعدادات تيليجرام ناقصة' };
  try {
    const res = await withTimeout(
      fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true,
        }),
      }),
      PER_REQUEST_TIMEOUT_MS
    );
    return await res.json();
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/* ---------------- صياغة الرسائل ---------------- */
const fmt = (v, d = 4) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? '—'
    : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function openMsg(trader, p) {
  const isLong = p.side.includes('LONG') || p.side === 'BUY';
  const dir = isLong ? '🟢 شراء LONG' : '🔴 بيع SHORT';
  const lev = Number(p.leverage) || 0;
  const warn = lev >= 10
    ? `\n\n⚠️ رافعة ×${lev} — حركة معاكسة ${(100 / lev).toFixed(1)}% تصفّي المركز.`
    : '';
  return `🔔 <b>فُتح مركز جديد</b>

👤 المتداول: <b>${trader.nickname || trader.id}</b>
💱 العملة: <b>${p.symbol}</b>
📊 الاتجاه: ${dir}
🎯 سعر الدخول: <code>${fmt(p.entryPrice)}</code>
⚡ الرافعة: ×${lev || '—'}${warn}

<i>باينس لا ترسل وقت فتح المركز — هذا وقت اكتشافنا له، قد يكون فُتح قبل قليل.</i>`;
}

function closeMsg(trader, p) {
  const isLong = p.side.includes('LONG') || p.side === 'BUY';
  const roi = p.roi;
  const emoji = roi > 0 ? '✅' : roi < 0 ? '❌' : '⚪';
  const roiTxt = roi === null || roi === undefined
    ? '—'
    : `${roi > 0 ? '+' : ''}${Number(roi).toFixed(2)}%`;
  return `${emoji} <b>أُغلق المركز</b>

👤 المتداول: <b>${trader.nickname || trader.id}</b>
💱 العملة: <b>${p.symbol}</b>
📊 الاتجاه: ${isLong ? 'شراء LONG' : 'بيع SHORT'}
🎯 دخوله كان: <code>${fmt(p.entryPrice)}</code>
📈 آخر عائد مسجّل: <b>${roiTxt}</b>`;
}

/* ---------------- الفحص (بالتوازي) ---------------- */
const keyOf = (p) => `${p.symbol}|${(p.side || '').toUpperCase()}`;

async function runAlerts({ callPositions, deviceKey }) {
  const rows = await sb(
    `watchlist?device_key=eq.${encodeURIComponent(deviceKey)}&select=trader_id,nickname&limit=${MAX_TRADERS}`
  );
  if (!rows.length) return { checked: 0, sent: 0, note: 'لا يوجد متابَعون' };

  const snaps = await sb(
    `position_snapshots?device_key=eq.${encodeURIComponent(deviceKey)}&select=trader_id,positions`
  );
  const prevMap = Object.fromEntries(snaps.map((s) => [String(s.trader_id), s.positions || []]));

  // ١) جلب مراكز الجميع بالتوازي — لا بالتتابع
  const fetched = await Promise.allSettled(
    rows.map((r) => withTimeout(callPositions(String(r.trader_id)), PER_REQUEST_TIMEOUT_MS))
  );

  let sent = 0, hidden = 0, failed = 0;
  const upserts = [];
  const toSend = [];   // نجمع الرسائل أولاً، ثم نرسلها بالتوازي أيضاً

  rows.forEach((row, i) => {
    const id = String(row.trader_id);
    const r = fetched[i];
    if (r.status !== 'fulfilled') { failed++; return; }

    const positions = r.value || [];
    if (!positions.length && !(prevMap[id] || []).length) hidden++;

    const now = positions.map((p) => ({
      symbol: p.symbol, side: p.side, entryPrice: p.entryPrice,
      leverage: p.leverage, roi: p.roi,
    }));
    const prev = prevMap[id] || [];
    const nowKeys = new Set(now.map(keyOf));
    const prevKeys = new Set(prev.map(keyOf));
    const firstRun = !(id in prevMap);

    if (!firstRun) {
      for (const p of now) if (!prevKeys.has(keyOf(p))) toSend.push(openMsg(row, p));
      for (const p of prev) if (!nowKeys.has(keyOf(p))) toSend.push(closeMsg(row, p));
    }

    upserts.push({
      device_key: deviceKey, trader_id: id,
      positions: now, updated_at: new Date().toISOString(),
    });
  });

  // ٢) إرسال كل الرسائل بالتوازي
  if (toSend.length) {
    const results = await Promise.allSettled(toSend.map((m) => tg(m)));
    sent = results.filter((r) => r.status === 'fulfilled' && r.value?.ok).length;
  }

  // ٣) حفظ اللقطات دفعة واحدة
  if (upserts.length) {
    await sb('position_snapshots', { method: 'POST', body: JSON.stringify(upserts) });
  }

  return { checked: rows.length, sent, hiddenOrEmpty: hidden, failed };
}

module.exports = { runAlerts, tg, MAX_TRADERS };
