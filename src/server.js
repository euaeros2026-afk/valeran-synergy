require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const cron    = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { processMessage, generateEveningReport, generateMorningReport, isValeranCalled, callAI, saveMessage, loadMemory, saveCorrection, analyseCatalogue } = require('./lib/valeran-core');
const { sendReportToTelegram, sendWelcomeMessage } = require('./lib/telegram-bot');
const { enrichAllProducts, researchProduct } = require('./lib/scraping-engine');

const app      = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const upload   = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

async function requireAuth(req, res, next) {
  var token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  var auth = await supabase.auth.getUser(token);
  if (auth.error || !auth.data.user) return res.status(401).json({ error: 'Invalid token' });
  var p = await supabase.from('partner_profiles').select('*').eq('email', auth.data.user.email).single();
  req.user    = auth.data.user;
  req.partner = p.data || { email: auth.data.user.email, name: auth.data.user.email.split('@')[0], role: 'partner', language: 'en' };
  next();
}

app.get('/api/health', function(req, res) { res.json({ status: 'ok', valeran: 'online', time: new Date().toISOString() }); });
app.get('/health', function(req, res) { res.json({ status: 'ok' }); });
app.get('/api/debug/ai', async function(req, res) {
  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 20, messages: [{ role: 'user', content: 'Say ONLINE' }] }) });
    var d = await r.json();
    res.json({ status: r.status, reply: d.content && d.content[0] && d.content[0].text, keyPrefix: (process.env.ANTHROPIC_API_KEY||'').slice(0,20)+'...' });
  } catch(e) { res.json({ error: e.message }); }
});

// ============================================================
// CHAT
// ============================================================
app.post('/api/chat/message', requireAuth, async function(req, res) {
  if (!req.body.text) return res.status(400).json({ error: 'No text' });
  var sid = req.body.session_id || await getActiveSessionId() || 'default';
  try {
    var result = await processMessage({ text: req.body.text, partnerId: req.partner && req.partner.id, sessionId: sid });
    res.json({ reply: result.reply || 'Message noted.', session_id: sid, responded: result.responded });
  } catch(e) { res.json({ reply: 'Error â try again.', session_id: sid }); }
});

app.get('/api/chat/messages', requireAuth, async function(req, res) {
  var sid = req.query.session_id || await getActiveSessionId() || 'default';
  var limit = parseInt(req.query.limit) || 60;
  var r = await supabase.from('chat_messages').select('*').eq('session_id', sid)
    .not('content', 'ilike', '__VALERAN_%').order('created_at', { ascending: true }).limit(limit);
  res.json(r.error ? { error: r.error } : { messages: r.data || [] });
});

// ============================================================
// CORRECTION / FEEDBACK â team points out mistakes
// ============================================================
app.post('/api/correct', requireAuth, async function(req, res) {
  var { correction, subject } = req.body;
  if (!correction) return res.status(400).json({ error: 'No correction text' });
  await saveCorrection(correction, req.partner && req.partner.id, subject || 'user_correction');
  res.json({ saved: true, message: 'Correction saved. Valeran will remember this.' });
});

app.get('/api/memory', requireAuth, async function(req, res) {
  var r = await supabase.from('valeran_memory').select('*').eq('active', true).order('created_at', { ascending: false }).limit(50);
  res.json(r.error ? { error: r.error } : { memory: r.data || [] });
});

// ============================================================
// CATALOGUE UPLOAD â PDF/text catalogue analysis
// ============================================================
app.post('/api/catalogue/upload', requireAuth, upload.single('file'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    var sid = req.body.session_id || await getActiveSessionId() || 'default';
    var supplierId = req.body.supplier_id || null;
    var filename = req.file.originalname || 'catalogue.pdf';

    // Create upload record
    var uploadR = await supabase.from('catalogue_uploads').insert({
      filename: filename, supplier_id: supplierId, session_id: sid,
      uploaded_by: req.partner && req.partner.id, analysis_status: 'processing'
    }).select().single();
    var uploadId = uploadR.data && uploadR.data.id;

    // Extract text content from file
    var fileText = '';
    var mimeType = req.file.mimetype || '';
    if (mimeType.includes('text') || filename.endsWith('.txt') || filename.endsWith('.csv')) {
      fileText = req.file.buffer.toString('utf-8');
    } else {
      // For PDFs and other formats, use what text we can extract
      fileText = req.file.buffer.toString('utf-8').replace(/[^\x20-\x7E\n]/g, ' ').replace(/\s+/g, ' ');
      if (fileText.trim().length < 50) {
        // Try treating as Latin-1
        fileText = req.file.buffer.toString('latin1').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');
      }
    }

    if (fileText.trim().length < 20) {
      await supabase.from('catalogue_uploads').update({ analysis_status: 'failed', summary: 'Could not extract text from file. Please upload a text-based PDF or .txt file.' }).eq('id', uploadId);
      return res.json({ success: false, message: 'Could not extract text. Please use a text-based PDF or TXT file.' });
    }

    // Run async analysis (don't block response)
    res.json({ success: true, uploadId: uploadId, filename: filename, message: 'Analysing catalogue... Results will appear in the Suppliers section shortly.' });

    // Analyse in background
    analyseCatalogue(fileText, supplierId, sid, uploadId).catch(function(e){
      console.error('[catalogue] analysis error:', e.message);
      supabase.from('catalogue_uploads').update({ analysis_status: 'failed' }).eq('id', uploadId);
    });

  } catch(e) {
    console.error('[catalogue] upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/catalogue/uploads', requireAuth, async function(req, res) {
  var r = await supabase.from('catalogue_uploads').select('*').order('created_at', { ascending: false }).limit(20);
  res.json(r.error ? { error: r.error } : { uploads: r.data || [] });
});

// ============================================================
// RESEARCH â trigger ScraperAPI search
// ============================================================
app.post('/api/research', requireAuth, async function(req, res) {
  var { query, product_id } = req.body;
  if (!query) return res.status(400).json({ error: 'No query' });
  res.json({ message: 'Research started for: ' + query + '. Results will appear in Reports shortly.' });
  researchProduct(query, product_id || null).catch(console.error);
});

app.get('/api/research/results', requireAuth, async function(req, res) {
  var q = supabase.from('product_research').select('*').order('created_at', { ascending: false }).limit(50);
  if (req.query.product_id) q = q.eq('product_id', req.query.product_id);
  if (req.query.platform) q = q.eq('platform', req.query.platform);
  var r = await q;
  res.json(r.error ? { error: r.error } : { results: r.data || [] });
});

// ============================================================
// CHAT: PHOTO
// ============================================================
app.post('/api/chat/photo', requireAuth, upload.single('photo'), async function(req, res) {
  try {
    var sid = req.body.session_id || await getActiveSessionId() || 'default';
    if (!req.file) return res.status(400).json({ error: 'No photo' });
    var labels = [];
    try {
      var vr = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + process.env.GOOGLE_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ image: { content: req.file.buffer.toString('base64') }, features: [{ type: 'LABEL_DETECTION', maxResults: 8 }, { type: 'WEB_DETECTION', maxResults: 5 }] }] }) });
      var vd = await vr.json();
      var resp = vd.responses && vd.responses[0];
      labels = [].concat(
        resp && resp.labelAnnotations ? resp.labelAnnotations.map(function(l){return l.description;}) : [],
        resp && resp.webDetection && resp.webDetection.webEntities ? resp.webDetection.webEntities.map(function(e){return e.description;}).filter(Boolean) : []
      ).slice(0,10);
    } catch(e) { console.error('[vision]', e.message); }
    var q = 'Valeran, ' + ([req.body.caption, labels.length ? 'Product identified: ' + labels.join(', ') : ''].filter(Boolean).join('. ') || 'Photo from Canton Fair â please analyse');
    var result = await processMessage({ text: q, partnerId: req.partner && req.partner.id, sessionId: sid, messageType: 'photo' });
    res.json({ reply: result.reply || 'Photo analysed and logged.', visionLabels: labels, session_id: sid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// CHAT: VOICE
// ============================================================
app.post('/api/chat/voice', requireAuth, upload.single('audio'), async function(req, res) {
  try {
    var sid = req.body.session_id || await getActiveSessionId() || 'default';
    if (!req.file) return res.status(400).json({ error: 'No audio' });
    var transcript = '';
    try {
      var sr = await fetch('https://speech.googleapis.com/v1/speech:recognize?key=' + process.env.GOOGLE_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: { content: req.file.buffer.toString('base64') }, config: { encoding: 'WEBM_OPUS', sampleRateHertz: 48000, languageCode: 'en-US', alternativeLanguageCodes: ['ru-RU','bg-BG'] } }) });
      var sd = await sr.json();
      transcript = (sd.results||[]).map(function(r){return r.alternatives[0].transcript;}).join(' ');
    } catch(e) {}
    if (!transcript) return res.status(400).json({ error: 'No transcript' });
    var result = await processMessage({ text: transcript, partnerId: req.partner && req.partner.id, sessionId: sid, messageType: 'voice' });
    res.json({ reply: result.reply || 'Voice noted.', transcript: transcript, session_id: sid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// CRUD ENDPOINTS
// ============================================================
app.get('/api/suppliers', requireAuth, async function(req, res) {
  var q = supabase.from('suppliers').select('*').order('created_at', { ascending: false }).limit(parseInt(req.query.limit)||50);
  if (req.query.search) q = q.ilike('name', '%'+req.query.search+'%');
  var r = await q; res.json(r.error ? { error: r.error } : { suppliers: r.data||[] });
});
app.get('/api/suppliers/:id', requireAuth, async function(req, res) {
  var s = await supabase.from('suppliers').select('*').eq('id', req.params.id).single();
  var p = await supabase.from('products').select('*').eq('supplier_id', req.params.id);
  var research = await supabase.from('product_research').select('*').eq('product_id', req.params.id).limit(10);
  res.json({ supplier: s.data, products: p.data||[], research: research.data||[] });
});
app.post('/api/suppliers', requireAuth, async function(req, res) {
  var r = await supabase.from('suppliers').insert(Object.assign({}, req.body, { created_by: req.partner&&req.partner.id })).select().single();
  res.json(r.error ? { error: r.error } : { supplier: r.data });
});
app.patch('/api/suppliers/:id', requireAuth, async function(req, res) {
  var r = await supabase.from('suppliers').update(req.body).eq('id', req.params.id).select().single();
  res.json(r.error ? { error: r.error } : { supplier: r.data });
});
app.get('/api/products', requireAuth, async function(req, res) {
  var q = supabase.from('products').select('*').order('created_at', { ascending: false }).limit(parseInt(req.query.limit)||100);
  if (req.query.category) q = q.eq('category', req.query.category);
  var r = await q; res.json(r.error ? { error: r.error } : { products: r.data||[] });
});
app.post('/api/products', requireAuth, async function(req, res) {
  var r = await supabase.from('products').insert(Object.assign({}, req.body, { created_by: req.partner&&req.partner.id })).select().single();
  res.json(r.error ? { error: r.error } : { product: r.data });
});
app.patch('/api/products/:id', requireAuth, async function(req, res) {
  var r = await supabase.from('products').update(req.body).eq('id', req.params.id).select().single();
  res.json(r.error ? { error: r.error } : { product: r.data });
});
app.get('/api/meetings', requireAuth, async function(req, res) {
  var q = supabase.from('meetings').select('*').order('scheduled_at');
  if (req.query.date) q = q.gte('scheduled_at', req.query.date).lt('scheduled_at', req.query.date+'T23:59:59');
  var r = await q; res.json(r.error ? { error: r.error } : { meetings: r.data||[] });
});
app.post('/api/meetings', requireAuth, async function(req, res) {
  var r = await supabase.from('meetings').insert(Object.assign({}, req.body, { created_by: req.partner&&req.partner.id })).select().single();
  res.json(r.error ? { error: r.error } : { meeting: r.data });
});
app.get('/api/categories', requireAuth, async function(req, res) {
  var r = await supabase.from('categories').select('*').order('name');
  res.json(r.error ? { error: r.error } : { categories: r.data||[] });
});
app.get('/api/reports', requireAuth, async function(req, res) {
  var q = supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(20);
  if (req.query.type) q = q.eq('type', req.query.type);
  var r = await q; res.json(r.error ? { error: r.error } : { reports: r.data||[] });
});
app.post('/api/reports/generate', requireAuth, async function(req, res) {
  var sid = req.body.session_id || await getActiveSessionId();
  var d = req.body.date || new Date().toISOString().split('T')[0];
  if (!sid) return res.status(400).json({ error: 'No active fair session' });
  try {
    var report = req.body.type === 'evening' ? await generateEveningReport(sid, d) : await generateMorningReport(sid, d);
    await sendReportToTelegram(report);
    res.json({ report: report });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/welcome', requireAuth, async function(req, res) { res.json(await sendWelcomeMessage()); });
app.get('/api/partners', requireAuth, async function(req, res) {
  var r = await supabase.from('partner_profiles').select('id, name, role, at_fair, language, email');
  res.json(r.error ? { error: r.error } : { partners: r.data||[] });
});
app.post('/api/search', requireAuth, async function(req, res) {
  var results = { internal: [], research: [] };
  if (req.body.query) {
    var p = await supabase.from('products').select('*').ilike('name','%'+req.body.query+'%').limit(10);
    results.internal = p.data||[];
    var rr = await supabase.from('product_research').select('*').ilike('product_name','%'+req.body.query+'%').limit(10);
    results.research = rr.data||[];
  }
  res.json(results);
});

// ============================================================
// TELEGRAM WEBHOOK â Full context, saves all messages, learns corrections
// ============================================================
app.post('/api/telegram/webhook', async function(req, res) {
  var body = req.body;
  var msg  = (body && body.message) || (body && body.channel_post) || (body && body.edited_message);
  var text = (msg && msg.text && msg.text.trim()) || '';
  if (!msg || !text) { res.sendStatus(200); return; }

  var isReply   = !!(msg.reply_to_message && msg.reply_to_message.from);
  var isMention = text.indexOf('@ValeranSV_bot') > -1;
  var isPrefix  = /^valeran/i.test(text) || /^valera[,\s]/i.test(text) || /^\u0432\u0430\u043b\u0435\u0440\u0430/i.test(text);
  var isAddressed = isPrefix || isMention || isReply;

  // Save ALL group messages to chat history (silent logging)
  var sid = await getActiveSessionId() || 'default';
  var from = (msg.from && msg.from.first_name) || 'Partner';

  // Always save non-valeran messages for context
  if (!isAddressed) {
    await saveMessage(sid, 'user', from + ': ' + text, null, 'telegram', from);
    res.sendStatus(200);
    return;
  }

  // Build query with reply context
  var query = text.replace(/@ValeranSV_bot/gi,'').replace(/^(valeran|valera|\u0432\u0430\u043b\u0435\u0440\u0430\u043d|\u0432\u0430\u043b\u0435\u0440\u0430)[,\s!?]*/i,'').trim() || 'Hello';

  if (msg.reply_to_message && msg.reply_to_message.text) {
    var replyFrom = (msg.reply_to_message.from && msg.reply_to_message.from.first_name) || 'someone';
    var isBot = msg.reply_to_message.from && msg.reply_to_message.from.is_bot;
    var ctx = isBot
      ? '[Context â you previously said: "' + msg.reply_to_message.text.slice(0,300) + '"]'
      : '[Context â ' + replyFrom + ' said: "' + msg.reply_to_message.text.slice(0,300) + '"]';
    query = ctx + '\n\n' + from + ' asks: ' + query;
  }

  try {
    var memory = await loadMemory();
    var history = await (async function() {
      var { data } = await supabase.from('chat_messages').select('role, content').eq('session_id', sid).not('content', 'ilike', '__VALERAN_%').order('created_at', { ascending: false }).limit(10);
      return (data || []).reverse();
    })();

    var system = 'You are Valeran, the AI assistant for Synergy Ventures at Canton Fair 2026 in Guangzhou, China. You are responding to ' + from + ' in the team Telegram group. Team: Alexander (EN), Ina (RU), Konstantin Khoch (RU), Konstantin Ganev (BG), Slavi (BG). CRITICAL RULE: detect the language of the incoming message and reply in the EXACT same language — Bulgarian in = Bulgarian out, Russian in = Russian out, English in = English out. Never mix languages. Be concise (max 200 words). Use any [Context:...] provided to understand what is being replied to. Help with: product sourcing, margin calculations, weather, translations, schedules, jokes, or anything else.' + memory;

    var messages = history.map(function(m){ return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }; });
    messages.push({ role: 'user', content: query });

    var reply = await callAI(messages, system, 600, 18000);
    if (!reply) { res.sendStatus(200); return; }

    await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: msg.chat.id, text: reply, reply_to_message_id: msg.message_id, parse_mode: 'Markdown' })
    });

    // Save both sides to DB
    await saveMessage(sid, 'user', from + ': ' + query, null, 'telegram', from);
    await saveMessage(sid, 'assistant', reply, null, 'telegram', 'Valeran');

  } catch(e) { console.error('[TG] error:', e.message); }

  res.sendStatus(200);
});

// ============================================================
// CRON JOBS
// ============================================================
cron.schedule('30 13 * * *', async function() {
  var sid = await getActiveSessionId(); if (!sid) return;
  var date = new Date().toISOString().split('T')[0];
  console.log('[cron] Evening report...');
  var report = await generateEveningReport(sid, date);
  await sendReportToTelegram(report);
  enrichAllProducts(sid).catch(console.error);
});
cron.schedule('0 23 * * *', async function() {
  var t = new Date(); t.setDate(t.getDate()+1);
  var date = t.toISOString().split('T')[0];
  var sid  = await getActiveSessionId(date); if (!sid) return;
  console.log('[cron] Morning report...');
  await sendReportToTelegram(await generateMorningReport(sid, date));
});
// Scraping run: every day at 14:00 UTC (22:00 China time)
cron.schedule('0 14 * * *', async function() {
  var sid = await getActiveSessionId(); if (!sid) return;
  console.log('[cron] Daily research run...');
  enrichAllProducts(sid).catch(console.error);
});

async function getActiveSessionId(date) {
  var d = date || new Date().toISOString().split('T')[0];
  var r = await supabase.from('fair_sessions').select('id').lte('start_date',d).gte('end_date',d).single();
  return r.data && r.data.id || null;
}

app.listen(process.env.PORT || 3001, function() { console.log('â Valeran online'); });
module.exports = app;