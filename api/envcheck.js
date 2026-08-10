module.exports = (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.status(200).end(JSON.stringify({
    hasUrl: !!process.env.SUPABASE_URL,
    hasKey: !!process.env.SUPABASE_KEY,
    urlStart: (process.env.SUPABASE_URL || '').slice(0, 20),
    keyLength: (process.env.SUPABASE_KEY || '').length
  }));
};
