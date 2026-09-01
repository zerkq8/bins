/**
 * api/botsettings.js
 * قراءة وتعديل إعدادات البوت — محمية بمفتاح إداري منفصل تماماً
 * (BOT_ADMIN_KEY من متغيرات البيئة)، لا نفس مفاتيح المتابعة البسيطة
 * (1111/2222/3333) المستخدمة لعرض البيانات فقط. هذا يحمي كتابة فعلية
 * على إعدادات تحرّك مالاً حقيقياً (ولو تجريبياً الآن).
 *
 * GET  /api/botsettings?key=المفتاح_الإداري          → قراءة الإعدادات الحالية
 * POST /api/botsettings?key=المفتاح_الإداري            → تحديثها (body: JSON)
 */
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const ADMIN_KEY = (process.env.BOT_ADMIN_KEY || '').trim();

async function sb(path, options = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

function validateSettings(s) {
  const errors = [];
  if (!(s.position_pct > 0 && s.position_pct <= 100)) errors.push('نسبة المركز يجب أن تكون بين 0 و 100');
  if (!(s.leverage >= 1 && s.leverage <= 125)) errors.push('الرافعة يجب أن تكون بين 1 و 125');
  if (!(s.stop_loss_pct > 0 && s.stop_loss_pct <= 100)) errors.push('وقف الخسارة يجب أن يكون بين 0 و 100');
  if (!(s.take_profit_pct > 0)) errors.push('هدف الربح يجب أن يكون أكبر من 0');
  if (!(s.max_concurrent_positions >= 1 && s.max_concurrent_positions <= 20)) errors.push('عدد المراكز يجب أن يكون بين 1 و 20');
  return errors;
}

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const key = String(req.query?.key || '').trim();
    if (!ADMIN_KEY) throw new Error('BOT_ADMIN_KEY غير مُعدّ في متغيرات البيئة');
    if (!key || key !== ADMIN_KEY) throw new Error('مفتاح إداري غير صحيح');

    if (req.method === 'GET') {
      const r = await sb('bot_settings?id=eq.1&select=*');
      const settings = r.data?.[0] || null;
      res.status(200).end(JSON.stringify({ ok: true, settings }));
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const settings = {
        enabled: !!body.enabled,
        position_pct: Number(body.position_pct),
        leverage: Number(body.leverage),
        stop_loss_pct: Number(body.stop_loss_pct),
        take_profit_pct: Number(body.take_profit_pct),
        max_concurrent_positions: Number(body.max_concurrent_positions),
      };
      const errors = validateSettings(settings);
      if (errors.length) {
        res.status(400).end(JSON.stringify({ ok: false, errors }));
        return;
      }
      settings.updated_at = new Date().toISOString();
      const r = await sb('bot_settings?id=eq.1', {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify(settings),
      });
      if (!r.ok) throw new Error('فشل الحفظ في قاعدة البيانات');
      res.status(200).end(JSON.stringify({ ok: true, settings: r.data?.[0] || settings }));
      return;
    }

    res.status(405).end(JSON.stringify({ ok: false, error: 'طريقة غير مدعومة' }));
  } catch (e) {
    res.status(401).end(JSON.stringify({ ok: false, error: e.message }));
  }
};
