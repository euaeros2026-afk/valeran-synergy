// ============================================================
// VALERAN API SERVER — Complete clean version
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const cron    = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const { processMessage, generateEveningReport, generateMorningReport, callAI } = require('./lib/valeran-core');
const { sendReportToTelegram, sendWelcomeMessage, tgSend } = require('./lib/telegram-bot');
const { enrichAllProducts } = require('./lib/scraping-engine');

const app      = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const upload   = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  const { data: partner } = await supabase.from('partner_profiles').select('*').eq('email', user.email).single();
  req.user    = user;
  req.partner = partner || { email: user.email, name: user.email.split('@')[0], role: 'partner', language: 'en' };
  next();
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', valeran: 'online', time: new Date().toISOString() }));
app.get('/health',     (req, res) => res.json({ status: 'ok' }));

app.get('/api/debug/ai', async (req, res) => {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 20, messages: [{ role: 'user', content: 'Say: VALERAN_ONLINE' }] })
    });
    const d = await r.json();
    res.json({ httpStatus: r.status, reply: d?.content?.[0]?.text || null, error: d?.error || null, keyPrefix: (process.env.ANTHROPIC_API_KEY||'').slice(0,20)+'...' });
  } catch (e) { res.json({ fetchError: e.message }); }
});

app.post('/api/chat/message', requireAuth, async (req, res) => {
  const { text, session_id } = req.body;
  if (!text) return res.status(400).json({ error: 'No message text' });
  const sid = session_id || await getActiveSessionId() || 'default';
  try {
    const result = await processMessage({ text, partnerId: req.partner?.id || null, sessionId: sid });
    res.json({ reply: result.reply || 'Message noted.', session_id: sid, responded: result.responded });
  } catch (e) {
    console.error('Chat error:', e);
    res.json({ reply: 'Something went wrong — please try again.', session_id: sid });
  }
});

app.get('/api/chat/messages', requireAuth, async (req, res) => {
  const { session_id, limit = 60 } = req.query;
  const sid = session_id || await getActiveSessionId() || 'default';
  const { data, error } = await supabase.from('chat_messages').select('*')
    .eq('session_id', sid).not('content', 'eq', '__VALERAN_WELCOME_SENT__')
    .order('created_at', { ascending: true }).limit(parseInt(limit));
  res.json(error ? { error } : { messages: data || [] });
});

app.post('/api/chat/photo', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    const session_id = req.body.session_id || await getActiveSessionId() || 'default';
    const caption    = req.body.caption || '';
    if (!req.file) return res.status(400).json({ error: 'No photo' });
    let visionLabels = [];
    try {
      const vr = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + process.env.GOOGLE_API_KEY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ image: { content: req.file.buffer.toString('base64') }, features: [{ type: 'LABEL_DETECTION', maxResults: 8 }, { type: 'WEB_DETECTION', maxResults: 5 }] }] })
      });
      const vd = await vr.json();
      const resp = vd.responses?.[0];
      visionLabels = [...(resp?.labelAnnotations?.map(l => l.description) || []), ...(resp?.webDetection?.webEntities?.map(e => e.description).filter(Boolean) || [])].slice(0,10);
    } catch (ve) { console.error('Vision error:', ve.message); }
    const valeranQuery = 'Valeran, ' + ([caption, visionLabels.length ? 'Product looks like: ' + visionLabels.join(', ') : ''].filter(Boolean).join('. ') || 'Photo from Canton Fair');
    const result = await processMessage({ text: valeranQuery, partnerId: req.partner?.id || null, sessionId: session_id, messageType: 'photo' });
    res.json({ reply: result.reply || 'Photo logged.', visionLabels, session_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat/voice', requireAuth, upload.single('audio'), async (req, res) => {
  try {
    const session_id = req.body.session_id || await getActiveSessionId() || 'default';
    if (!req.file) return res.status(400).json({ error: 'No audio' });
    let transcript = '';
    try {
      const sr = await fetch('https://speech.googleapis.com/v1/speech:recognize?key=' + process.env.GOOGLE_API_KEY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: { content: req.file.buffer.toString('base64') }, config: { encoding: 'WEBM_OPUS', sampleRateHertz: 48000, languageCode: 'en-US', alternativeLanguageCodes: ['ru-RU', 'bg-BG'] } })
      });
      const sd = await sr.json();
      transcript = sd.results?.map(r => r.alternatives[0].transcript).join(' ') || '';
    } catch (se) { console.error('Speech error:', se.message); }
    if (!transcript) return res.status(400).json({ error: 'Could not transcribe audio' });
    const result = await processMessage({ text: transcript, partnerId: req.partner?.id || null, sessionId: session_id, messageType: 'voice' });
    res.json({ reply: result.reply || 'Voice note logged.', transcript, session_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suppliers', requireAuth, async (req, res) => {
  const { search, limit = 50 } = req.query;
  let q = supabase.from('suppliers').select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
  if (search) q = q.ilike('name', '%' + search + '%');
  const { data, error } = await q;
  res.json(error ? { error } : { suppliers: data || [] });
});
app.get('/api/suppliers/:id', requireAuth, async (req, res) => {
  const { data: supplier } = await supabase.from('suppliers').select('*').eq('id', req.params.id).single();
  const { data: products  } = await supabase.from('products').select('*').eq('supplier_id', req.params.id);
  res.json({ supplier, products: products || [] });
});
app.post('/api/suppliers', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('suppliers').insert({ ...req.body, created_by: req.partner?.id }).select().single();
  res.json(error ? { error } : { supplier: data });
});
app.patch('/api/suppliers/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('suppliers').update(req.body).eq('id', req.params.id).select().single();
  res.json(error ? { error } : { supplier: data });
});

app.get('/api/products', requireAuth, async (req, res) => {
  const { category, limit = 100 } = req.query;
  let q = supabase.from('products').select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
  if (category) q = q.eq('category', category);
  const { data, error } = await q;
  res.json(error ? { error } : { products: data || [] });
});
app.post('/api/products', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('products').insert({ ...req.body, created_by: req.partner?.id }).select().single();
  res.json(error ? { error } : { product: data });
});
app.patch('/api/products/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('products').update(req.body).eq('id', req.params.id).select().single();
  res.json(error ? { error } : { product: data });
});

app.get('/api/meetings', requireAuth, async (req, res) => {
  const { date } = req.query;
  let q = supabase.from('meetings').select('*').order('scheduled_at');
  if (date) q = q.gte('scheduled_at', date).lt('scheduled_at', date + 'T23:59:59');
  const { data, error } = await q;
  res.json(error ? { error } : { meetings: data || [] });
});
app.post('/api/meetings', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('meetings').insert({ ...req.body, created_by: req.partner?.id }).select().single();
  res.json(error ? { error } : { meeting: data });
});

app.post('/api/search', requireAuth, upload.single('image'), async (req, res) => {
  const { query: q } = req.body;
  const results = { internal: [], vision_labels: [] };
  if (q) { const { data } = await supabase.from('products').select('*').ilike('name', '%' + q + '%').limit(10); results.internal = data || []; }
  res.json(results);
});

app.get('/api/categories', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('categories').select('*').order('name');
  res.json(error ? { error } : { categories: data || [] });
});

app.get('/api/reports', requireAuth, async (req, res) => {
  const { type } = req.query;
  let q = supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(20);
  if (type) q = q.eq('type', type);
  const { data, error } = await q;
  res.json(error ? { error } : { reports: data || [] });
});

app.post('/api/reports/generate', requireAuth, async (req, res) => {
  const { type, session_id, date } = req.body;
  const sid = session_id || await getActiveSessionId();
  const d   = date || new Date().toISOString().split('T')[0];
  if (!sid) return res.status(400).json({ error: 'No active fair session' });
  try {
    const report = type === 'evening' ? await generateEveningReport(sid, d) : await generateMorningReport(sid, d);
    await sendReportToTelegram(report);
    res.json({ report });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/welcome', requireAuth, async (req, res) => {
  const result = await sendWelcomeMessage();
  res.json(result);
});

app.get('/api/partners', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('partner_profiles').select('id, name, role, at_fair, language, email');
  res.json(error ? { error } : { partners: data || [] });
});

app.post('/api/telegram/webhook', async (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const msg = req.body?.message || req.body?.channel_post;
      if (!msg?.text) return;
      const text = msg.text.trim();
      const isAddressed = /^valeran[,\s]/i.test(text) || /^valeran$/i.test(text) || /^valera[,\s]/i.test(text) || /^валеран/i.test(text) || /^валера/i.test(text);
      if (!isAddressed) return;
      const query  = text.replace(/^(valeran|valera|валеран|валера)[,\s]*/i, '').trim() || 'Hello';
      const from   = msg.from?.first_name || 'Partner';
      const chatId = msg.chat.id;
      const sid    = await getActiveSessionId() || 'default';
      const system = 'You are Valeran, the AI assistant for Synergy Ventures at Canton Fair 2026. Responding to ' + from + ' in the team Telegram group. Be concise and practical. Max 250 words. Detect the language and respond in the SAME language (English, Russian, or Bulgarian). Help with product research, margin calculations, supplier info, or anything else.';
      const reply = await callAI([{ role: 'user', content: query }], system, 500, 20000);
      if (!reply) return;
      await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: '🤖 ' + reply, reply_to_message_id: msg.message_id, parse_mode: 'Markdown' })
      });
      await supabase.from('chat_messages').insert([
        { session_id: sid, role: 'user',      content: query, partner_id: null },
        { session_id: sid, role: 'assistant', content: reply, partner_id: null }
      ]);
    } catch (e) { console.error('TG webhook error:', e.message); }
  });
});

cron.schedule('30 13 * * *', async () => {
  const sid = await getActiveSessionId(); if (!sid) return;
  const date = new Date().toISOString().split('T')[0];
  const report = await generateEveningReport(sid, date);
  await sendReportToTelegram(report);
  enrichAllProducts(sid).catch(console.error);
});

cron.schedule('0 23 * * *', async () => {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const date = tomorrow.toISOString().split('T')[0];
  const sid  = await getActiveSessionId(date); if (!sid) return;
  const report = await generateMorningReport(sid, date);
  await sendReportToTelegram(report);
});

async function getActiveSessionId(date) {
  const d = date || new Date().toISOString().split('T')[0];
  const { data } = await supabase.from('fair_sessions').select('id').lte('start_date', d).gte('end_date', d).single();
  return data?.id || null;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Valeran API on port ' + PORT));
module.exports = app;
