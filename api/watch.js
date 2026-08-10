const { getWatch, jsonHandler } = require('../lib/binance');
const { listIds, addId, removeId, purge } = require('../lib/watchdb');

/** يقرأ جسم الطلب في دوال Vercel */
async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const key = String(req.query?.key || '').trim();
    if (!key || key.length < 4) throw new Error('المفتاح الشخصي مفقود أو قصير.');

    let saved;
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body.purge === true) {
        const r = await purge(key);
        return res.status(200).end(JSON.stringify({ purged: true, deleted: r.deleted, ids: [], traders: [], missing: [] }));
      }
      if (body.remove) saved = await removeId(key, body.remove);
      else if (body.add) saved = await addId(key, body.add, body.nickname);
      else saved = await listIds(key);
    } else {
      saved = await listIds(key);
    }

    if (!saved.length) {
      return res.status(200).end(JSON.stringify({ ids: [], traders: [], missing: [] }));
    }

    const data = await getWatch(saved.map((s) => s.id));
    res.status(200).end(JSON.stringify({
      ids: saved.map((s) => s.id),
      traders: data.traders,
      missing: data.missing,
      savedNames: Object.fromEntries(saved.map((s) => [s.id, s.nickname])),
      fetchedAt: Date.now(),
    }));
  } catch (e) {
    res.status(500).end(JSON.stringify({ error: e.message }));
  }
};
