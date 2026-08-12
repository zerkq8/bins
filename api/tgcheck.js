module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const T = process.env.TELEGRAM_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
  if (!T || !C) {
    return res.status(200).end(JSON.stringify({
      hasToken: !!T, hasChatId: !!C, note: 'متغير ناقص — تحقق من Vercel ثم Redeploy'
    }));
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: C, text: '✅ البوت متصل بنجاح. التنبيهات جاهزة.' }),
    });
    const d = await r.json();
    res.status(200).end(JSON.stringify({ hasToken: true, hasChatId: true, sent: d.ok, error: d.description || null }));
  } catch (e) {
    res.status(200).end(JSON.stringify({ error: e.message }));
  }
};
