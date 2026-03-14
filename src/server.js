// ============================================================
// VALERAN API SERVER
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { processMessage, generateEveningReport, generateMorningReport } = require('./lib/valeran-core');
const { enrichAllProducts } = require('./lib/scraping-engine');
const { sendReportToTelegram } = require('./lib/telegram-bot');
const multer = require('multer');
const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const vision = require('@google-cloud/vision');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const visionClient = new vision.ImageAnnotatorClient();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// ============================================================
// AUTH MIDDLEWARE (verify Supabase JWT)
// ============================================================
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const { data: partner } = await supabase.from('partner_profiles').select('*').eq('email', user.email).single();
  req.user = user;
  req.partner = partner || { email: user.email, name: user.email, role: 'partner', language: 'en' };
  next();
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', valeran: 'online' }));

// ============================================================
// CHAT: SEND MESSAGE TO VALERAN
// ============================================================
app.post('/api/chat/message', requireAuth, async (req, res) => {
  const { text, session_id } = req.body;
  if (!text) return res.status(400).json({ error: 'No message text' });

  const session = session_id || await getActiveSessionId();

  const result = await processMessage({
    text,
    partnerId: req.partner.id,
    sessionId: session
  });

  res.json(result);
});

// ============================================================
// CHAT: UPLOAD PHOTO
// ============================================================
app.post('/api/chat/photo', requireAuth, upload.single('photo'), async (req, res) => {
  const caption = req.body.caption || '';
  const session_id = req.body.session_id || await getActiveSessionId();

  // Upload to Google Drive
  const photoUrl = await uploadToGoogleDrive(req.file.buffer, req.file.originalname || 'photo.jpg');

  // Run Vision AI on the photo
  const [visionResult] = await visionClient.labelDetection({ image: { content: req.file.buffer } });
  const labels = visionResult.labelAnnotations?.map(l => l.description).slice(0, 8) || [];

  // Also run web detection for product matching
  const [webResult] = await visionClient.webDetection({ image: { content: req.file.buffer } });
  const webEntities = webResult.webDetection?.webEntities?.slice(0, 5) || [];

  const enrichedCaption = caption + (labels.length ? ` [Vision: ${labels.join(', ')}]` : '');

  const result = await processMessage({
    text: enrichedCaption,
    partnerId: req.partner.id,
    sessionId: session_id,
    messageType: 'photo',
    mediaUrl: photoUrl
  });

  res.json({ ...result, photoUrl, visionLabels: labels, webEntities });
});

// ============================================================
// CHAT: UPLOAD VOICE
// ============================================================
app.post('/api/chat/voice', requireAuth, upload.single('audio'), async (req, res) => {
  const session_id = req.body.session_id || await getActiveSessionId();

  // Transcribe via Google Speech
  const speech = require('@google-cloud/speech');
  const speechClient = new speech.SpeechClient();

  const [transcriptionResult] = await speechClient.recognize({
    audio: { content: req.file.buffer.toString('base64') },
    config: {
      encoding: 'WEBM_OPUS',
      sampleRateHertz: 48000,
      languageCode: 'en-US',
      alternativeLanguageCodes: ['ru-RU', 'bg-BG']
    }
  });

  const transcript = transcriptionResult.results?.map(r => r.alternatives[0].transcript).join(' ');

  if (!transcript) return res.status(400).json({ error: 'Could not transcribe audio' });

  const result = await processMessage({
    text: transcript,
    partnerId: req.partner.id,
    sessionId: session_id,
    messageType: 'voice'
  });

  res.json({ ...result, transcript });
});

// ============================================================
// CHAT: GET MESSAGE HISTORY
// ============================================================
app.get('/api/chat/messages', requireAuth, async (req, res) => {
  const { session_id, limit = 50, before } = req.query;
  const sid = session_id || await getActiveSessionId();

  let query = supabase
    .from('messages')
    .select('*, partners(full_name, display_name, avatar_url)')
    .eq('fair_session_id', sid)
    .order('created_at', { ascending: false })
    .limit(parseInt(limit));

  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  res.json(error ? { error } : { messages: data?.reverse() });
});

// ============================================================
// SUPPLIERS
// ============================================================
app.get('/api/suppliers', requireAuth, async (req, res) => {
  const { session_id, search, limit = 50 } = req.query;
  const sid = session_id || await getActiveSessionId();

  let query = supabase
    .from('suppliers')
    .select('*, products(count)')
    .order('overall_supplier_score', { ascending: false })
    .limit(parseInt(limit));

  if (sid) query = query.eq('fair_session_id', sid);
  if (search) query = query.ilike('company_name', `%${search}%`);

  const { data, error } = await query;
  res.json(error ? { error } : { suppliers: data });
});

app.get('/api/suppliers/:id', requireAuth, async (req, res) => {
  const { data: supplier } = await supabase.from('suppliers').select('*').eq('id', req.params.id).single();
  const { data: products } = await supabase.from('products').select('*').eq('supplier_id', req.params.id).order('total_score', { ascending: false });
  const { data: meetings } = await supabase.from('meetings').select('*').eq('supplier_id', req.params.id);
  res.json({ supplier, products, meetings });
});

app.post('/api/suppliers', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('suppliers').insert({ ...req.body, logged_by: req.partner.id }).select().single();
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
  const { session_id, status, category, limit = 100 } = req.query;
  const sid = session_id || await getActiveSessionId();

  let query = supabase
    .from('products')
    .select('*, suppliers(company_name, hall, booth_number), categories(name)')
    .order('total_score', { ascending: false })
    .limit(parseInt(limit));

  if (sid) query = query.eq('fair_session_id', sid);
  if (status) query = query.eq('status', status);
  if (category) query = query.eq('category_auto', category);

  const { data, error } = await query;
  res.json(error ? { error } : { products: data });
});

app.post('/api/products', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('products').insert({ ...req.body, logged_by: req.partner.id }).select().single();
  res.json(error ? { error } : { product: data });
});

app.patch('/api/products/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('products').update(req.body).eq('id', req.params.id).select().single();
  res.json(error ? { error } : { product: data });
});

// ============================================================
// PRODUCT SEARCH (text + image)
// ============================================================
app.post('/api/search', requireAuth, upload.single('image'), async (req, res) => {
  const { query: textQuery } = req.body;
  const results = { eu: [], china: [], internal: [] };

  // Search internal DB first
  if (textQuery) {
    const { data: internal } = await supabase
      .from('products')
      .select('*, suppliers(company_name)')
      .textSearch('product_name', textQuery)
      .limit(5);
    results.internal = internal || [];
  }

  // If image provided, run Vision AI
  if (req.file) {
    const [webDetection] = await visionClient.webDetection({ image: { content: req.file.buffer } });
    const entities = webDetection.webDetection?.webEntities?.slice(0, 5).map(e => e.description) || [];
    const combined = [textQuery, ...entities].filter(Boolean).join(' ');

    // Trigger background enrichment search
    results.vision_labels = entities;
    results.search_query_used = combined;
  }

  res.json(results);
});

// ============================================================
// SCHEDULE / MEETINGS
// ============================================================
app.get('/api/meetings', requireAuth, async (req, res) => {
  const { date } = req.query;
  let query = supabase.from('meetings').select('*, suppliers(company_name, hall, booth_number)').order('meeting_date').order('meeting_time');
  if (date) query = query.eq('meeting_date', date);
  const { data, error } = await query;
  res.json(error ? { error } : { meetings: data });
});

app.post('/api/meetings', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('meetings').insert({ ...req.body, created_by: req.partner.id }).select().single();
  res.json(error ? { error } : { meeting: data });
});

// ============================================================
// REPORTS
// ============================================================
app.get('/api/reports', requireAuth, async (req, res) => {
  const { type, session_id } = req.query;
  let query = supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(20);
  if (type) query = query.eq('report_type', type);
  if (session_id) query = query.eq('fair_session_id', session_id);
  const { data, error } = await query;
  res.json(error ? { error } : { reports: data });
});

// Manual trigger for testing
app.post('/api/reports/generate', requireAuth, async (req, res) => {
  const { type, session_id, date } = req.body;
  const sid = session_id || await getActiveSessionId();
  const d = date || new Date().toISOString().split('T')[0];

  let report;
  if (type === 'evening') report = await generateEveningReport(sid, d);
  else if (type === 'morning') report = await generateMorningReport(sid, d);
  else return res.status(400).json({ error: 'Invalid report type' });

  await sendReportToTelegram(report);
  res.json({ report });
});

// ============================================================
// CATEGORIES
// ============================================================
app.get('/api/categories', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('categories').select('*').order('name');
  res.json(error ? { error } : { categories: data });
});

// ============================================================
// CRON JOBS (auto reports + scraping)
// ============================================================

// Evening report: 21:30 China time (UTC+8) = 13:30 UTC
cron.schedule('30 13 * * *', async () => {
  const sid = await getActiveSessionId();
  if (!sid) return;
  const date = new Date().toISOString().split('T')[0];
  console.log('Generating evening report...');
  const report = await generateEveningReport(sid, date);
  await sendReportToTelegram(report);

  // Start overnight scraping
  console.log('Starting overnight product enrichment...');
  enrichAllProducts(sid).catch(console.error);
});

// Morning report: 07:00 China time = 23:00 UTC previous day
cron.schedule('0 23 * * *', async () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const date = tomorrow.toISOString().split('T')[0];
  const sid = await getActiveSessionId(date);
  if (!sid) return;
  console.log('Generating morning report...');
  const report = await generateMorningReport(sid, date);
  await sendReportToTelegram(report);
});

// ============================================================
// GOOGLE DRIVE UPLOAD
// ============================================================
async function uploadToGoogleDrive(buffer, filename) {
  const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  const drive = google.drive({ version: 'v3', auth });
  const { Readable } = require('stream');

  const { data: file } = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
    },
    media: {
      mimeType: 'image/jpeg',
      body: Readable.from(buffer)
    },
    fields: 'id, webViewLink'
  });

  await drive.permissions.create({
    fileId: file.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return file.webViewLink;
}

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
  return data?.id;
}


// ============================================================
// TELEGRAM WEBHOOK Ã¢ÂÂ receive messages from group
// ============================================================
app.post('/api/telegram/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body.message || req.body.channel_post;
    if (!msg || !msg.text) return;
    const text = msg.text.trim();
    if (!/^valeran[,\s]/i.test(text) && !/^valeran$/i.test(text)) return;
    const query = text.replace(/^valeran[,\s]*/i, '').trim() || 'Hello';
    const from = msg.from?.first_name || 'Partner';
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: `You are Valeran, the AI field intelligence assistant for Synergy Ventures at Canton Fair 2026. You help the team source products, calculate margins, research suppliers, and act as a personal assistant.\n\nYou are responding in the team Telegram group to ${from}.\nBe concise and practical. Use bullet points for lists. Max 300 words unless a detailed report is requested.\nDetect the language of the query and respond in the same language (English, Russian or Bulgarian).\n\nMessage: ${query}` }]
      })
    });
    const response = await aiResp.json();
    await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: 'Ã°ÂÂ¤Â ' + response.content[0].text,
        reply_to_message_id: msg.message_id
      })
    });
  } catch(e) { console.error('TG webhook error:', e); }
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Valeran API running on port ${PORT}`));
module.exports = app;
