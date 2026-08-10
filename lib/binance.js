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

function normOpen(t = {}) {
  const amount = num(t.positionAmount, t.positionAmt, t.amount, t.notionalValue);
  let side = String(t.positionSide || t.side || '').toUpperCase();
  if (!side && amount !== null) side = amount >= 0 ? 'LONG' : 'SHORT';   // الاتجاه من إشارة الكمية
  return {
    symbol: t.symbol || '—',
    side,
    amount,
    leverage: num(t.leverage),
    entryPrice: num(t.entryPrice, t.avgCost, t.openPrice),
    pnl: num(t.unrealizedProfit, t.unrealizedPnl, t.pnl),
    roi: asPct(num(t.roe, t.roi, t.pnlRate)),
    openTime: num(t.opened, t.updateTime, t.openTime, t.createTime),
  };
}

const listOf = (d) =>
  Array.isArray(d) ? d
  : Array.isArray(d?.list) ? d.list
  : Array.isArray(d?.data) ? d.data
  : [];

/* ---------------- الوظائف ---------------- */
const listBody = (page, size) => ({
  pageNumber: page, pageSize: size,
  timeRange: '30D', dataType: 'ROI', sortType: 'ROI',
  favoriteOnly: false, hideFull: false, nickname: '', order: 'DESC',
});

async function getTop() {
  const data = await call(ENDPOINTS.list, { body: listBody(1, 10) });
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
  const openList = listOf(val(open)).map(normOpen);

  if (!val(detail)) {
    const e = [detail, closed, open].map((r) => r.reason?.message).filter(Boolean);
    throw new Error(e[0] || 'لم تصل بيانات هذا المتداول.');
  }

  return {
    trader: normTrader(val(detail)),
    closed: closedList,
    open: openList,
    totalClosed: val(closed)?.total ?? null,
    hiddenHistory: closedList.length === 0,
    fetchedAt: Date.now(),
    raw: closedList.length ? undefined : null,
  };
}

/**
 * تصنيف بديل للعائد وحده.
 *  trust   = الأجدر بالثقة  → الأمان أولاً: ناسخون رابحون، سجل طويل، تراجع منخفض
 *  success = الناجحون       → العائد بعد تعديله بالمخاطرة (لا العائد الخام)
 */
async function getRanked({ mode = 'trust', scan = 50 } = {}) {
  let data;
  try { data = await call(ENDPOINTS.list, { body: listBody(1, scan) }); }
  catch { data = await call(ENDPOINTS.list, { body: listBody(1, 20) }); }

  const all = listOf(data).map(normTrader).filter((t) => t.id);
  const days = (ms) => (ms ? Math.floor((Date.now() - ms) / 86400000) : null);

  /* ---------- علامات الخطر: تُحسب للجميع في الوضعين ---------- */
  const flagsOf = (t, age) => {
    const f = [];
    if (t.copierPnl !== null && t.copierPnl <= 0) f.push('الناسخون خاسرون');
    if (age !== null && age < 90) f.push(`سجل ${age} يوماً فقط`);
    if (t.mdd !== null && t.mdd > 40) f.push(`تراجع ${t.mdd.toFixed(0)}%`);
    return f;
  };

  /* ================= الناجحون: الرقم الأكبر بلا استبعاد ================= */
  if (mode === 'success') {
    const traders = all
      .map((t) => {
        const age = days(t.startTime);
        const flags = flagsOf(t, age);
        return {
          ...t, age, flags,
          score: t.roi === null ? 0 : Math.round(t.roi * 10) / 10,
          why: [
            t.copierPnl !== null ? `الناسخون ${t.copierPnl > 0 ? 'رابحون' : 'خاسرون'}` : 'الناسخون غير معروف',
            age !== null ? `سجل ${age} يوماً` : 'عمر غير معروف',
            t.mdd !== null ? `تراجع ${t.mdd.toFixed(0)}%` : 'تراجع غير معروف',
          ],
        };
      })
      .sort((a, b) => (b.roi || 0) - (a.roi || 0));

    return {
      mode,
      rankedBy: 'raw',
      criteria: 'مرتّبون بأعلى عائد خام — بلا استبعاد',
      scanned: all.length,
      passedCount: traders.length,
      flaggedCount: traders.filter((t) => t.flags.length).length,
      cleanCount: traders.filter((t) => !t.flags.length).length,
      rejected: { copiers: 0, age: 0, mdd: 0, unknown: 0 },
      traders: traders.slice(0, 12),
      fetchedAt: Date.now(),
    };
  }

  /* ================= الأجدر بالثقة: فحص صارم ================= */
  const BAR = { age: 180, mdd: 25,
    label: 'سجل ٦ أشهر فأكثر · تراجع تحت ٢٥٪ · ناسخون رابحون' };

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
    const score = Math.min(age / 365, 2) * 30
                + (1 - Math.min(mdd, 50) / 50) * 40
                + ((t.winRate || 0) / 100) * 15
                + fill * 15;

    passed.push({
      ...t, age, flags: [],
      score: Math.round(score * 10) / 10,
      why: [`سجل ${age} يوماً`, `تراجع ${mdd.toFixed(0)}%`, 'ناسخون رابحون'],
    });
  }

  passed.sort((a, b) => b.score - a.score);

  return {
    mode, rankedBy: 'trust', criteria: BAR.label,
    scanned: all.length, passedCount: passed.length,
    flaggedCount: 0, cleanCount: passed.length,
    rejected, traders: passed.slice(0, 12), fetchedAt: Date.now(),
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
    const positions = listOf(r.value).map(normOpen).filter((p) => p.symbol !== '—');
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

module.exports = { getTop, searchTraders, getTrader, getSignals, getRanked, jsonHandler, BASE, HEADERS, ENDPOINTS };
