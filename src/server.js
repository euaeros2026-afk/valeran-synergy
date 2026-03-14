// ============================================================
// VALERAN API SERVER â Fixed version
// Fixes applied:
//   1. Chat handler: removed unawaited IIFE â now properly awaited
//   2. Removed google-cloud imports (need service account JSON, breaks cold start)
//   3. Telegram webhook: respond 200 immediately, async AI in background
//   4. Telegram webhook uses Haiku (fast) not Sonnet (slow)
//   5. No sendReportToTelegram in chat handler
//   6. Added /api/welcome endpoint (one-time manual trigger)
//   7. Vision/Speech routes safely wrapped
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const cron    = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const { processMessage, generateEveningReport, generateMorningReport, callAI } = require('./lib/valeran-core');
const { sendReportToTelegram, sendWelcomeMessage, sendTelegramReply } = require('./lib/telegram-bot');
const { enrichAllProducts } = require('./lib/scraping-engine');

const app     = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const upload  = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: partner } = await supabase
    .from('partner_profiles')
    .select('*')
    .eq('email', user.email)
    .single();

  req.user    = user;
  req.partner = partner || { email: user.email, name: user.email, role: 'partner', language: 'en' };
  next();
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/api/health', (req, res) => res.json({ status: 'ok', valeran: 'online', time: new Date().toISOString() }));
app.get('/health',     (req, res) => res.json({ status: 'ok' }));

// ============================================================
// CHAT: SEND MESSAGE â FIXED (was unawaited IIFE causing 504)
// ============================================================
app.post('/api/chat/message', requireAuth, async (req, res) => {
  const { text, session_id } = req.body;
  if (!text) return res.status(400).json({ error: 'No message text' });

  const sid = session_id || await getActiveSessionId() || 'default';

  try {
    const result = await processMessage({
      text,
      partnerId:   req.partner?.id || null,
      sessionId:   sid,
      messageType: 'text'
    });

    const reply = result.reply || 'Got it â message noted.';
    res.json({ reply, session_id: sid });

  } catch (e) {
    console.error('Chat error:', e);
    if (e.name === 'AbortError') {
      return res.json({ reply: 'Taking longer than expected â please try again.', session_id: sid });
    }
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// CHAT: UPLOAD PHOTO
// ============================================================
app.post('/api/chat/photo', requireAuth, upload.single('photo'), async (req, res) => {
  try {
    const caption    = req.body.caption || '';
    const session_id = req.body.session_id || await getActiveSessionId() || 'default';

    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });

    // Use Google Vision REST API (no service account needed â just API key)
    let visionLabels = [];
    try {
      const GKEY = process.env.GOOGLE_API_KEY;
      const imgB64 = req.file.buffer.toString('base64');
      const vr = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${GKEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: imgB64 },
            features: [
              { type: 'LABEL_DETECTION', maxResults: 8 },
              { type: 'WEB_DETECTION', maxResults: 5 }
            ]
          }]
        })
      });
      const vd = await vr.json();
      const resp = vd.responses?.[0];
      visionLabels = resp?.labelAnnotations?.map(l => l.description) || [];
      const webEntities = resp?.webDetection?.webEntities?.map(e => e.description).filter(Boolean) || [];
      visionLabels = [...new Set([...visionLabels, ...webEntities])].slice(0, 10);
    } catch (ve) {
      console.error('Vision API error (non-fatal):', ve.message);
    }

    const enrichedText = [caption, visionLabels.length ? 'Product looks like: ' + visionLabels.join(', ') : ''].filter(Boolean).join(' | ');

    const result = await processMessage({
      text:        enrichedText || 'Photo submitted from Canton Fair',
      partnerId:   req.partner?.id || null,
      sessionId:   session_id,
      messageType: 'photo'
    });

    res.json({ reply: result.reply || 'Photo received and logged.', visionLabels, session_id });
  } catch (e) {
    console.error('Photo error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// CHAT: VOICE NOTE
// ============================================================
app.post('/api/chat/voice', requireAuth, upload.single('audio'), async (req, res) => {
  try {
    const session_id = req.body.session_id || await getActiveSessionId() || 'default';
    if (!req.file) return res.status(400).json({ error: 'No audio uploaded' });

    // Google Speech-to-Text REST API
    let transcript = '';
    try {
      const GKEY = process.env.GOOGLE_API_KEY;
      const sr = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${GKEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio: { content: req.file.buffer.toString('base64') },
          config: {
            encoding: 'WEBM_OPUS',
            sampleRateHertz: 48000,
            languageCode: 'en-US',
            alternativeLanguageCodes: ['ru-RU', 'bg-BG']
          }
        })
      });
      const sd = await sr.json();
      transcript = sd.results?.map(r => r.alternatives[0].transcript).join(' ') || '';
    } catch (se) {
      console.error('Speech API error:', se.message);
    }

    if (!transcript) return res.status(400).json({ error: 'Could not transcribe audio' });

    const result = await processMessage({
      text:        transcript,
      partnerId:   req.partner?.id || null,
      sessionId:   session_id,
      messageType: 'voice'
    });

    res.json({ reply: result.reply || 'Voice note logged.', transcript, session_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// CHAT: GET MESSAGE HISTORY
// ============================================================
app.get('/api/chat/messages', requireAuth, async (req, res) => {
  const { session_id, limit = 50 } = req.query;
  const sid = session_id || await getActiveSessionId() || 'default';

  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('session_id', sid)
    .neq('content', '__VALERAN_WELCOME_SENT__')
    .order('created_at', { ascending: true })
    .limit(parseInt(limit));

  res.json(error ? { error } : { messages: data || [] });
});

// ============================================================
// SUPPLIERS
// ============================================================
app.get('/api/suppliers', requireAuth, async (req, res) => {
  const { search, limit = 50 } = req.query;
  let query = supabase.from('suppliers').select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
  if (search) query = query.ilike('name', `%${search}%`);
  const { data, error } = await query;
  res.json(error ? { error } : { suppliers: data || [] });
});

app.get('/api/suppliers/:id', requireAuth, async (req, res) => {
  const { data: supplier } = await supabase.from('suppliers').select('*').eq('id', req.params.id).single();
  const { data: products  } = await supabase.from('products').select('*').eq('supplier_id', req.params.id);
  const { data: meetings  } = await supabase.from('meetings').select('*').eq('supplier_id', req.params.id);
  res.json({ supplier, products: products || [], meetings: meetings || [] });
});

app.post('/api/suppliers', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('suppliers')
    .insert({ ...req.body, created_by: req.partner?.id }).select().single();
  res.json(error ? { error } : { supplier: data });
});

app.patch('/api/suppliers/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('suppliers').update(req.body).eq('id', req.params.id).select().single();
  res.json(error ? { error } : { supplier: data });
});

// ============================================================
// PRODUCTS
// ============================================================
app.get('/api/products', requireAuth, async (req, res) => {
  const { category, limit = 100 } = req.query;
  let query = supabase.from('products').select('*, suppliers(name, hall, booth_number)')
    .order('created_at', { ascending: false }).limit(parseInt(limit));
  if (category) query = query.eq('category', category);
  const { data, error } = await query;
  res.json(error ? { error } : { products: data || [] });
});

app.post('/api/products', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('products')
    .insert({ ...req.body, created_by: req.partner?.id }).select().single();
  res.json(error ? { error } : { product: data });
});

app.patch('/api/products/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('products').update(req.body).eq('id', req.params.id).select().single();
  res.json(error ? { error } : { product: data });
});

// ============================================================
// MEETINGS / SCHEDULE
// ============================================================
app.get('/api/meetings', requireAuth, async (req, res) => {
  const { date } = req.query;
  let query = supabase.from('meetings').select('*, suppliers(name, hall, booth_number)').order('scheduled_at');
  if (date) query = query.gte('scheduled_at', date).lt('scheduled_at', date + 'T23:59:59');
  const { data, error } = await query;
  res.json(error ? { error } : { meetings: data || [] });
});

app.post('/api/meetings', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('meetings')
    .insert({ ...req.body, created_by: req.partner?.id }).select().single();
  res.json(error ? { error } : { meeting: data });
});

// ============================================================
// SEARCH (text + image)
// ============================================================
app.post('/api/search', requireAuth, upload.single('image'), async (req, res) => {
  const { query: textQuery } = req.body;
  const results = { internal: [], vision_labels: [] };

  if (textQuery) {
    const { data } = await supabase.from('products').select('*, suppliers(name)')
      .ilike('name', `%${textQuery}%`).limit(10);
    results.internal = data || [];
  }

  if (req.file) {
    try {
      const GKEY = process.env.GOOGLE_API_KEY;
      const vr = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${GKEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{ image: { content: req.file.buffer.toString('base64') }, features: [{ type: 'WEB_DETECTION', maxResults: 8 }] }]
        })
      });
      const vd = await vr.json();
      results.vision_labels = vd.responses?.[0]?.webDetection?.webEntities?.map(e => e.description).filter(Boolean) || [];
    } catch (e) { console.error('Vision search error:', e.message); }
  }

  res.json(results);
});

// ============================================================
// CATEGORIES
// ============================================================
app.get('/api/categories', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('categories').select('*').order('name');
  res.json(error ? { error } : { categories: data || [] });
});

// ============================================================
// REPORTS
// ============================================================
app.get('/api/reports', requireAuth, async (req, res) => {
  const { type } = req.query;
  let query = supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(20);
  if (type) query = query.eq('type', type);
  const { data, error } = await query;
  res.json(error ? { error } : { reports: data || [] });
});

app.post('/api/reports/generate', requireAuth, async (req, res) => {
  const { type, session_id, date } = req.body;
  const sid = session_id || await getActiveSessionId();
  const d   = date || new Date().toISOString().split('T')[0];

  if (!sid) return res.status(400).json({ error: 'No active fair session' });

  try {
    let report;
    if (type === 'evening')      report = await generateEveningReport(sid, d);
    else if (type === 'morning') report = await generateMorningReport(sid, d);
    else return res.status(400).json({ error: 'type must be evening or morning' });

    await sendReportToTelegram(report);
    res.json({ report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// WELCOME â one-time manual trigger (NOT called automatically)
// ============================================================
app.post('/api/welcome', requireAuth, async (req, res) => {
  const result = await sendWelcomeMessage();
  res.json(result);
});

// ============================================================
// PARTNER PROFILES
// ============================================================
app.get('/api/partners', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('partner_profiles').select('id, name, role, at_fair, language, email');
  res.json(error ? { error } : { partners: data || [] });
});

// ============================================================
// TELEGRAM WEBHOOK â Fixed:
//   1. res.sendStatus(200) FIRST (Telegram needs response in <5s)
//   2. AI call is fully async after 200 is sent
//   3. Uses Haiku (fast) â Sonnet would always timeout
// ============================================================
app.post('/api/telegram/webhook', async (req, res) => {
  // Respond to Telegram immediately â must be < 5s
  res.sendStatus(200);

  // Process async â Telegram doesn't wait for this
  setImmediate(async () => {
    try {
      const msg = req.body?.message || req.body?.channel_post;
      if (!msg?.text) return;

      const text = msg.text.trim();
      if (!/^valeran[,\s]/i.test(text) && !/^valeran$/i.test(text)) return;

      const query = text.replace(/^valeran[,\s]*/i, '').trim() || 'Hello';
      const from  = msg.from?.first_name || 'Partner';

      const system = `You are Valeran, the AI assistant for Synergy Ventures at Canton Fair 2026. Respond to ${from} in the team Telegram group. Be concise and practical. Max 250 words. Detect language and reply in same language (English, Russian or Bulgarian).`;

      const aiReply = await callAI(
        [{ role: 'user', content: query }],
        system,
        500,
        20000
      );

      if (!aiReply) return;

      await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.chat.id,
          text: 'ð¤ ' + aiReply,
          reply_to_message_id: msg.message_id,
          parse_mode: 'Markdown'
        })
      });

      // Save to chat history
      const sid = await getActiveSessionId() || 'default';
      await supabase.from('chat_messages').insert([
        { session_id: sid, role: 'user',      content: query,     partner_id: null },
        { session_id: sid, role: 'assistant', content: aiReply,   partner_id: null }
      ]);

    } catch (e) {
      console.error('TG webhook async error:', e.message);
    }
  });
});

// ============================================================
// CRON JOBS (auto reports)
// ============================================================
// Evening report: 21:30 China time (UTC+8) = 13:30 UTC
cron.schedule('30 13 * * *', async () => {
  const sid = await getActiveSessionId();
  if (!sid) return;
  const date = new Date().toISOString().split('T')[0];
  console.log('ð Generating evening report...');
  const report = await generateEveningReport(sid, date);
  await sendReportToTelegram(report);
  // Background enrichment
  enrichAllProducts(sid).catch(console.error);
});

// Morning report: 07:00 China time = 23:00 UTC previous day
cron.schedule('0 23 * * *', async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = tomorrow.toISOString().split('T')[0];
  const sid  = await getActiveSessionId(date);
  if (!sid) return;
  console.log('ð Generating morning report...');
  const report = await generateMorningReport(sid, date);
  await sendReportToTelegram(report);
});

// ============================================================
// HELPERS
// ============================================================
async function getActiveSessionId(date) {
  const d = date || new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('fair_sessions')
    .select('id')
    .lte('start_date', d)
    .gte('end_date', d)
    .single();
  return data?.id || null;
}


// ============================================================
// DEBUG — temporary endpoint to diagnose Anthropic connectivity
// ============================================================
app.get('/api/debug/ai', async (req, res) => {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{ role: 'user', content: 'Say: VALERAN_OK' }]
      })
    });
    const data = await r.json();
    res.json({
      httpStatus: r.status,
      hasContent: !!(data?.content?.[0]?.text),
      reply: data?.content?.[0]?.text || null,
      error: data?.error || null,
      keyPrefix: (process.env.ANTHROPIC_API_KEY || '').slice(0, 20) + '...',
      model: 'claude-haiku-4-5-20251001'
    });
  } catch (e) {
    res.json({ fetchError: e.message, stack: e.stack?.slice(0,300) });
  }
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`â Valeran API running on port ${PORT}`));

module.exports = app;
