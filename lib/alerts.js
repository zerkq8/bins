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
 *
 * ⚠️ إضافة جديدة: ربط اختياري بالبوت الآلي (lib/botTradeAuto.js).
 * معزول بالكامل عن مسار تيليجرام — أي خطأ فيه لا يوقف أو يؤخر إرسال
 * التنبيهات إطلاقاً (try/catch منفصل تماماً). ونُحدَّد بمركز واحد فقط
 * لكل دورة فحص (لا كل المراكز المكتشفة معاً) لتفادي تجاوز حد ١٠ ثوانٍ،
 * بما أن تنفيذ البوت الكامل (دخول+وقف+هدف) يستغرق ثوانٍ عدة بمفرده.
 *
 * ⚠️ توقيت الدخول (openDetectedAt): باينس لا ترسل وقت فتح المركز
 * بشكل موثوق (حقل openTime من normOpen غالباً فارغ)، فنسجّل بدلاً منه
 * توقيت اكتشافنا نحن للمركز أول مرة (Date.now() لحظة ظهوره بالمقارنة
 * بين اللقطتين)، ونحمله مع المركز عبر كل تحديث لاحق حتى إغلاقه —
 * فتصل رسالة الإغلاق بنفس التوقيت المحفوظ منذ الفتح.
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

/**
 * يحوّل طابعاً زمنياً (ms) لصيغة "٢٠٢٦-٠٩-٠٦ الساعة ٣:١٥ مساءً"
 * بتوقيت الكويت (Asia/Kuwait، UTC+3 بلا توقيت صيفي). يُرجع null
 * إذا لم يتوفر طابع زمني صالح.
 */
function formatKuwaitDateTime(ms) {
  if (!ms || !Number.isFinite(Number(ms))) return null;
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kuwait',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const y = get('year'), mo = get('month'), da = get('day');
  const h = get('hour'), mi = get('minute'), ap = get('dayPeriod');
  if (!y || !mo || !da || !h || !mi) return null;
  const period = ap === 'PM' ? 'مساءً' : 'صباحاً';
  return `${y}-${mo}-${da} الساعة ${h}:${mi} ${period}`;
}

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
  const openTxt = formatKuwaitDateTime(p.openDetectedAt);
  return `${emoji} <b>أُغلق المركز</b>

👤 المتداول: <b>${trader.nickname || trader.id}</b>
💱 العملة: <b>${p.symbol}</b>
📊 الاتجاه: ${isLong ? 'شراء LONG' : 'بيع SHORT'}
🎯 دخوله كان: <code>${fmt(p.entryPrice)}</code>${openTxt ? `\n🕐 دخل في: ${openTxt} (بتوقيت الكويت)` : ''}
📈 آخر عائد مسجّل: <b>${roiTxt}</b>`;
}

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

/* ---------------- سجل الإغلاقات (للتقرير اليومي) ----------------
 * يُكتب في نفس لحظة closeMsg(). الكائن هنا هو آخر لقطة للمركز وهو مفتوح —
 * فيه roi آخر رصد (قبل الإغلاق بدقائق) ولا يحتوي ربحاً بالدولار أصلاً؛ لذا
 * pnl هنا تقدير = roi × الهامش المُقدَّر، ويُصحَّح لاحقاً في التقرير من سجل
 * باينس الفعلي (getClosedTrades) متى توفر.
 */
function estimateMargin(p) {
  if (Number(p.marginReported) > 0) return Number(p.marginReported);
  if (Number(p.notional) > 0 && Number(p.leverage) > 0) return Number(p.notional) / Number(p.leverage);
  return null;
}

function closedLogRow(deviceKey, trader, p) {
  const roi = (p.roi === null || p.roi === undefined || !Number.isFinite(Number(p.roi))) ? null : Number(p.roi);
  const margin = estimateMargin(p);
  const pnl = roi !== null && margin ? Number(((roi / 100) * margin).toFixed(4)) : null;
  return {
    device_key: deviceKey, trader_id: String(trader.trader_id), nickname: trader.nickname || null,
    symbol: p.symbol || null, side: p.side || null, roi, pnl, pnl_source: 'estimate',
    closed_at: new Date().toISOString(),
  };
}

/* ---------------- الفحص (دفعة دورية) ---------------- */
const LOW_THRESHOLD = 3;    // % — أقل من هذا = نفس المركز، صامت
const HIGH_THRESHOLD = 8;   // % — أعلى من هذا = مركز مختلف بثقة
const groupKey = (p) => `${p.symbol}|${(p.side || '').toUpperCase()}`;

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
    } else if (nowP && !prevP) {
      opened.push(nowP);
    } else if (prevP && !nowP) {
      closed.push(prevP);
    }
  }
  return { opened, closed, ambiguous };
}

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
  const closedLog = [];     // صفوف closed_trades_log — تُدرَج بعد الإرسال، وفشلها لا يمس التنبيهات
  const botCandidates = []; // ⚠️ جديد: مرشحو الدخول الآلي، منفصلون تماماً عن رسائل تيليجرام

  rows.forEach((row, i) => {
    const id = String(row.trader_id);
    const r = fetched[i];
    if (r.status !== 'fulfilled') { failed++; return; }

    const positions = r.value || [];
    const prev = prevMap[id] || [];
    if (!positions.length && !prev.length) hidden++;

    // نحمل openDetectedAt من اللقطة السابقة لنفس المركز (نفس الرمز
    // والاتجاه) إن وُجد، وإلا هذه أول مرة نراه فيها فنسجّل الآن.
    const now = positions.map((p) => {
      const key = groupKey(p);
      const existing = prev.find((pr) => groupKey(pr) === key);
      return {
        symbol: p.symbol, side: p.side, entryPrice: p.entryPrice,
        leverage: p.leverage, roi: p.roi,
        marginReported: p.marginReported, notional: p.notional, marginMode: p.marginMode,
        openDetectedAt: existing?.openDetectedAt || Date.now(),
      };
    });
    const firstRun = !(id in prevMap);

    if (!firstRun) {
      const { opened, closed, ambiguous } = matchPositions(prev, now);
      for (const p of opened) { toSend.push(openMsg(row, p)); botCandidates.push(p); }
      for (const p of closed) { toSend.push(closeMsg(row, p)); closedLog.push(closedLogRow(deviceKey, row, p)); }
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
  if (closedLog.length) {
    try { await sb('closed_trades_log', { method: 'POST', body: JSON.stringify(closedLog) }); }
    catch { /* سجل التقرير اليومي فقط — لا يؤثر على التنبيهات أو اللقطات */ }
  }
  try { await setCursor(deviceKey, nextCursor); } catch { /* غير حرج */ }

  /**
   * ⚠️ البوت الآلي — معزول بالكامل، مركز واحد فقط لكل دورة فحص، بعد
   * إرسال تيليجرام (لا قبله)، بحماية try/catch منفصلة تماماً. أي فشل
   * هنا لا يُسقِط الدالة كلها ولا يؤثر على ما سبق، ويُسجَّل فقط في
   * الرد النهائي للمراقبة اللاحقة عبر selftest.
   */
  let botResult = null;
  if (botCandidates.length) {
    try {
      const { onPositionOpened } = require('./botTradeAuto');
      botResult = await onPositionOpened(botCandidates[0]);
    } catch (e) {
      botResult = { executed: false, reason: `خطأ غير متوقع: ${e.message}` };
    }
  }

  return {
    checked: rows.length,
    totalWatched: allRows.length,
    batch: buildBatchLabel(start, rows.length, allRows.length),
    sent, hiddenOrEmpty: hidden, failed,
    botCandidatesFound: botCandidates.length,
    botResult,
  };
}

/* ================= التقرير اليومي (مرة يومياً 18:00 UTC = 21:00 الكويت) =================
 * يُستدعى عبر /api/alerts?key=…&report=daily من مهمة cron-job.org منفصلة.
 * مصدر الحقيقة للأرقام: سجل باينس الفعلي للصفقات المغلقة (pnl بالدولار
 * الحقيقي) لكل متداول متابَع حالياً — يُمسح بالكامل (لا فقط من ظهر في
 * closed_trades_log)، لتغطية صفقة فُتحت وأُغلقت بين دورتي فحص متتاليتين
 * (< ~8 دقائق) قبل أن تُسجَّل أصلاً. عند تعذّر الجلب لمتداول (سجل مخفي/فشل
 * الطلب)، نرجع لتقدير closed_trades_log له تحديداً ونضع ≈ أمام رقمه.
 * المراكز المفتوحة الآن من آخر لقطة محفوظة (position_snapshots) — بلا
 * استدعاء إضافي لباينس.
 */
const KUWAIT_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3 ثابت — الكويت بلا توقيت صيفي
// مهلة أضيق خاصة بمسح التقرير اليومي (لا تمس PER_REQUEST_TIMEOUT_MS
// المشتركة مع الفحص الدوري كل دقيقتين): حتى 20 طلباً متوازياً + إرسال
// تيليجرام يجب أن يبقيا بأمان تحت حد ١٠ ثوانٍ لدوال Vercel Hobby.
const DAILY_HIST_TIMEOUT_MS = 3500;

/** حدود "اليوم" الكويتي الذي يقع فيه nowMs: من منتصف الليل بتوقيت الكويت حتى الآن */
function kuwaitDayBounds(nowMs = Date.now()) {
  const kw = nowMs + KUWAIT_OFFSET_MS;
  const dayStartKw = Math.floor(kw / 86400000) * 86400000;
  const startMs = dayStartKw - KUWAIT_OFFSET_MS;
  return {
    startMs, endMs: nowMs,
    startIso: new Date(startMs).toISOString(), endIso: new Date(nowMs).toISOString(),
    label: new Date(dayStartKw).toISOString().slice(0, 10),
  };
}

/**
 * تصنيف أداء (🔴/🟡/🟢) — يعتمد حصراً على copierPnl (نقطة التفاصيل) وآخر
 * 10 صفقات مغلقة فعلياً (من نفس getClosedTrades المُستدعاة أصلاً، بلا أي
 * فلترة تاريخ — تاريخ التداول الكامل، لا صفقات اليوم فقط). لا mdd هنا: غير
 * متوفر من نقطة التفاصيل (تحقّقنا حياً)، ويتطلب تصفّح صفحات القائمة بلا
 * ضمان العثور على المتداول أصلاً — تكلفة/عدم يقين لا يستحقان الإضافة.
 * copierPnl أو last10 غير المتوفرَين (فشل الجلب) يُعاملان كغير معروفَين،
 * لا كصفر — فلا يُحتسبان ضد المتداول ولا له.
 */
function gradeTrader({ copierPnl, last10 }) {
  const wins = last10.filter((t) => Number(t.roi) > 0).length;
  const losses = last10.length - wins;
  if ((copierPnl !== null && copierPnl < 0) || losses >= 6) return 'red';
  if (copierPnl !== null && copierPnl > 0 && wins >= 6) return 'green';
  return 'yellow';
}
const GRADE_EMOJI = { red: '🔴', yellow: '🟡', green: '🟢' };
const GRADE_NOTE = {
  red: '\n  ⚠️ تقييم عام: أداء ضعيف — راجع استمرار المتابعة',
  green: '\n  ✅ تقييم عام: أداء قوي — استمر بمتابعته',
  yellow: '',
};

const escHtml = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const fmtUsdSigned = (v) => {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v), abs = Math.abs(n).toFixed(2);
  return n > 0 ? `+$${abs}` : n < 0 ? `−$${abs}` : `$${abs}`;
};

function dailyReportMsg({ dayLabel, traders }) {
  if (!traders.length) {
    return `📊 <b>التقرير اليومي — ${dayLabel}</b>

لا صفقات مغلقة اليوم لأي متداول متابَع.`;
  }
  const withTotal = traders.filter((t) => t.pnlTotal !== null);
  const winners = withTotal.filter((t) => t.pnlTotal > 0).length;
  const losers = withTotal.filter((t) => t.pnlTotal < 0).length;
  const grand = withTotal.length ? withTotal.reduce((s, t) => s + t.pnlTotal, 0) : null;
  const anyEstimate = traders.some((t) => t.source === 'estimate');

  const lines = traders.map((t) => {
    const approx = t.source === 'estimate' ? '≈ ' : '';
    const emoji = GRADE_EMOJI[t.grade] ? `${GRADE_EMOJI[t.grade]} ` : '';
    return `👤 ${emoji}<b>${escHtml(t.name)}</b>
  صفقات اليوم: ${t.count} (${t.wins} رابحة، ${t.losses} خاسرة) · <b>${approx}${fmtUsdSigned(t.pnlTotal)}</b>
  مراكز مفتوحة الآن: ${t.openNow === null ? '—' : t.openNow}${GRADE_NOTE[t.grade] || ''}`;
  });

  return `📊 <b>التقرير اليومي — ${dayLabel}</b>

📈 ${winners} رابحين اليوم · 📉 ${losers} خاسرين
💰 الإجمالي الكلي: <b>${anyEstimate ? '≈ ' : ''}${fmtUsdSigned(grand)}</b>

${lines.join('\n\n')}
${anyEstimate ? '\n<i>≈ تقدير من آخر عائد مرصود قبل الإغلاق — سجل باينس غير متاح لهذا المتداول (مخفي أو تعذّر جلبه).</i>' : ''}
<i>راجع الموقع لإدارة قائمة متابعتك بناءً على هذي الأرقام.</i>`;
}

/** هل أُرسل تقرير اليوم بالفعل؟ فحص سريع لتوفير العمل عند استدعاء متكرر واضح */
async function hasReportBeenSentToday(deviceKey, dateLabel) {
  const rows = await sb(
    `daily_report_log?device_key=eq.${encodeURIComponent(deviceKey)}&report_date=eq.${encodeURIComponent(dateLabel)}&select=sent_at`
  );
  return rows.length > 0;
}

/**
 * الحجز الذري الفعلي — عبر قيد UNIQUE على (device_key, report_date) في
 * قاعدة البيانات، لا مجرد "تحقق ثم أرسل" (له فجوة سباق). يُستدعى مباشرة
 * قبل tg()، لا في بداية الدالة، حتى لا يُحجز اليوم إن فشل بناء التقرير
 * قبل الوصول لمرحلة الإرسال أصلاً.
 * ⚠️ ملاحظة صادقة: إن نجح الحجز ثم فشل tg() نفسه (تيليجرام معطّلة
 * تحديداً في تلك اللحظة)، يبقى اليوم "محجوزاً" بلا رسالة فعلية حتى
 * الغد — هذا تنازل مقصود لصالح ضمان عدم التكرار المطلق الذي طلبته،
 * لا خطأ في التصميم.
 */
async function claimDailyReportSlot(deviceKey, dateLabel) {
  const res = await fetch(`${SB_URL}/rest/v1/daily_report_log`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json',
      prefer: 'return=minimal', // ⚠️ عمداً بلا resolution=merge-duplicates — يجب أن يفشل التعارض الحقيقي بـ409
    },
    body: JSON.stringify([{ device_key: deviceKey, report_date: dateLabel }]),
  });
  if (res.status === 201 || res.status === 200) return true;
  if (res.status === 409) return false; // القيد UNIQUE رفض الإدراج — أُرسل تقرير اليوم بالفعل
  throw new Error(`Supabase ${res.status}: ${(await res.text().catch(() => '')).slice(0, 140)}`);
}

async function runDailyReport({ deviceKey }) {
  const now = Date.now();
  const day = kuwaitDayBounds(now);
  const enc = encodeURIComponent;

  if (await hasReportBeenSentToday(deviceKey, day.label)) {
    return { report: 'daily', day: day.label, skipped: true, reason: 'تقرير اليوم أُرسل بالفعل' };
  }

  const [watchRows, logRows, snaps] = await Promise.all([
    sb(`watchlist?device_key=eq.${enc(deviceKey)}&select=trader_id,nickname&order=id.asc&limit=${MAX_TRADERS}`),
    sb(`closed_trades_log?device_key=eq.${enc(deviceKey)}&closed_at=gte.${enc(day.startIso)}&closed_at=lte.${enc(day.endIso)}`
      + `&select=trader_id,nickname,roi,pnl&order=closed_at.asc`),
    sb(`position_snapshots?device_key=eq.${enc(deviceKey)}&select=trader_id,positions`).catch(() => []),
  ]);

  const openMap = Object.fromEntries(snaps.map((s) => [String(s.trader_id), (s.positions || []).length]));
  const nameOf = Object.fromEntries(watchRows.map((w) => [String(w.trader_id), w.nickname]));

  const logByTrader = new Map();
  for (const r of logRows) {
    const id = String(r.trader_id);
    if (!logByTrader.has(id)) logByTrader.set(id, []);
    logByTrader.get(id).push({ roi: r.roi, pnl: r.pnl });
    if (!nameOf[id] && r.nickname) nameOf[id] = r.nickname; // احتياط لمتداول أُزيل من المتابعة بعد إغلاقه اليوم
  }

  // نطاق المسح: كل المتابَعين حالياً + أي متداول ظهر في السجل اليوم ولو أُزيل
  // من المتابعة لاحقاً — لا نفوّت نشاطاً فعلياً حصل.
  const scanIds = [...new Set([...watchRows.map((w) => String(w.trader_id)), ...logByTrader.keys()])];
  if (!scanIds.length) return { report: 'daily', day: day.label, tradersWithCloses: 0, sent: false, note: 'لا يوجد متابَعون' };

  // مسح كامل لسجل باينس الفعلي + copierPnl لكل متداول في النطاق، بالتوازي
  // منذ البداية (لا مرحلتين متتاليتين) — كلا الطلبين مستقل عن الآخر، فزمن
  // التنفيذ الكلي يبقى محكوماً بأبطأ طلب واحد (DAILY_HIST_TIMEOUT_MS) لا
  // بمجموعهما، رغم مضاعفة عدد الطلبات المتزامنة تقريباً. نجلب copierPnl
  // لكل المتابَعين هنا (لا فقط من ظهر له نشاط لاحقاً) لأننا لا نعرف من
  // نشط قبل انتهاء مسح getClosedTrades أصلاً.
  const { getClosedTrades, getTraderCopierPnl } = require('./binance');
  const [hist, copierPnlResults] = await Promise.all([
    Promise.allSettled(scanIds.map((id) => withTimeout(getClosedTrades(id, 50), DAILY_HIST_TIMEOUT_MS))),
    Promise.allSettled(scanIds.map((id) => withTimeout(getTraderCopierPnl(id), DAILY_HIST_TIMEOUT_MS))),
  ]);
  const copierPnlOf = {};
  scanIds.forEach((id, i) => { copierPnlOf[id] = copierPnlResults[i].status === 'fulfilled' ? copierPnlResults[i].value : null; });

  const traders = scanIds.map((id, i) => {
    const fullHistory = hist[i].status === 'fulfilled' ? hist[i].value : [];
    let trades = null, source = 'estimate';
    if (hist[i].status === 'fulfilled') {
      const inWindow = fullHistory.filter((t) => t.closeTime >= day.startMs && t.closeTime <= day.endMs);
      if (inWindow.length) { trades = inWindow.map((t) => ({ roi: t.roi, pnl: t.pnl })); source = 'binance'; }
    }
    if (!trades) trades = logByTrader.get(id) || [];
    if (!trades.length) return null; // لا نشاط اليوم لهذا المتداول — لا يظهر في التقرير إطلاقاً

    const wins = trades.filter((t) => Number(t.roi) > 0).length;        // رابحة = roi > 0
    const losses = trades.length - wins;                                  // خاسرة = roi ≤ 0 (أو غير معروف)
    const pnls = trades.map((t) => Number(t.pnl)).filter(Number.isFinite);
    const pnlTotal = pnls.length ? Number(pnls.reduce((s, v) => s + v, 0).toFixed(2)) : null;
    // آخر 10 صفقات مغلقة فعلياً (كل التاريخ، لا صفقات اليوم فقط) — من نفس
    // fullHistory أعلاه، مرتّبة أصلاً من الأحدث؛ بلا أي طلب إضافي.
    const last10 = fullHistory.slice(0, 10);
    const grade = gradeTrader({ copierPnl: copierPnlOf[id], last10 });
    return { id, name: nameOf[id] || id, count: trades.length, wins, losses, pnlTotal, source, grade, openNow: id in openMap ? openMap[id] : null };
  }).filter(Boolean);
  traders.sort((a, b) => (b.pnlTotal ?? -Infinity) - (a.pnlTotal ?? -Infinity));

  let text = dailyReportMsg({ dayLabel: day.label, traders });
  if (text.length > 4000) text = text.slice(0, 3950) + '\n\n<i>…اختُصر التقرير لطوله.</i>'; // حد تيليجرام 4096

  const claimed = await claimDailyReportSlot(deviceKey, day.label);
  if (!claimed) return { report: 'daily', day: day.label, skipped: true, reason: 'تقرير اليوم أُرسل بالفعل (تعارض عند الإرسال)' };

  const r = await tg(text);

  return {
    report: 'daily', day: day.label, window: { from: day.startIso, to: day.endIso },
    scanned: scanIds.length, tradersWithCloses: traders.length,
    fromBinanceHistory: traders.filter((t) => t.source === 'binance').length,
    fromEstimates: traders.filter((t) => t.source === 'estimate').length,
    sent: !!r?.ok, telegram: r?.ok ? 'ok' : (r?.description || r?.reason || 'unknown'),
  };
}

module.exports = {
  runAlerts, runDailyReport, tg, MAX_TRADERS,
  __internal: {
    kuwaitDayBounds, dailyReportMsg, closedLogRow, hasReportBeenSentToday, claimDailyReportSlot,
    gradeTrader, formatKuwaitDateTime,
  },
};
