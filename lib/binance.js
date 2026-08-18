/**
 * منطق الاتصال بباينس — المسارات مؤكدة بالفحص (تعمل فعلياً).
 * إذا توقفت مستقبلاً، افتح /api/probe2 لإعادة اكتشاف المسارات.
 */

const BASE = 'https://www.binance.com';
const P = '/bapi/futures/v1/friendly/future/copy-trade';

const ENDPOINTS = {
  list:          { method: 'POST', url: `${P}/home-page/query-list` },
  detail:        { method: 'GET',  url: `${P}/lead-portfolio/detail?portfolioId={id}` },
  openPositions: { method: 'GET',  url: `${P}/lead-data/positions?portfolioId={id}` },
  closedTrades:  { method: 'POST', url: `${P}/lead-portfolio/position-history` },
};

const HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/json',
  'clienttype': 'web',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'referer': 'https://www.binance.com/en/copy-trading',
  'origin': 'https://www.binance.com',
};

async function call(ep, { id, body } = {}) {
  const url = BASE + (id ? ep.url.replace('{id}', id) : ep.url);
  const res = await fetch(url, {
    method: ep.method,
    headers: HEADERS,
    body: ep.method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`رد غير متوقع من باينس (${res.status}): ${text.slice(0, 100)}`); }
  if (json.success === false) throw new Error(json.message || `رفض من باينس (${json.code})`);
  return json.data;
}

/* ---------------- توحيد الحقول ---------------- */
const num = (...v) => {
  for (const x of v) {
    const n = Number(x);
    if (x !== null && x !== undefined && x !== '' && Number.isFinite(n)) return n;
  }
  return null;
};
/** قيم النسب في قوائم باينس تأتي كنسبة مئوية جاهزة (3867.77 = 3867%)،
 *  وفي الصفقات أحياناً ككسر (0.15 = 15%). نحوّل الكسور فقط. */
const asPct = (v) => (v === null ? null : Math.abs(v) <= 1.5 ? v * 100 : v);


/**
 * مقاييس مخاطر حقيقية محسوبة من منحنى العائد التراكمي الفعلي (chartItems)،
 * لا من رقم mdd المفرد الذي ترسله باينس. نُبقي رقم باينس أيضاً للمقارنة —
 * فارق كبير بينهما يستحق الانتباه بحد ذاته.
 * ⚠️ محدودة بحد أقصى ١٠٠٪ منطقياً (لا يمكن لتراجع أن يتجاوز كامل رأس المال).
 */
function computeRealMetrics(chartItems) {
  if (!Array.isArray(chartItems) || chartItems.length < 10) return null;
  const sorted = chartItems
    .filter((c) => c.dataType === 'ROI' && typeof c.value === 'number')
    .sort((a, b) => a.dateTime - b.dateTime);
  if (sorted.length < 10) return null;

  const equity = sorted.map((c) => 1 + c.value / 100);

  let peak = equity[0], maxDD = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = peak > 0 ? Math.min(100, Math.max(0, (peak - e) / peak * 100)) : 100;
    if (dd > maxDD) maxDD = dd;
  }

  const dailyReturns = [];
  for (let i = 1; i < sorted.length; i++) dailyReturns.push(sorted[i].value - sorted[i - 1].value);

  const RISK_FREE_DAILY = 0.02;   // ٪ يومياً ≈ ٧.٣٪ سنوياً
  const excess = dailyReturns.map((r) => r - RISK_FREE_DAILY);
  const meanExcess = excess.reduce((a, b) => a + b, 0) / excess.length;
  const downside = excess.filter((e) => e < 0);
  const downsideDev = downside.length
    ? Math.sqrt(downside.reduce((a, e) => a + e * e, 0) / downside.length) : 0;
  const sortino = downsideDev > 0 ? meanExcess / downsideDev : null;

  return {
    realMdd: Math.round(maxDD * 100) / 100,
    sortino: sortino !== null ? Math.round(sortino * 100) / 100 : null,
    daysUsed: sorted.length,
  };
}

function normTrader(p = {}) {
  return {
    id: p.leadPortfolioId || p.portfolioId || null,
    nickname: p.nickname || null,
    avatar: p.avatarUrl || null,
    // هذه الحقول تأتي من القائمة فقط (نقطة التفاصيل لا توفرها)
    roi: num(p.roi),
    pnl: num(p.pnl),
    winRate: num(p.winRate),
    mdd: num(p.mdd),
    // هذه تأتي من التفاصيل
    aum: num(p.aum, p.aumAmount),
    copiers: num(p.currentCopyCount),
    maxCopiers: num(p.maxCopyCount),
    favorites: num(p.favoriteCount),
    copierPnl: num(p.copierPnl),
    profitShare: num(p.profitSharingRate),
    lastTradeTime: num(p.lastTradeTime),
    status: p.status || null,
    positionShow: typeof p.positionShow === 'boolean' ? p.positionShow : null,
    isPublic: p.portfolioType ? p.portfolioType === 'PUBLIC' : null,
    startTime: num(p.startTime),
    chart: Array.isArray(p.chartItems)
      ? p.chartItems.map((c) => ({ t: num(c.dateTime), v: num(c.value) })).filter((c) => c.t)
      : null,
    // مقاييس مخاطر — sharpRatio معلَن مباشرة من باينس، الباقي محسوب من chartItems
    sharpe: num(p.sharpRatio),
    ...(computeRealMetrics(p.chartItems) || { realMdd: null, sortino: null, daysUsed: null }),
  };
}

function normClosed(t = {}) {
  // حقل roi يأتي ككسر نصي: "0.94938992" = 94.94%
  const roiRaw = num(t.roi, t.closingPnlRate, t.pnlRate);
  return {
    symbol: t.symbol || '—',
    side: String(t.side || t.positionSide || '').toUpperCase(),
    leverage: num(t.leverage),
    entryPrice: num(t.avgCost),
    exitPrice: num(t.avgClosePrice),
    pnl: num(t.closingPnl),
    roi: roiRaw === null ? null : roiRaw * 100,
    volume: num(t.closedVolume),
    margin: t.isolated || null,
    openTime: num(t.opened),
    closeTime: num(t.closed, t.updateTime),
  };
}

/**
 * ⚠️ نقطة lead-data/positions تُعيد كل رموز باينس (~٧٧٧) مع أصفار
 * لمن لا مركز له فيها — وليست قائمة مراكز مفتوحة فقط. الفلترة على
 * positionAmount != 0 إلزامية بعد الاستدعاء (isOpenPosition أدناه).
 * ولا يوجد حقل roi/roe من باينس هنا — نحسبه من الهامش التقديري.
 */
function normOpen(t = {}) {
  const amount = num(t.positionAmount, t.positionAmt, t.amount);
  let side = String(t.positionSide || t.side || '').toUpperCase();
  if ((!side || side === 'BOTH') && amount !== null) side = amount >= 0 ? 'LONG' : 'SHORT';

  const entryPrice = num(t.entryPrice, t.avgCost, t.openPrice);
  const markPrice = num(t.markPrice, t.currentPrice);
  const leverage = num(t.leverage);
  const pnl = num(t.unrealizedProfit, t.unrealizedPnl, t.pnl);
  const isIsolated = t.isolated === true || t.isolated === 'true';

  /**
   * ⚠️ الهامش الحقيقي — رقم مُعلَن من باينس نفسها، لا حساب تقديري:
   * isolatedWallet هو المبلغ الفعلي المخصَّص لهذا المركز، لكن فقط في
   * وضع "Isolated". في وضع "Cross" لا يوجد هامش مخصص لكل مركز —
   * رأس المال مشترك بين كل المراكز معاً.
   * notionalValue = حجم المركز الكامل بالدولار (بعد الرافعة).
   */
  const notional = num(t.notionalValue) ?? (amount !== null && markPrice !== null
    ? Math.abs(amount * markPrice) : null);
  const marginReported = isIsolated ? num(t.isolatedWallet) : null;

  // roi: نستخدم الهامش المُعلَن إن توفر (وضع Isolated)، وإلا نقدّره
  let roi = null;
  const marginForRoi = (marginReported && marginReported > 0)
    ? marginReported
    : (amount !== null && entryPrice !== null && leverage
        ? Math.abs(amount * entryPrice) / leverage : null);
  if (marginForRoi && marginForRoi > 0 && pnl !== null) {
    roi = (pnl / marginForRoi) * 100;
  }

  return {
    symbol: t.symbol || '—',
    side,
    amount,
    leverage,
    entryPrice,
    markPrice,
    pnl,
    roi,
    notional,
    marginReported,
    marginMode: isIsolated ? 'isolated' : 'cross',
    openTime: num(t.opened, t.updateTime, t.openTime, t.createTime),  // غالباً غير متوفر
  };
}

/** هل هذا الصف مركزاً حقيقياً مفتوحاً؟ (وليس أحد الأصفار الافتراضية) */
function isOpenPosition(p) {
  return p.symbol !== '—' && p.amount !== null && Math.abs(p.amount) > 0;
}

const listOf = (d) =>
  Array.isArray(d) ? d
  : Array.isArray(d?.list) ? d.list
  : Array.isArray(d?.data) ? d.data
  : [];

/* ---------------- الوظائف ---------------- */
const listBody = (page, size, range = '30D') => ({
  pageNumber: page, pageSize: size,
  timeRange: range, dataType: 'ROI', sortType: 'ROI',
  favoriteOnly: false, hideFull: false, nickname: '', order: 'DESC',
});

// تبويب "المتداولون" الرئيسي: ٩٠ يوماً بدل ٣٠ — بقية الأقسام (بحث/
// متابعة/الأجدر بالثقة/إشارات) تبقى على الافتراضي دون تغيير.
async function getTop() {
  const data = await call(ENDPOINTS.list, { body: listBody(1, 10, '90D') });
  return listOf(data).map(normTrader).filter((t) => t.id);
}

/** بحث بالاسم: باينس لا تدعم بحثاً نصياً هنا، فنجلب عدة صفحات ونصفّي محلياً */
async function searchTraders(q) {
  const needle = q.trim().toLowerCase();
  const found = [];
  for (let page = 1; page <= 6; page++) {
    const data = await call(ENDPOINTS.list, { body: listBody(page, 50) });
    const rows = listOf(data).map(normTrader).filter((t) => t.id);
    if (!rows.length) break;
    found.push(...rows.filter((t) => t.nickname.toLowerCase().includes(needle)));
    if (found.length >= 20) break;
  }
  return found.slice(0, 20);
}

/**
 * ⚠️ اكتشاف مهم: من يُخفي مراكزه (positionShow=false) ترجع له باينس
 * مصفوفة فارغة تماماً `[]` من lead-data/positions. من يعرضها ترجع
 * مئات الصفوف (كل رموز باينس، معظمها أصفار لمن لا مركز له فيها).
 * فطول المصفوفة الخام — قبل أي فلترة — هو مؤشر "هل هو ظاهر أصلاً؟"
 * بلا حاجة لطلب إضافي منفصل لحقل positionShow.
 */
function rawPositionsArray(raw) {
  return Array.isArray(raw) ? raw : (Array.isArray(raw?.list) ? raw.list : []);
}

async function getTrader(id) {
  const [detail, closed, open] = await Promise.allSettled([
    call(ENDPOINTS.detail, { id }),
    call(ENDPOINTS.closedTrades, { body: { portfolioId: id, pageNumber: 1, pageSize: 10 } }),
    call(ENDPOINTS.openPositions, { id }),
  ]);
  const val = (r) => (r.status === 'fulfilled' ? r.value : null);

  const closedList = listOf(val(closed)).map(normClosed)
    .sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0))
    .slice(0, 10);

  const rawOpen = rawPositionsArray(val(open));
  const openList = rawOpen.map(normOpen).filter(isOpenPosition);
  const positionsVisible = rawOpen.length > 0;   // انظر التعليق أعلاه

  if (!val(detail)) {
    const e = [detail, closed, open].map((r) => r.reason?.message).filter(Boolean);
    throw new Error(e[0] || 'لم تصل بيانات هذا المتداول.');
  }

  return {
    trader: normTrader(val(detail)),
    closed: closedList,
    open: openList,
    positionsVisible,
    totalClosed: val(closed)?.total ?? null,
    hiddenHistory: closedList.length === 0,
    fetchedAt: Date.now(),
    raw: closedList.length ? undefined : null,
  };
}

/**
 * حالة خفيفة الوزن لمتداول واحد: هل مراكزه ظاهرة؟ وكم مركزاً مفتوحاً
 * حقيقياً الآن؟ (يُستخدم لعرض علامة 🟢/🔴 بجانب الاسم في القوائم،
 * بلا حاجة لتحميل تفاصيله الكاملة).
 */
async function getPositionStatus(id) {
  try {
    const raw = rawPositionsArray(await call(ENDPOINTS.openPositions, { id }));
    return {
      id,
      visible: raw.length > 0,
      openCount: raw.map(normOpen).filter(isOpenPosition).length,
    };
  } catch {
    return { id, visible: null, openCount: null };   // تعذّر الجلب — لا نعرف
  }
}

/** نفس ما سبق لعدة متداولين بالتوازي، بحد أقصى لمنع تحميل زائد */
async function getPositionStatusBulk(ids) {
  const list = [...new Set(ids)].filter(Boolean).slice(0, 25);
  const results = await Promise.allSettled(list.map((id) => getPositionStatus(id)));
  const out = {};
  results.forEach((r, i) => {
    out[list[i]] = r.status === 'fulfilled' ? r.value : { id: list[i], visible: null, openCount: null };
  });
  return out;
}

/**
 * تصنيف بديل للعائد وحده.
 *  trust   = الأجدر بالثقة  → الأمان أولاً: ناسخون رابحون، سجل طويل، تراجع منخفض
 *  success = الناجحون       → العائد بعد تعديله بالمخاطرة (لا العائد الخام)
 */
async function getRanked({ pages = 6 } = {}) {
  // باينس تعيد ٣٠ متداولاً كحد أقصى في الصفحة، فنجلب عدة صفحات
  const seen = new Set();
  const all = [];
  for (let page = 1; page <= pages; page++) {
    let rows;
    try { rows = listOf(await call(ENDPOINTS.list, { body: listBody(page, 50) })); }
    catch { break; }
    if (!rows.length) break;
    for (const r of rows.map(normTrader)) {
      if (r.id && !seen.has(r.id)) { seen.add(r.id); all.push(r); }
    }
  }
  const days = (ms) => (ms ? Math.floor((Date.now() - ms) / 86400000) : null);

  // معايير موسّعة: تقبل مخاطرة أعلى من النسخة السابقة
  const BAR = { age: 120, mdd: 35,
    label: 'سجل ٤ أشهر فأكثر · تراجع تحت ٣٥٪ · ناسخون رابحون' };

  const rejected = { copiers: 0, age: 0, mdd: 0, unknown: 0 };
  const passed = [];

  for (const t of all) {
    const age = days(t.startTime);
    if (t.copierPnl === null) { rejected.unknown++; continue; }
    if (t.copierPnl <= 0)     { rejected.copiers++; continue; }
    if (age === null || age < BAR.age) { rejected.age++; continue; }
    if (t.mdd !== null && t.mdd > BAR.mdd) { rejected.mdd++; continue; }

    const mdd = t.mdd === null ? 25 : Math.max(t.mdd, 1);
    const fill = t.copiers && t.maxCopiers ? t.copiers / t.maxCopiers : 0;
    const score = Math.min(age / 365, 2) * 25
                + (1 - Math.min(mdd, 50) / 50) * 30
                + ((t.winRate || 0) / 100) * 15
                + fill * 10
                + Math.min((t.roi || 0) / 100, 20);   // وزن للعائد أيضاً

    passed.push({
      ...t, age,
      score: Math.round(score * 10) / 10,
      why: [`سجل ${age} يوماً`, `تراجع ${mdd.toFixed(0)}%`, 'ناسخون رابحون'],
    });
  }

  passed.sort((a, b) => b.score - a.score);

  return {
    criteria: BAR.label,
    scanned: all.length,
    passedCount: passed.length,
    rejected,
    traders: passed.slice(0, 12),
    fetchedAt: Date.now(),
  };
}

/**
 * قائمة المتابعة: يبحث عن معرّفات محددة داخل صفحات القائمة
 * (لأنها المصدر الوحيد لـ ROI ونتيجة الناسخين ومنحنى العائد)،
 * وما لا يوجد فيها يُجلب من نقطة التفاصيل.
 */
async function getWatch(ids = []) {
  const want = new Set(ids.filter(Boolean));
  const found = {};

  for (let page = 1; page <= 6 && want.size; page++) {
    let rows;
    try { rows = listOf(await call(ENDPOINTS.list, { body: listBody(page, 50) })); }
    catch { break; }
    if (!rows.length) break;
    for (const raw of rows) {
      const t = normTrader(raw);
      if (t.id && want.has(t.id)) { found[t.id] = { ...t, source: 'list' }; want.delete(t.id); }
    }
  }

  // من لم يظهر ضمن المتصدرين: بياناته الأساسية فقط
  for (const id of want) {
    try {
      const d = await call(ENDPOINTS.detail, { id });
      found[id] = { ...normTrader(d), source: 'detail' };
    } catch { /* تجاهل */ }
  }

  return {
    traders: ids.map((id) => found[id]).filter(Boolean),
    missing: ids.filter((id) => !found[id]),
    fetchedAt: Date.now(),
  };
}

/**
 * الإشارات الحية: يمسح أعلى المتداولين ويجمّع مراكزهم المفتوحة
 * ليكشف العملات التي يتفق عليها أكثر من متداول الآن.
 */
async function getSignals({ scan = 20 } = {}) {
  const data = await call(ENDPOINTS.list, { body: listBody(1, scan) });
  const traders = listOf(data).map(normTrader).filter((t) => t.id);

  const fetched = await Promise.allSettled(
    traders.map((t) => call(ENDPOINTS.openPositions, { id: t.id }))
  );

  const groups = {};
  const visible = [];

  traders.forEach((t, i) => {
    const r = fetched[i];
    if (r.status !== 'fulfilled') return;
    const positions = listOf(r.value).map(normOpen).filter(isOpenPosition);
    if (!positions.length) return;
    visible.push({ id: t.id, nickname: t.nickname });

    positions.forEach((p) => {
      const dir = p.side.includes('SHORT') || p.side === 'SELL' ? 'SHORT' : 'LONG';
      const key = p.symbol + '|' + dir;
      const g = (groups[key] = groups[key] || {
        symbol: p.symbol, side: dir, traders: [], newest: 0,
        entries: [], rois: [], levs: [],
      });
      g.traders.push({ id: t.id, nickname: t.nickname, roi: t.roi, openTime: p.openTime });
      if (p.openTime && p.openTime > g.newest) g.newest = p.openTime;
      if (p.entryPrice !== null) g.entries.push(p.entryPrice);
      if (p.roi !== null) g.rois.push(p.roi);
      if (p.leverage !== null) g.levs.push(p.leverage);
    });
  });

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  const signals = Object.values(groups)
    .map((g) => ({
      symbol: g.symbol,
      side: g.side,
      count: g.traders.length,
      traders: g.traders.sort((a, b) => (b.openTime || 0) - (a.openTime || 0)).slice(0, 6),
      newest: g.newest || null,
      avgEntry: mean(g.entries),
      avgRoi: mean(g.rois),
      avgLev: mean(g.levs),
    }))
    .sort((a, b) => b.count - a.count || (b.newest || 0) - (a.newest || 0));

  return {
    scanned: traders.length,
    visibleCount: visible.length,
    hiddenCount: traders.length - visible.length,
    visible,
    signals,
    fetchedAt: Date.now(),
  };
}

/** يضمن أن الرد JSON دائماً — حتى عند الخطأ */
function jsonHandler(fn, cacheSeconds = 30) {
  return async (req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', `s-maxage=${cacheSeconds}, stale-while-revalidate=120`);
    try {
      res.status(200).end(JSON.stringify(await fn(req)));
    } catch (e) {
      res.status(502).end(JSON.stringify({ error: e.message }));
    }
  };
}

function normalizeOpenPositions(list) {
  return listOf(list).map(normOpen).filter(isOpenPosition);
}

module.exports = {
  getTop, searchTraders, getTrader, getSignals, getRanked, getWatch,
  getPositionStatus, getPositionStatusBulk, jsonHandler,
  BASE, HEADERS, ENDPOINTS,
  __internal: { normalizeOpenPositions, normOpen, isOpenPosition },
};
