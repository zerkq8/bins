/**
 * مراقبة المراكز المفتوحة وإرسال تنبيهات تيليجرام.
 * يقارن اللقطة الحالية بالسابقة: ما ظهر = فُتح، ما اختفى = أُغلق.
 *
 * ⚠️ الخطة المجانية في Vercel تفرض ١٠ ثوانٍ كحد أقصى للدالة، بغض
 * النظر عن maxDuration في vercel.json. لا نحاول تسريع فحص الجميع
 * دفعة واحدة، بل نفحص دفعة صغيرة فقط (BATCH_SIZE) كل استدعاء،
 * ونتنقل بينها دورياً عبر مؤشر محفوظ في Supabase. بما أن cron يتكرر
 * كل دقيقتين، يُغطى الجميع خلال دقائق قليلة بدل محاولة كل شيء دفعة
 * واحدة والفشل بـ 504.
 */

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

const MAX_TRADERS = 20;
const BATCH_SIZE = 6;              // كم متداولاً نفحص في كل استدعاء
const PER_REQUEST_TIMEOUT_MS = 5000;

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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/* ---------------- مؤشر الدورية (أي دفعة نفحص هذه المرة) ---------------- */
async function getCursor(deviceKey) {
  const rows = await sb(`alert_cursor?device_key=eq.${encodeURIComponent(deviceKey)}&select=pos`);
  return rows[0]?.pos || 0;
}
async function setCursor(deviceKey, pos) {
  await sb('alert_cursor', {
    method: 'POST',
    body: JSON.stringify([{ device_key: deviceKey, pos, updated_at: new Date().toISOString() }]),
  });
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

/**
 * ⚠️ رسالة "غموض صادق" — للحالات الحدّية التي لا يمكن الجزم فيها هل هي
 * توسيط لنفس المركز (DCA) أم إغلاق فعلي وفتح جديد. بدل ادّعاء يقين لا
 * نملكه (رسالتا فتح+إغلاق واثقتان قد تكونان خاطئتين)، نخبر المستخدم
 * بصدق أن الأمر غامض ونوجّهه للتحقق بنفسه.
 */
function ambiguousMsg(trader, prevP, nowP, diffPct) {
  const isLong = nowP.side.includes('LONG') || nowP.side === 'BUY';
  return `⚠️ <b>تغيّر ملحوظ في المركز</b>

👤 المتداول: <b>${trader.nickname || trader.id}</b>
💱 العملة: <b>${nowP.symbol}</b>
📊 الاتجاه: ${isLong ? 'شراء LONG' : 'بيع SHORT'}
🎯 السعر السابق: <code>${fmt(prevP.entryPrice)}</code> ← الحالي: <code>${fmt(nowP.entryPrice)}</code>
📐 فرق: <b>${diffPct.toFixed(1)}%</b>

<i>قد يكون توسيطاً لنفس المركز (DCA)، أو إغلاقاً وفتحاً فعلياً — لا يمكن الجزم من البيانات المتاحة. تحقق من "آخر الصفقات المغلقة" في صفحته للتأكيد.</i>`;
}

/* ---------------- الفحص (دفعة دورية) ---------------- */
/**
 * ⚠️ مشكلة اكتُشفت بالتجربة: مقارنة "العملة+الاتجاه" فقط تخلط بين
 * "نفس المركز مستمر" و"أُغلق مركز وفُتح آخر بنفس الاتجاه". مثال حقيقي:
 * متداول فتح شورت SNDKUSDT عند 1406، صُفّي المركز (تحرك السعر +5%
 * وتجاوز عتبة التصفية)، ثم فتح شورت جديد على نفس العملة عند 1543 —
 * والمقارنة القديمة اعتبرتهما مركزاً واحداً، فابتلعت رسالة التصفية.
 *
 * ⚠️ تحديث لاحق بعد التجربة الفعلية: عتبة واحدة صارمة (1.5%) أنتجت
 * العكس — أخطاء "فتح جديد" وهمية لمراكز فيها توسيط (DCA) طبيعي بفارق
 * 2-3%. الحل: ثلاث مناطق بدل قرار ثنائي:
 *   - فرق ≤ LOW  : نفس المركز مستمر، صامت كما يجب
 *   - LOW < فرق ≤ HIGH : غموض حقيقي — رسالة صادقة واحدة، لا ادّعاء يقين
 *   - فرق > HIGH : مركز مختلف بثقة عالية — رسالتا إغلاق+فتح كالمعتاد
 * HIGH=8% اختير خصيصاً ليبقى أعلى من حالة SNDKUSDT الحقيقية (9.67%
 * كانت لتصبح 10 لكن خُفّضت لضمان بقاء ذلك الكشف الحقيقي واثقاً).
 */
const LOW_THRESHOLD = 3;    // % — أقل من هذا = نفس المركز، صامت
const HIGH_THRESHOLD = 8;   // % — أعلى من هذا = مركز مختلف بثقة
const groupKey = (p) => `${p.symbol}|${(p.side || '').toUpperCase()}`;

/** يقارن قائمتي مراكز (سابقة وحالية) ويحدد ماذا فُتح، أُغلق، أو غامض */
function matchPositions(prevList, nowList) {
  const prevByGroup = {}, nowByGroup = {};
  for (const p of prevList) (prevByGroup[groupKey(p)] ??= []).push(p);
  for (const p of nowList) (nowByGroup[groupKey(p)] ??= []).push(p);

  const opened = [], closed = [], ambiguous = [];
  const allGroups = new Set([...Object.keys(prevByGroup), ...Object.keys(nowByGroup)]);

  for (const g of allGroups) {
    const prevP = (prevByGroup[g] || [])[0];
    const nowP = (nowByGroup[g] || [])[0];

    if (prevP && nowP) {
      const bothHavePrice = prevP.entryPrice && nowP.entryPrice;
      const diffPct = bothHavePrice
        ? Math.abs(nowP.entryPrice - prevP.entryPrice) / prevP.entryPrice * 100
        : 0;

      if (diffPct > HIGH_THRESHOLD) {
        closed.push(prevP);
        opened.push(nowP);
      } else if (diffPct > LOW_THRESHOLD) {
        ambiguous.push({ prevP, nowP, diffPct });
      }
      // وإلا (≤ LOW_THRESHOLD): نفس المركز مستمر — صامت، وهذا صحيح
    } else if (nowP && !prevP) {
      opened.push(nowP);
    } else if (prevP && !nowP) {
      closed.push(prevP);
    }
  }
  return { opened, closed, ambiguous };
}

/**
 * ⚠️ إصلاح خلل اكتُشف بالتجربة: حين تلتف الدفعة حول نهاية القائمة
 * (مثال حقيقي: start=3، حجم الدفعة=6، الإجمالي=8 — يعني الفحص يغطي
 * المواضع ٤،٥،٦،٧،٨ ثم يلتف ليأخذ الموضع ١)، كان النص القديم يعرض
 * "٤–٩ من ٨" — رقم نهاية أكبر من الإجمالي، وهو مستحيل منطقياً.
 * هذه الدالة تبني نصاً صادقاً يعكس الالتفاف الفعلي، لا رقماً وهمياً.
 */
function buildBatchLabel(start, rowsLength, total) {
  if (rowsLength >= total) return `الكل (${total})`;
  const end = start + rowsLength;
  if (end <= total) return `${start + 1}–${end} من ${total}`;
  const wrappedEnd = end - total;
  return `${start + 1}–${total} ثم ١–${wrappedEnd} من ${total}`;
}

async function runAlerts({ callPositions, deviceKey }) {
  const allRows = await sb(
    `watchlist?device_key=eq.${encodeURIComponent(deviceKey)}&select=trader_id,nickname&order=id.asc&limit=${MAX_TRADERS}`
  );
  if (!allRows.length) return { checked: 0, sent: 0, note: 'لا يوجد متابَعون' };

  // اختر الدفعة الحالية بحسب المؤشر المحفوظ
  let cursor = 0;
  try { cursor = await getCursor(deviceKey); } catch { /* الجدول قد لا يكون موجوداً بعد */ }
  const start = cursor % allRows.length;
  const rows = [];
  for (let i = 0; i < Math.min(BATCH_SIZE, allRows.length); i++) {
    rows.push(allRows[(start + i) % allRows.length]);
  }
  const nextCursor = (start + rows.length) % allRows.length;

  const snaps = await sb(
    `position_snapshots?device_key=eq.${encodeURIComponent(deviceKey)}&select=trader_id,positions`
  );
  const prevMap = Object.fromEntries(snaps.map((s) => [String(s.trader_id), s.positions || []]));

  const fetched = await Promise.allSettled(
    rows.map((r) => withTimeout(callPositions(String(r.trader_id)), PER_REQUEST_TIMEOUT_MS))
  );

  let sent = 0, hidden = 0, failed = 0;
  const upserts = [];
  const toSend = [];

  rows.forEach((row, i) => {
    const id = String(row.trader_id);
    const r = fetched[i];
    if (r.status !== 'fulfilled') { failed++; return; }

    const positions = r.value || [];
    if (!positions.length && !(prevMap[id] || []).length) hidden++;

    const now = positions.map((p) => ({
      symbol: p.symbol, side: p.side, entryPrice: p.entryPrice,
      leverage: p.leverage, roi: p.roi,
      marginReported: p.marginReported, notional: p.notional, marginMode: p.marginMode,
    }));
    const prev = prevMap[id] || [];
    const firstRun = !(id in prevMap);

    if (!firstRun) {
      const { opened, closed, ambiguous } = matchPositions(prev, now);
      for (const p of opened) toSend.push(openMsg(row, p));
      for (const p of closed) toSend.push(closeMsg(row, p));
      for (const a of ambiguous) toSend.push(ambiguousMsg(row, a.prevP, a.nowP, a.diffPct));
    }

    upserts.push({
      device_key: deviceKey, trader_id: id,
      positions: now, updated_at: new Date().toISOString(),
    });
  });

  /**
   * ⚠️ إرسال متسلسل بفاصل بسيط، لا متوازٍ بالكامل — تيليجرام تفرض حد
   * معدل لكل مجموعة، وإرسال عدة رسائل في نفس اللحظة قد يؤخرها أو
   * يُفشل بعضها من طرفها. فاصل ٣٥٠ مللي ثانية بين كل رسالة يقلل هذا
   * الخطر بلا أي أثر يُذكر على سرعة الاستجابة الكلية.
   */
  if (toSend.length) {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    let ok = 0;
    for (let i = 0; i < toSend.length; i++) {
      try {
        const r = await tg(toSend[i]);
        if (r?.ok) ok++;
      } catch { /* نتابع الباقي حتى لو فشلت رسالة واحدة */ }
      if (i < toSend.length - 1) await delay(350);
    }
    sent = ok;
  }
  if (upserts.length) {
    await sb('position_snapshots', { method: 'POST', body: JSON.stringify(upserts) });
  }
  try { await setCursor(deviceKey, nextCursor); } catch { /* غير حرج */ }

  return {
    checked: rows.length,
    totalWatched: allRows.length,
    batch: buildBatchLabel(start, rows.length, allRows.length),
    sent, hiddenOrEmpty: hidden, failed,
  };
}

module.exports = { runAlerts, tg, MAX_TRADERS };
