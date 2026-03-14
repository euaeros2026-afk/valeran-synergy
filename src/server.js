'use strict';
require('dotenv').config();
var express    = require('express');
var cors       = require('cors');
var multer     = require('multer');
var cron       = require('node-cron');
var supabaseJs = require('@supabase/supabase-js');
var core       = require('./lib/valeran-core');
var tg         = require('./lib/telegram-bot');
var scraper    = require('./lib/scraping-engine');

var app      = express();
var supabase = supabaseJs.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
var upload   = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

async function requireAuth(req, res, next) {
  var token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  var auth = await supabase.auth.getUser(token);
  if (auth.error || !auth.data.user) return res.status(401).json({ error: 'Invalid token' });
  var p = await supabase.from('partner_profiles').select('*').eq('email', auth.data.user.email).single();
  req.user    = auth.data.user;
  req.partner = p.data || { email: auth.data.user.email, name: auth.data.user.email.split('@')[0], role: 'partner', language: 'en' };
  next();
}

app.get('/health',     function(req, res) { res.json({ ok: true }); });
app.get('/api/health', function(req, res) { res.json({ status: 'ok', valeran: 'online', time: new Date().toISOString() }); });

app.get('/api/debug/ai', async function(req, res) {
  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 20, messages: [{ role: 'user', content: 'Say ONLINE' }] }) });
    var d = await r.json();
    res.json({ status: r.status, reply: d.content && d.content[0] && d.content[0].text });
  } catch(e) { res.json({ error: e.message }); }
});


// Save a team message (no AI response) — for group chat between members
app.post('/api/chat/send', requireAuth, async function(req, res) {
  if (!req.body.text) return res.status(400).json({ error: 'No text' });
  var sid = req.body.session_id || (await getActiveSessionId()) || 'default';
  var senderName = (req.partner && req.partner.name) || req.user.email.split('@')[0];
  // Save with the sender's name prefixed so everyone sees who said it
  await supabase.from('chat_messages').insert({
    session_id: sid,
    partner_id: req.partner && req.partner.id || null,
    role: 'user',
    content: req.body.text,
    source: 'web',
    telegram_user: senderName
  });
  res.json({ saved: true, session_id: sid });
});

app.post('/api/chat/message', requireAuth, async function(req, res) {
  if (!req.body.text) return res.status(400).json({ error: 'No text' });
  var sid = req.body.session_id || (await getActiveSessionId()) || 'default';
  try {
    var result = await core.processMessage({ text: req.body.text, partnerId: req.partner && req.partner.id, sessionId: sid });
    res.json({ reply: result.responded ? result.reply : null, session_id: sid, responded: result.responded });
  } catch(e) { res.json({ reply: 'Error ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ try again.', session_id: sid }); }
});

app.get('/api/chat/messages', requireAuth, async function(req, res) {
  var sid = req.query.session_id || (await getActiveSessionId()) || 'default';
  var r = await supabase.from('chat_messages').select('*').eq('session_id', sid).not('content', 'ilike', '__VALERAN_%').order('created_at', { ascending: true }).limit(parseInt(req.query.limit) || 60);
  res.json(r.error ? { error: r.error } : { messages: r.data || [] });
});

app.post('/api/correct', requireAuth, async function(req, res) {
  if (!req.body.correction) return res.status(400).json({ error: 'No correction text' });
  await core.saveCorrection(req.body.correction, req.partner && req.partner.id, req.body.subject || 'user_correction');
  res.json({ saved: true });
});

app.get('/api/memory', requireAuth, async function(req, res) {
  var r = await supabase.from('valeran_memory').select('*').eq('active', true).order('created_at', { ascending: false }).limit(50);
  res.json(r.error ? { error: r.error } : { memory: r.data || [] });
});

app.post('/api/catalogue/upload', requireAuth, upload.single('file'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    var sid = req.body.session_id || (await getActiveSessionId()) || 'default';
    var upR = await supabase.from('catalogue_uploads').insert({ filename: req.file.originalname || 'file', supplier_id: req.body.supplier_id || null, session_id: sid, uploaded_by: req.partner && req.partner.id, analysis_status: 'processing' }).select().single();
    var uploadId = upR.data && upR.data.id;
    var fileText = req.file.buffer.toString('utf-8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
    if (fileText.trim().length < 20) {
      if (uploadId) await supabase.from('catalogue_uploads').update({ analysis_status: 'failed', summary: 'Could not extract text.' }).eq('id', uploadId);
      return res.json({ success: false, message: 'Could not extract text.' });
    }
    res.json({ success: true, uploadId: uploadId, filename: req.file.originalname, message: 'Analysing...' });
    core.analyseCatalogue(fileText, req.body.supplier_id || null, sid, uploadId).catch(function(e) {
      if (uploadId) supabase.from('catalogue_uploads').update({ analysis_status: 'failed' }).eq('id', uploadId);
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/catalogue/uploads', requireAuth, async function(req, res) {
  var r = await supabase.from('catalogue_uploads').select('*').order('created_at', { ascending: false }).limit(20);
  res.json(r.error ? { error: r.error } : { uploads: r.data || [] });
});

app.post('/api/research', requireAuth, async function(req, res) {
  if (!req.body.query) return res.status(400).json({ error: 'No query' });
  res.json({ message: 'Research started for: ' + req.body.query });
  scraper.researchProduct(req.body.query, req.body.product_id || null).catch(console.error);
});

app.get('/api/research/results', requireAuth, async function(req, res) {
  var q = supabase.from('product_research').select('*').order('created_at', { ascending: false }).limit(50);
  if (req.query.product_id) q = q.eq('product_id', req.query.product_id);
  if (req.query.platform) q = q.eq('platform', req.query.platform);
  var r = await q;
  res.json(r.error ? { error: r.error } : { results: r.data || [] });
});

app.post('/api/chat/photo', requireAuth, upload.single('photo'), async function(req, res) {
  try {
    var sid = req.body.session_id || (await getActiveSessionId()) || 'default';
    if (!req.file) return res.status(400).json({ error: 'No photo' });
    var labels = [];
    try {
      var vr = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + process.env.GOOGLE_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ image: { content: req.file.buffer.toString('base64') }, features: [{ type: 'LABEL_DETECTION', maxResults: 8 }] }] }) });
      var vd = await vr.json();
      labels = ((vd.responses && vd.responses[0] && vd.responses[0].labelAnnotations) || []).map(function(l) { return l.description; });
    } catch(e) {}
    var q = 'Valeran, ' + ([req.body.caption, labels.length ? 'Product: ' + labels.join(', ') : ''].filter(Boolean).join('. ') || 'Photo from Canton Fair');
    var result = await core.processMessage({ text: q, partnerId: req.partner && req.partner.id, sessionId: sid });
    res.json({ reply: result.reply || 'Photo logged.', visionLabels: labels, session_id: sid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat/voice', requireAuth, upload.single('audio'), async function(req, res) {
  try {
    var sid = req.body.session_id || (await getActiveSessionId()) || 'default';
    if (!req.file) return res.status(400).json({ error: 'No audio' });
    var transcript = '';
    try {
      var sr = await fetch('https://speech.googleapis.com/v1/speech:recognize?key=' + process.env.GOOGLE_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: { content: req.file.buffer.toString('base64') }, config: { encoding: 'WEBM_OPUS', sampleRateHertz: 48000, languageCode: 'en-US', alternativeLanguageCodes: ['ru-RU', 'bg-BG'] } }) });
      var sd = await sr.json();
      transcript = (sd.results || []).map(function(r) { return r.alternatives[0].transcript; }).join(' ');
    } catch(e) {}
    if (!transcript) return res.status(400).json({ error: 'No transcript' });
    var result = await core.processMessage({ text: transcript, partnerId: req.partner && req.partner.id, sessionId: sid });
    res.json({ reply: result.reply || 'Voice noted.', transcript: transcript, session_id: sid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suppliers', requireAuth, async function(req, res) {
  var q = supabase.from('suppliers').select('*').order('created_at', { ascending: false }).limit(parseInt(req.query.limit) || 50);
  if (req.query.search) q = q.ilike('name', '%' + req.query.search + '%');
  var r = await q; res.json(r.error ? { error: r.error } : { suppliers: r.data || [] });
});
app.get('/api/suppliers/:id', requireAuth, async function(req, res) {
  var s = await supabase.from('suppliers').select('*').eq('id', req.params.id).single();
  var p = await supabase.from('products').select('*').eq('supplier_id', req.params.id);
  res.json({ supplier: s.data, products: p.data || [] });
});
app.post('/api/suppliers', requireAuth, async function(req, res) {
  var r = await supabase.from('suppliers').insert(Object.assign({}, req.body, { created_by: req.partner && req.partner.id })).select().single();
  res.json(r.error ? { error: r.error } : { supplier: r.data });
});
app.patch('/api/suppliers/:id', requireAuth, async function(req, res) {
  var r = await supabase.from('suppliers').update(req.body).eq('id', req.params.id).select().single();
  res.json(r.error ? { error: r.error } : { supplier: r.data });
});
app.get('/api/products', requireAuth, async function(req, res) {
  var q = supabase.from('products').select('*').order('created_at', { ascending: false }).limit(parseInt(req.query.limit) || 100);
  if (req.query.category) q = q.eq('category', req.query.category);
  var r = await q; res.json(r.error ? { error: r.error } : { products: r.data || [] });
});
app.post('/api/products', requireAuth, async function(req, res) {
  var r = await supabase.from('products').insert(Object.assign({}, req.body, { created_by: req.partner && req.partner.id })).select().single();
  res.json(r.error ? { error: r.error } : { product: r.data });
});
app.patch('/api/products/:id', requireAuth, async function(req, res) {
  var r = await supabase.from('products').update(req.body).eq('id', req.params.id).select().single();
  res.json(r.error ? { error: r.error } : { product: r.data });
});
app.get('/api/meetings', requireAuth, async function(req, res) {
  var q = supabase.from('meetings').select('*').order('scheduled_at');
  if (req.query.date) q = q.gte('scheduled_at', req.query.date).lt('scheduled_at', req.query.date + 'T23:59:59');
  var r = await q; res.json(r.error ? { error: r.error } : { meetings: r.data || [] });
});
app.post('/api/meetings', requireAuth, async function(req, res) {
  var r = await supabase.from('meetings').insert(Object.assign({}, req.body, { created_by: req.partner && req.partner.id })).select().single();
  res.json(r.error ? { error: r.error } : { meeting: r.data });
});
app.get('/api/categories', requireAuth, async function(req, res) {
  var r = await supabase.from('categories').select('*').order('name');
  res.json(r.error ? { error: r.error } : { categories: r.data || [] });
});
app.get('/api/reports', requireAuth, async function(req, res) {
  var q = supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(20);
  if (req.query.type) q = q.eq('type', req.query.type);
  var r = await q; res.json(r.error ? { error: r.error } : { reports: r.data || [] });
});
app.post('/api/reports/generate', requireAuth, async function(req, res) {
  var sid = req.body.session_id || (await getActiveSessionId());
  var d = req.body.date || new Date().toISOString().split('T')[0];
  if (!sid) return res.status(400).json({ error: 'No active fair session' });
  try {
    var report = req.body.type === 'evening' ? await core.generateEveningReport(sid, d) : await core.generateMorningReport(sid, d);
    await tg.sendReportToTelegram(report);
    res.json({ report: report });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/presence/ping', requireAuth, async function(req, res) {
  var email = req.user.email;
  var name  = (req.partner && req.partner.name) || email.split('@')[0];
  await supabase.from('partner_presence').upsert(
    { email: email, name: name, partner_id: (req.partner && req.partner.id) || null, last_seen: new Date().toISOString(), is_online: true, platform: (req.body && req.body.platform) || 'web' },
    { onConflict: 'email' }
  );
  res.json({ ok: true });
});
app.post('/api/presence/offline', requireAuth, async function(req, res) {
  await supabase.from('partner_presence').upsert(
    { email: req.user.email, is_online: false, last_seen: new Date().toISOString() },
    { onConflict: 'email' }
  );
  res.json({ ok: true });
});
app.get('/api/presence', requireAuth, async function(req, res) {
  await supabase.from('partner_presence').update({ is_online: false }).lt('last_seen', new Date(Date.now() - 90000).toISOString());
  var r = await supabase.from('partner_presence').select('*').order('name');
  res.json(r.error ? { error: r.error } : { presence: r.data || [] });
});
app.post('/api/welcome', requireAuth, async function(req, res) { res.json(await tg.sendWelcomeMessage()); });
app.get('/api/partners', requireAuth, async function(req, res) {
  var r = await supabase.from('partner_profiles').select('id, name, role, at_fair, language, email');
  res.json(r.error ? { error: r.error } : { partners: r.data || [] });
});
app.post('/api/search', requireAuth, async function(req, res) {
  var results = { internal: [], research: [] };
  if (req.body.query) {
    var p = await supabase.from('products').select('*').ilike('name', '%' + req.body.query + '%').limit(10);
    results.internal = p.data || [];
    var rr = await supabase.from('product_research').select('*').ilike('product_name', '%' + req.body.query + '%').limit(10);
    results.research = rr.data || [];
  }
  res.json(results);
});

// ---- HELPERS ----
var TG_SYSTEM = 'You are Valeran, AI assistant for Synergy Ventures at Canton Fair 2026 in Guangzhou. ' +
  'Team: Alexander (EN), Ina (RU), Konstantin Khoch (RU), Konstantin Ganev (BG), Slavi (BG). ' +
  'LANGUAGE: reply in exact same language as the message. BG=BG, RU=RU, EN=EN. Never mix. ' +
  'STYLE: short and direct. 1-3 sentences for simple questions. No fluff. ' +
  'Use [Context:...] when present ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ that is what someone replied to.';

async function tgSend(chatId, text, replyToId) {
  var body = { chat_id: chatId, text: text.slice(0, 4000) };
  if (replyToId) body.reply_to_message_id = replyToId;
  return fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}

// ---- TELEGRAM WEBHOOK ----
// CRITICAL: ALL work happens BEFORE res.sendStatus(200).
// Vercel kills async code after res.send().
// For documents: takes 10-20s ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Telegram retries after 5s (harmless).
// For text: takes 3-5s ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ within Telegram's window.

app.post('/api/telegram/webhook', async function(req, res) {
  var body = req.body || {};
  var msg  = body.message || body.channel_post || body.edited_message;
  if (!msg) { res.sendStatus(200); return; }

  var from   = (msg.from && msg.from.first_name) || 'Partner';
  var chatId = msg.chat && msg.chat.id;
  var sid    = (await getActiveSessionId()) || 'default';

  // ---- DOCUMENT / PDF ----
  if (msg.document) {
    var doc   = msg.document;
    var fname = doc.file_name || 'document';
    var cap   = (msg.caption && msg.caption.trim()) || '';

    try {
      // Get Telegram file path
      var fi = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/getFile?file_id=' + doc.file_id);
      var fd = await fi.json();
      if (!fd.ok) throw new Error('Cannot get file from Telegram');

      // Download file
      var fileURL = 'https://api.telegram.org/file/bot' + process.env.TELEGRAM_BOT_TOKEN + '/' + fd.result.file_path;
      var ctrl = new AbortController();
      setTimeout(function() { ctrl.abort(); }, 20000);
      var fileResp = await fetch(fileURL, { signal: ctrl.signal });
      if (!fileResp.ok) throw new Error('Download failed');
      var buffer = Buffer.from(await fileResp.arrayBuffer());
      var b64 = buffer.toString('base64');
      var isPDF = fname.toLowerCase().endsWith('.pdf') || doc.mime_type === 'application/pdf';

      var summary = '';
      var method  = '';

      // ---- LEVEL 1: Try direct text extraction ----
      var fileText = buffer.toString('utf8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
      // Count actual words (3+ letter sequences) ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ binary PDFs have scattered chars, not real words
      var words = (fileText.match(/[a-zA-Z\u0400-\u04FF]{3,}/g) || []);
      var wordDensity = words.length / Math.max(1, buffer.length / 100);
      var hasRealText = words.length > 80 && wordDensity > 1.5;

      if (hasRealText) {
        method = 'text (Haiku)';
        var prompt = 'Analyse this document for a Telegram group. Use ONLY Telegram formatting: *bold* for section headers, plain - for bullet points. Structure: *What it is* (1 line), *Key facts* (- bullets), *Action items* (- bullets). Document: ' + fileText.slice(0, 5000);
        summary = await core.callAI([{ role: 'user', content: prompt }], TG_SYSTEM, 700, 25000);
      }

      // ---- LEVEL 2: Claude Sonnet PDF vision (handles scanned PDFs as images) ----
      if (!summary && isPDF) {
        method = 'PDF vision (Sonnet)';
        var ctrl2 = new AbortController();
        setTimeout(function() { ctrl2.abort(); }, 40000);
        try {
          var r2 = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1000,
              messages: [{
                role: 'user',
                content: [
                  { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
                  { type: 'text', text: 'Read this document and summarise it for a Telegram group. Use ONLY Telegram-compatible formatting: *bold* for headers (not ** or ##), plain - for bullet points, no markdown tables. Structure: *What it is* (1 line), then *Key facts* (dates, locations, rules as - bullets), then *Action items* (- bullets). Be thorough but scannable.' + (cap ? ' Sender note: ' + cap : '') }
                ]
              }]
            }),
            signal: ctrl2.signal
          });
          var r2d = await r2.json();
          summary = r2d.content && r2d.content[0] && r2d.content[0].text || '';
          if (summary && summary.length < 50) summary = ''; // too short = failed
        } catch(e2) { console.error('[PDF Sonnet]', e2.message); }
      }

      // ---- LEVEL 3: Google Vision OCR (last resort for image PDFs) ----
      if (!summary && isPDF && process.env.GOOGLE_API_KEY) {
        method = 'OCR (Google Vision)';
        try {
          // Google Vision can OCR a PDF stored in GCS, but we can also send as base64 image
          // We'll send the raw PDF bytes asking for DOCUMENT_TEXT_DETECTION
          var visionR = await fetch('https://vision.googleapis.com/v1/files:asyncBatchAnnotate?key=' + process.env.GOOGLE_API_KEY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requests: [{
                inputConfig: { content: b64, mimeType: 'application/pdf' },
                features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
                outputConfig: { gcsDestination: { uri: 'gs://not-used' }, batchSize: 1 }
              }]
            })
          });
          // Sync fallback: try Vision API with the first chunk as an image annotation
          var visionR2 = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + process.env.GOOGLE_API_KEY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requests: [{
                image: { content: b64.slice(0, 4000000) }, // Vision limit ~4MB
                features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }]
              }]
            })
          });
          var vd = await visionR2.json();
          var ocrText = vd.responses && vd.responses[0] && vd.responses[0].fullTextAnnotation && vd.responses[0].fullTextAnnotation.text || '';
          if (ocrText && ocrText.length > 100) {
            var ocrPrompt = 'Analyse this OCR-extracted document text for a Telegram group. Use ONLY Telegram formatting: *bold* for headers, plain - for bullets. Structure: *What it is* (1 line), *Key facts* (- bullets), *Actions* (- bullets). Text: ' + ocrText.slice(0, 5000);
            summary = await core.callAI([{ role: 'user', content: ocrPrompt }], TG_SYSTEM, 700, 20000);
          }
        } catch(e3) { console.error('[PDF OCR]', e3.message); }
      }

      // ---- FALLBACK: save with caption, ask for text version ----
      if (!summary) {
        method = 'fallback';
        summary = 'Saved "' + fname + '" ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ' +
          (cap ? '\nYour note: ' + cap : '') +
          '\n\nThis PDF contains only scanned images ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ no readable text layer. To make it work:\n' +
          '1. Open on PC ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ upload to Google Drive ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ right-click ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Open with Google Docs (auto-OCR)\n' +
          '2. Download as .txt ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ send me that file\n' +
          'Or just tell me the key info in a message and I will remember it.';
      }

      // Save to memory (always, regardless of method)
      var memContent = 'Document "' + fname + '" from ' + from + (cap ? '. Note: ' + cap : '') + '. Read via: ' + method + '. Summary: ' + summary.slice(0, 900);
      await core.saveCorrection(memContent, null, 'doc_' + fname.replace(/[^a-z0-9]/gi, '_').slice(0, 40));
      await supabase.from('catalogue_uploads').insert({ filename: fname, session_id: sid, analysis_status: method !== 'fallback' ? 'done' : 'failed', products_extracted: 0, summary: summary.slice(0, 2000), raw_analysis: { caption: cap, from: from, method: method, size: doc.file_size } });

      // Clean up any non-Telegram markdown before sending
      var reply = summary
        .replace(/^#{1,3}\s*/gm, '')           // remove ## headers
        .replace(/\*\*([^*]+)\*\*/g, '*$1*')  // convert **bold** to *bold*
        .replace(/^\s*[ÃÂ¢ÃÂÃÂ¢ÃÂÃÂ·]/gm, '-')             // convert bullet symbols to -
        .slice(0, 3900);
      if (method && method !== 'fallback') reply = reply + '\n\n_(' + method + ')_';
      await tgSend(chatId, reply, msg.message_id);
      await core.saveMessage(sid, 'user', from + ' sent: ' + fname, null, 'telegram', from);
      await core.saveMessage(sid, 'assistant', reply, null, 'telegram', 'Valeran');

    } catch(e) {
      console.error('[TG doc]', e.message);
      await tgSend(chatId, 'Could not process "' + fname + '": ' + e.message, msg.message_id);
    }

    res.sendStatus(200);
    return;
  }

  // ---- VOICE (Telegram) ----
  // Voice messages ALWAYS get a response â no trigger word needed
  if (msg.voice || msg.audio) {
    var vf = msg.voice || msg.audio;
    try {
      var vfi = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/getFile?file_id=' + vf.file_id);
      var vfd = await vfi.json();
      if (!vfd.ok) throw new Error('Cannot get voice file');
      var vCtrl = new AbortController();
      setTimeout(function() { vCtrl.abort(); }, 20000);
      var vResp = await fetch('https://api.telegram.org/file/bot' + process.env.TELEGRAM_BOT_TOKEN + '/' + vfd.result.file_path, { signal: vCtrl.signal });
      if (!vResp.ok) throw new Error('Voice download failed');
      var vBuf = Buffer.from(await vResp.arrayBuffer());

      // Transcribe with auto language detection (try EN first, then RU, BG)
      var transcript = '';
      var langConfigs = [
        { languageCode: 'en-US', alternativeLanguageCodes: ['ru-RU', 'bg-BG'] },
        { languageCode: 'ru-RU', alternativeLanguageCodes: ['en-US', 'bg-BG'] },
        { languageCode: 'bg-BG', alternativeLanguageCodes: ['en-US', 'ru-RU'] }
      ];
      for (var lci = 0; lci < langConfigs.length && !transcript; lci++) {
        try {
          var sR = await fetch('https://speech.googleapis.com/v1/speech:recognize?key=' + process.env.GOOGLE_API_KEY, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              audio: { content: vBuf.toString('base64') },
              config: Object.assign({ encoding: 'OGG_OPUS', sampleRateHertz: 48000, enableAutomaticPunctuation: true }, langConfigs[lci])
            })
          });
          var sD = await sR.json();
          var t = (sD.results || []).map(function(r) { return r.alternatives[0].transcript; }).join(' ').trim();
          if (t && t.length > 3) transcript = t;
        } catch(se) { console.error('[voice transcribe]', se.message); }
      }

      if (!transcript) {
        await tgSend(chatId, 'Could not transcribe. Speak clearly closer to mic, or type instead.', msg.message_id);
        res.sendStatus(200); return;
      }

      // Show transcript so the whole group sees what was said
      await tgSend(chatId, '\uD83C\uDFA4 ' + from + ': \u201c' + transcript + '\u201d', msg.message_id);
      await core.saveMessage(sid, 'user', from + ' (voice): ' + transcript, null, 'telegram', from);

      // Strip trigger word if present (but we always respond regardless)
      var vQuery = transcript.replace(/^(valeran|valera|\u0432\u0430\u043b\u0435\u0440\u0430\u043d|\u0432\u0430\u043b\u0435\u0440\u0430)[,\s!?]*/i, '').trim() || transcript;

      // Detect work-relevant content for auto-logging
      var workKw = ['meeting', 'supplier', 'product', 'price', 'order', 'booth', 'hall', 'sample', 'contact', 'wechat', 'email', 'schedule',
        '\u0432\u0441\u0442\u0440\u0435\u0447\u0430', '\u0441\u0440\u0435\u0449\u0430', '\u0434\u043e\u0441\u0442\u0430\u0432\u0447\u0438\u043a',
        '\u043f\u0440\u043e\u0434\u0443\u043a\u0442', '\u0446\u0435\u043d\u0430', '\u043f\u043e\u0440\u044a\u0447\u043a\u0430',
        '\u0437\u0430\u043a\u0430\u0437', '\u043e\u0431\u0440\u0430\u0437\u0435\u0446'];
      var isWork = workKw.some(function(kw) { return transcript.toLowerCase().indexOf(kw) > -1; });

      var vSystemExtra = isWork
        ? ' This voice note contains work information. Respond normally, then on a new line add "\nLOGGED:" followed by 1-3 bullet points summarising the key facts (meeting time/place, supplier name/contact, product details, etc.).'
        : '';

      var vMem  = await core.loadMemory();
      var vHR   = await supabase.from('chat_messages').select('role, content').eq('session_id', sid).not('content', 'ilike', '__VALERAN_%').order('created_at', { ascending: false }).limit(10);
      var vMsgs = ((vHR.data || []).reverse()).map(function(m) { return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }; });
      vMsgs.push({ role: 'user', content: vQuery });

      var vReply = await core.callAI(vMsgs, TG_SYSTEM + vSystemExtra + vMem, 500, 18000);
      if (!vReply) { res.sendStatus(200); return; }

      // Split response and LOGGED section if present
      if (vReply.indexOf('LOGGED:') > -1) {
        var vParts  = vReply.split('LOGGED:');
        var vText   = vParts[0].trim();
        var vLogged = vParts[1] ? vParts[1].trim() : '';
        await tgSend(chatId, vText, null);
        if (vLogged) {
          await core.saveCorrection('Voice log [' + from + ']: ' + vLogged, null, 'voice_log');
          await tgSend(chatId, '\uD83D\uDCCB *Logged:* ' + vLogged, null);
        }
      } else {
        await tgSend(chatId, vReply, null);
      }
      await core.saveMessage(sid, 'assistant', vReply, null, 'telegram', 'Valeran');

    } catch(ve) {
      console.error('[TG voice]', ve.message);
      await tgSend(chatId, 'Voice error: ' + ve.message, msg.message_id);
    }
    res.sendStatus(200); return;
  }

  // ---- TEXT ----
  var text = (msg.text && msg.text.trim()) || '';
  if (!text) { res.sendStatus(200); return; }

  var isPrefix  = /^valeran/i.test(text) || /^valera[,\s]/i.test(text) || /^\u0432\u0430\u043b\u0435\u0440\u0430/i.test(text);
  var isMention = text.indexOf('@ValeranSV_bot') > -1;
  var isReply   = !!(msg.reply_to_message && msg.reply_to_message.from);

  if (!isPrefix && !isMention && !isReply) {
    core.saveMessage(sid, 'user', from + ': ' + text, null, 'telegram', from).catch(function() {});
    res.sendStatus(200);
    return;
  }

  var query = text.replace(/@ValeranSV_bot/gi, '').replace(/^(valeran|valera|\u0432\u0430\u043b\u0435\u0440\u0430\u043d|\u0432\u0430\u043b\u0435\u0440\u0430)[,\s!?]*/i, '').trim() || 'Hello';

  if (msg.reply_to_message && msg.reply_to_message.text) {
    var rFrom = (msg.reply_to_message.from && msg.reply_to_message.from.first_name) || 'someone';
    var isBot = !!(msg.reply_to_message.from && msg.reply_to_message.from.is_bot);
    var ctx = isBot ? '[Context ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ you said: "' + msg.reply_to_message.text.slice(0, 300) + '"]' : '[Context ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ' + rFrom + ' said: "' + msg.reply_to_message.text.slice(0, 300) + '"]';
    query = ctx + '\n' + from + ' asks: ' + query;
  }

  try {
    var memory  = await core.loadMemory();
    var histR   = await supabase.from('chat_messages').select('role, content').eq('session_id', sid).not('content', 'ilike', '__VALERAN_%').order('created_at', { ascending: false }).limit(10);
    var history = (histR.data || []).reverse();
    var msgs    = history.map(function(m) { return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }; });
    msgs.push({ role: 'user', content: query });

    var reply = await core.callAI(msgs, TG_SYSTEM + memory, 400, 18000);
    if (!reply) { res.sendStatus(200); return; }

    await tgSend(chatId, reply, msg.message_id);
    core.saveMessage(sid, 'user', from + ': ' + query, null, 'telegram', from).catch(function() {});
    core.saveMessage(sid, 'assistant', reply, null, 'telegram', 'Valeran').catch(function() {});
  } catch(e) { console.error('[TG]', e.message); }

  res.sendStatus(200);
});

// ---- CRON ----
cron.schedule('30 13 * * *', async function() {
  var sid = await getActiveSessionId(); if (!sid) return;
  var report = await core.generateEveningReport(sid, new Date().toISOString().split('T')[0]);
  await tg.sendReportToTelegram(report);
  scraper.enrichAllProducts(sid).catch(console.error);
});
cron.schedule('0 23 * * *', async function() {
  var t = new Date(); t.setDate(t.getDate() + 1);
  var d = t.toISOString().split('T')[0];
  var sid = await getActiveSessionId(d); if (!sid) return;
  await tg.sendReportToTelegram(await core.generateMorningReport(sid, d));
});
cron.schedule('0 14 * * *', async function() {
  var sid = await getActiveSessionId(); if (!sid) return;
  scraper.enrichAllProducts(sid).catch(console.error);
});

async function getActiveSessionId(date) {
  var d = date || new Date().toISOString().split('T')[0];
  var r = await supabase.from('fair_sessions').select('id').lte('start_date', d).gte('end_date', d).single();
  return r.data && r.data.id || null;
}

app.listen(process.env.PORT || 3001, function() { console.log('Valeran online'); });
module.exports = app;