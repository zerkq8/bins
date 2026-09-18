/**
 * "توافق النخبة" — نظام تنبيهات معلوماتي منفصل تماماً عن البوت الآلي
 * (botTradeAuto) وعن قائمة متابعة أي مستخدم (watchlist). بيانات عامة
 * مشتركة (لا device_key): يراقب ١٥ متداولاً "نخبة" — مُصفّون بنفس
 * معايير الجودة الخمس المستخدمة في فلتر "الأقوى" بالواجهة
 * (computeStrongScore في index.html) — وينبّه عبر تيليجرام عند توافق
 * ٧ منهم فأكثر على نفس العملة والاتجاه في نفس اللحظة تقريباً.
 *
 * ⚠️ معلوماتي بحت: لا دخول آلي، لا وقف خسارة تلقائي، لا ربط بالبوت.
 *
 * جزءان مستقلان زمنياً:
 *  1) refreshEliteTraders() — يومياً: يعيد اختيار الـ١٥ من الصفر.
 *  2) checkConsensus()      — كل ساعة: يفحص مراكزهم المفتوحة الآن.
 */

const { ENDPOINTS, HEADERS, BASE, getEliteCandidates, getClosedTrades, __internal } = require('./binance');
const { tg, __internal: alertsInternal } = require('./alerts');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

async function sb(path, options = {}, prefer = 'resolution=merge-duplicates,return=representation') {
  const headers = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' };
  if (prefer) headers.prefer = prefer;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { ...options, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 160)}`);
  try { return text ? JSON.parse(text) : []; } catch { return []; }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/* ================= ١) الاختيار اليومي للنخبة ================= */

const LIST_PAGES = 6;            // نفس عمق getRanked/getWatch — ٦×٥٠ = ٣٠٠ متداول
const LIST_PAGE_SIZE = 50;
const LEV_CANDIDATES_CAP = 40;   // حد أعلى لعدد من نتحقق من رافعتهم — يضبط الزمن مهما كبر عدد المؤهلين بالمعايير الأربعة
const LEV_TIMEOUT_MS = 3500;
const ELITE_SIZE = 15;
const MIN_SCORE = 4;             // نفس عتبة فلتر "الأقوى" بالواجهة: ٤ من ٥

const daysSince = (ms) => (ms ? Math.floor((Date.now() - ms) / 86400000) : null);

/** المعايير الأربعة القابلة للحساب من بيانات القائمة وحدها (بلا الرافعة) */
function listChecks(t) {
  const age = daysSince(t.startTime);
  return {
    age,
    copierPnl: t.copierPnl !== null && t.copierPnl > 0,
    mdd: t.mdd !== null && t.mdd < 25,
    ageOk: age !== null && age >= 180,
    sharpeSortino: t.sharpe !== null && t.sharpe > 1 && t.sortino !== null && t.sortino > 1,
  };
}

async function refreshEliteTraders() {
  const all = await getEliteCandidates({ pages: LIST_PAGES, pageSize: LIST_PAGE_SIZE });

  const partial = all.map((t) => {
    const c = listChecks(t);
    const score4 = [c.copierPnl, c.mdd, c.ageOk, c.sharpeSortino].filter(Boolean).length;
    return { t, age: c.age, score4 };
  }).filter((x) => x.score4 >= MIN_SCORE - 1); // من يملك فرصة الوصول لـ٤/٥ حتى لو أخفق بالرافعة أو نجح بها

  // ترتيب حسب عدد المعايير أولاً ثم copierPnl — لتوجيه ميزانية فحص
  // الرافعة (محدودة بـ LEV_CANDIDATES_CAP) نحو الأرجح تأهلاً وترتيباً
  partial.sort((a, b) => b.score4 - a.score4 || ((b.t.copierPnl ?? -Infinity) - (a.t.copierPnl ?? -Infinity)));
  const toCheck = partial.slice(0, LEV_CANDIDATES_CAP);

  const levResults = await Promise.allSettled(
    toCheck.map((x) => withTimeout(getClosedTrades(x.t.id, 20), LEV_TIMEOUT_MS))
  );

  const scored = toCheck.map((x, i) => {
    const r = levResults[i];
    const closed = r.status === 'fulfilled' ? r.value : [];
    const levs = closed.map((c) => Number(c.leverage)).filter(Number.isFinite);
    const avgLeverage = levs.length ? levs.reduce((a, b) => a + b, 0) / levs.length : null;
    const levOk = avgLeverage !== null && avgLeverage < 10;
    return { ...x.t, age: x.age, avgLeverage, score: x.score4 + (levOk ? 1 : 0) };
  }).filter((x) => x.score >= MIN_SCORE);

  scored.sort((a, b) => b.score - a.score || ((b.copierPnl ?? -Infinity) - (a.copierPnl ?? -Infinity)));
  const elite = scored.slice(0, ELITE_SIZE);

  // استبدال كامل للقائمة كل مرة — أبسط وأوضح من upsert جزئي، ويضمن
  // عدم بقاء متداول فقد تأهله من دورة سابقة
  await sb('elite_traders?id=gte.0', { method: 'DELETE' }, 'return=minimal');
  if (elite.length) {
    await sb('elite_traders', {
      method: 'POST',
      body: JSON.stringify(elite.map((t) => ({
        trader_id: String(t.id), nickname: t.nickname, score: t.score,
        copier_pnl: t.copierPnl, qualified_at: new Date().toISOString(),
      }))),
    });
  }

  return {
    scanned: all.length,
    candidatesConsidered: partial.length,
    leverageChecked: toCheck.length,
    eliteCount: elite.length,
    elite: elite.map((t) => ({ id: t.id, nickname: t.nickname, score: t.score, copierPnl: t.copierPnl })),
  };
}

/* ================= ٢) الفحص الدوري (كل ساعة) ================= */

/**
 * ⚠️ عتبة نسبية لا ثابتة: التجربة الحية أظهرت أن ١٨٠ متداولاً مفحوصاً
 * ينتج عنهم ٣ فقط يجتازون فلتر الجودة الكامل — بعيد جداً عن ELITE_SIZE
 * (١٥)، فعتبة ثابتة كـ"٧ من ١٥" مستحيلة رياضياً بعيّنة أصغر. العتبة هنا
 * دائماً "أغلبية صارمة من قائمة النخبة الفعلية الحالية" (أكثر من نصفها)،
 * أياً كان حجمها.
 * وحتى مع عتبة نسبية، عيّنة صغيرة جداً تجعل الأغلبية أسهل حدوثاً بالصدفة
 * (عملة مشهورة كـBTC/ETH يدخلها كثيرون أصلاً بلا أي توافق حقيقي) — لذا
 * حد أدنى مطلق ABS_MIN_ELITE يمنع أي فحص توافق إطلاقاً بعيّنة أصغر منه.
 * ⚠️ خُفِّض عمداً من ٥ إلى ٣ (بطلب صريح) رغم أن "٢ من ٣" أضعف إحصائياً —
 * قرار مقصود لتفعيل الميزة بحجم النخبة الفعلي الحالي (٣ فقط اجتازوا
 * فلتر الجودة الكامل)، لا خطأ تصميم.
 */
const ABS_MIN_ELITE = 3;         // لا فحص توافق إطلاقاً بعيّنة أصغر من هذا
const POSITIONS_TIMEOUT_MS = 4000;
const DEDUPE_HOURS = 24;
const NOTABLE_INCREASE = 3;      // فرق عدد يستحق تنبيهاً جديداً رغم نافذة الـ٢٤ ساعة
const MSG_TRADER_LIST_CAP = 20;  // حد عرض الأسماء بالرسالة (سقف طول لا علاقة له بحجم القائمة الفعلي)

async function callOpenPositions(id) {
  const url = BASE + ENDPOINTS.openPositions.url.replace('{id}', id);
  const res = await withTimeout(fetch(url, { headers: HEADERS }), POSITIONS_TIMEOUT_MS);
  const j = await res.json();
  const list = Array.isArray(j?.data) ? j.data : (j?.data?.list || []);
  return __internal.normalizeOpenPositions(list);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/**
 * قرار الإرسال لعملة+اتجاه واحد: يقرأ آخر تنبيه لنفس الرمز بنفس
 * الاتجاه وبالاتجاه المعاكس خلال آخر ٢٤ ساعة، ويقرر:
 *  - لا تنبيه سابق بنفس الاتجاه            → إرسال (انعكاس إن وُجد تنبيه معاكس حديث)
 *  - تنبيه سابق ولم يتغيّر العدد بشكل ملحوظ → صامت (تكرار)
 *  - تنبيه سابق لكن العدد ارتفع بشكل ملحوظ  → إرسال (تحديث)
 */
async function decideSend(g, totalElite) {
  const sinceIso = new Date(Date.now() - DEDUPE_HOURS * 3600 * 1000).toISOString();
  const enc = encodeURIComponent;

  const [sameDir, oppDir] = await Promise.all([
    sb(`consensus_alerts_log?symbol=eq.${enc(g.symbol)}&direction=eq.${enc(g.direction)}&sent_at=gte.${enc(sinceIso)}&select=count,sent_at&order=sent_at.desc&limit=1`, {}, null),
    sb(`consensus_alerts_log?symbol=eq.${enc(g.symbol)}&direction=neq.${enc(g.direction)}&sent_at=gte.${enc(sinceIso)}&select=count,sent_at&order=sent_at.desc&limit=1`, {}, null),
  ]);

  const reversal = oppDir.length > 0;
  if (!sameDir.length) return { send: true, reason: reversal ? 'reversal' : 'first' };

  const prevCount = Number(sameDir[0].count) || 0;
  // "ارتفاع ملحوظ": فرق ≥3 دائماً، أو وصول لإجماع كامل (كل النخبة) بعد
  // ألا كان كذلك — بديل نسبي عن رقم مطلق ثابت ("10+") لا معنى له مع
  // حجم قائمة نخبة متغيّر قد يكون أصغر من ١٠ أصلاً.
  const notable = (g.count - prevCount >= NOTABLE_INCREASE) || (g.count === totalElite && prevCount < totalElite);
  if (notable) return { send: true, reason: 'notable-increase', prevCount };
  return { send: false, reason: 'duplicate-within-24h', prevCount };
}

function buildConsensusMsg(g, decision, totalElite, threshold) {
  const dirTxt = g.direction === 'LONG' ? '🟢 LONG (شراء)' : '🔴 SHORT (بيع)';
  const names = g.traders.slice(0, MSG_TRADER_LIST_CAP).map((t) => `• ${t.nickname || t.id}`).join('\n');
  const timeTxt = alertsInternal.formatKuwaitDateTime(Date.now());
  const reversalNote = decision.reason === 'reversal'
    ? '\n\n⚠️ انعكاس اتجاه: كان هناك توافق بالاتجاه المعاكس على نفس العملة خلال آخر ٢٤ ساعة.'
    : '';
  const increaseNote = decision.reason === 'notable-increase'
    ? `\n\n📈 ارتفاع ملحوظ في عدد المتفقين (كان ${decision.prevCount}، الآن ${g.count}).`
    : '';
  const entryTxt = g.avgEntry !== null
    ? Number(g.avgEntry).toLocaleString('en-US', { maximumFractionDigits: 6 })
    : '—';

  return `🏆 <b>توافق النخبة</b>

💱 العملة: <b>${g.symbol}</b>
📊 الاتجاه: ${dirTxt}
👥 عدد المتفقين: <b>${g.count} من ${totalElite}</b> (الحد المطلوب: أكثر من ${threshold - 1})
🎯 متوسط سعر الدخول: <code>${entryTxt}</code>
🕐 وقت الرصد: ${timeTxt || '—'} (بتوقيت الكويت)

المتداولون:
${names}${reversalNote}${increaseNote}

<i>⚠️ تنبيه معلوماتي بحت — لا دخول آلي ولا وقف خسارة تلقائي هنا. القرار يبقى يدوياً بالكامل، وراجع كل متداول بنفسك قبل أي قرار.</i>`;
}

async function checkConsensus() {
  const eliteRows = await sb('elite_traders?select=trader_id,nickname', {}, null);
  const totalElite = eliteRows.length;
  if (totalElite < ABS_MIN_ELITE) {
    return {
      eliteCount: totalElite, checked: 0, sent: 0,
      note: `عدد النخبة المؤهلين حالياً (${totalElite}) أقل من الحد الأدنى المطلق (${ABS_MIN_ELITE}) — لا فحص توافق بعيّنة بهذا الصغر`,
    };
  }
  const threshold = Math.floor(totalElite / 2) + 1; // أغلبية صارمة من القائمة الفعلية، أياً كان حجمها

  const fetched = await Promise.allSettled(eliteRows.map((r) => callOpenPositions(String(r.trader_id))));

  const groups = {};
  let failed = 0;
  fetched.forEach((r, i) => {
    if (r.status !== 'fulfilled') { failed++; return; }
    const trader = eliteRows[i];
    for (const p of r.value) {
      const dir = p.side.includes('SHORT') || p.side === 'SELL' ? 'SHORT' : 'LONG';
      const key = `${p.symbol}|${dir}`;
      const g = (groups[key] = groups[key] || { symbol: p.symbol, direction: dir, traders: [], entries: [] });
      g.traders.push({ id: trader.trader_id, nickname: trader.nickname });
      if (p.entryPrice !== null) g.entries.push(p.entryPrice);
    }
  });

  const qualifying = Object.values(groups)
    .map((g) => ({ ...g, count: g.traders.length, avgEntry: mean(g.entries) }))
    .filter((g) => g.count >= threshold);

  // قرارات الإرسال لكل المجموعات المؤهلة بالتوازي أولاً (عادة ٠-٢ مجموعة
  // فقط — أغلبية صارمة من النخبة نادرة) — ثم الإرسال الفعلي تسلسلياً
  // لتفادي أي ضغط لحظي على حد معدل تيليجرام.
  const decisions = await Promise.all(qualifying.map((g) => decideSend(g, totalElite)));

  let sent = 0;
  const details = [];
  for (let i = 0; i < qualifying.length; i++) {
    const g = qualifying[i], decision = decisions[i];
    details.push({ symbol: g.symbol, direction: g.direction, count: g.count, ...decision });
    if (!decision.send) continue;
    const r = await tg(buildConsensusMsg(g, decision, totalElite, threshold));
    if (r?.ok) {
      sent++;
      try {
        await sb('consensus_alerts_log', {
          method: 'POST',
          body: JSON.stringify([{ symbol: g.symbol, direction: g.direction, count: g.count }]),
        });
      } catch { /* فشل تسجيل السجل لا يُسقط التنبيه نفسه — قد يتكرر أقرب دورة فقط */ }
    }
  }

  return {
    eliteCount: totalElite, threshold, checked: totalElite, failed,
    groupsFound: Object.keys(groups).length, qualifying: qualifying.length,
    sent, details,
  };
}

module.exports = { refreshEliteTraders, checkConsensus };
