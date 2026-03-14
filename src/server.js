require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const cron    = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { processMessage, generateEveningReport, generateMorningReport, callAI } = require('./lib/valeran-core');
const { sendReportToTelegram, sendWelcomeMessage } = require('./lib/telegram-bot');
const { enrichAllProducts } = require('./lib/scraping-engine');

const app      = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const upload   = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

async function requireAuth(req, res, next) {
  const token = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const authResult = await supabase.auth.getUser(token);
  const user = authResult.data && authResult.data.user;
  if (authResult.error || !user) return res.status(401).json({ error: 'Invalid token' });
  const partnerResult = await supabase.from('partner_profiles').select('*').eq('email', user.email).single();
  req.user    = user;
  req.partner = partnerResult.data || { email: user.email, name: user.email.split('@')[0], role: 'partner', language: 'en' };
  next();
}

app.get('/api/health', function(req, res) { res.json({ status: 'ok', valeran: 'online', time: new Date().toISOString() }); });
app.get('/health',     function(req, res) { res.json({ status: 'ok' }); });

app.get('/api/debug/ai', async function(req, res) {
  try {
    var key = process.env.ANTHROPIC_API_KEY || '';
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 20, messages: [{ role: 'user', content: 'Say ONLINE' }] })
    });
    var d = await r.json();
    res.json({ httpStatus: r.status, reply: d.content && d.content[0] && d.content[0].text || null, error: d.error || null, keyPrefix: key.slice(0,20)+'...' });
  } catch (e) { res.json({ fetchError: e.message }); }
});

// WEB CHAT — responds only to caller, NEVER sends to Telegram
app.post('/api/chat/message', requireAuth, async function(req, res) {
  var text = req.body.text;
  var session_id = req.body.session_id;
  if (!text) return res.status(400).json({ error: 'No message text' });
  var sid = session_id || await getActiveSessionId() || 'default';
  try {
    var result = await processMessage({ text: text, partnerId: req.partner && req.partner.id || null, sessionId: sid });
    // ONLY return to web — do NOT send to Telegram
    res.json({ reply: result.reply || 'Message noted.', session_id: sid, responded: result.responded });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.json({ reply: 'Something went wrong. Please try again.', session_id: sid });
  }
});

app.get('/api/chat/messages', requireAuth, async function(req, res) {
  var sid = req.query.session_id || await getActiveSessionId() || 'default';
  var limit = parseInt(req.query.limit) || 60;
  var result = await supabase.from('chat_messages').select('*')
    .eq('session_id', sid).not('content', 'eq', '__VALERAN_WELCOME_SENT__')
    .order('created_at', { ascending: true }).limit(limit);
  res.json(result.error ? { error: result.error } : { messages: result.data || [] });
});

app.post('/api/chat/photo', requireAuth, upload.single('photo'), async function(req, res) {
  try {
    var sid = req.body.session_id || await getActiveSessionId() || 'default';
    var caption = req.body.caption || '';
    if (!req.file) return res.status(400).json({ error: 'No photo' });
    var visionLabels = [];
    try {
      var vr = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + process.env.GOOGLE_API_KEY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ image: { content: req.file.buffer.toString('base64') }, features: [{ type: 'LABEL_DETECTION', maxResults: 8 }, { type: 'WEB_DETECTION', maxResults: 5 }] }] })
      });
      var vd = await vr.json();
      var resp = vd.responses && vd.responses[0];
      var labels = resp && resp.labelAnnotations ? resp.labelAnnotations.map(function(l){return l.description;}) : [];
      var web = resp && resp.webDetection && resp.webDetection.webEntities ? resp.webDetection.webEntities.map(function(e){return e.description;}).filter(Boolean) : [];
      visionLabels = labels.concat(web).slice(0,10);
    } catch (ve) { console.error('Vision:', ve.message); }
    var q = 'Valeran, ' + ([caption, visionLabels.length ? 'Product looks like: ' + visionLabels.join(', ') : ''].filter(Boolean).join('. ') || 'Photo from Canton Fair');
    var result = await processMessage({ text: q, partnerId: req.partner && req.partner.id || null, sessionId: sid, messageType: 'photo' });
    res.json({ reply: result.reply || 'Photo logged.', visionLabels: visionLabels, session_id: sid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat/voice', requireAuth, upload.single('audio'), async function(req, res) {
  try {
    var sid = req.body.session_id || await getActiveSessionId() || 'default';
    if (!req.file) return res.status(400).json({ error: 'No audio' });
    var transcript = '';
    try {
      var sr = await fetch('https://speech.googleapis.com/v1/speech:recognize?key=' + process.env.GOOGLE_API_KEY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: { content: req.file.buffer.toString('base64') }, config: { encoding: 'WEBM_OPUS', sampleRateHertz: 48000, languageCode: 'en-US', alternativeLanguageCodes: ['ru-RU', 'bg-BG'] } })
      });
      var sd = await sr.json();
      transcript = sd.results ? sd.results.map(function(r){return r.alternatives[0].transcript;}).join(' ') : '';
    } catch (se) { console.error('Speech:', se.message); }
    if (!transcript) return res.status(400).json({ error: 'Could not transcribe' });
    var result = await processMessage({ text: transcript, partnerId: req.partner && req.partner.id || null, sessionId: sid, messageType: 'voice' });
    res.json({ reply: result.reply || 'Voice noted.', transcript: transcript, session_id: sid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suppliers', requireAuth, async function(req, res) {
  var q = supabase.from('suppliers').select('*').order('created_at', { ascending: false }).limit(parseInt(req.query.limit)||50);
  if (req.query.search) q = q.ilike('name', '%'+req.query.search+'%');
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
  var q = supabase.from('products').select('*').order('created_at', { ascending: false }).limit(parseInt(req.query.limit)||100);
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
  if (req.query.date) q = q.gte('scheduled_at', req.query.date).lt('scheduled_at', req.query.date+'T23:59:59');
  var r = await q; res.json(r.error ? { error: r.error } : { meetings: r.data || [] });
});
app.post('/api/meetings', requireAuth, async function(req, res) {
  var r = await supabase.from('meetings').insert(Object.assign({}, req.body, { created_by: req.partner && req.partner.id })).select().single();
  res.json(r.error ? { error: r.error } : { meeting: r.data });
});

app.post('/api/search', requireAuth, upload.single('image'), async function(req, res) {
  var results = { internal: [] };
  if (req.body.query) { var r = await supabase.from('products').select('*').ilike('name', '%'+req.body.query+'%').limit(10); results.internal = r.data || []; }
  res.json(results);
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
  var sid = req.body.session_id || await getActiveSessionId();
  var d   = req.body.date || new Date().toISOString().split('T')[0];
  if (!sid) return res.status(400).json({ error: 'No active fair session' });
  try {
    var report = req.body.type === 'evening' ? await generateEveningReport(sid, d) : await generateMorningReport(sid, d);
    await sendReportToTelegram(report);
    res.json({ report: report });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/welcome', requireAuth, async function(req, res) {
  var result = await sendWelcomeMessage(); res.json(result);
});

app.get('/api/partners', requireAuth, async function(req, res) {
  var r = await supabase.from('partner_profiles').select('id, name, role, at_fair, language, email');
  res.json(r.error ? { error: r.error } : { partners: r.data || [] });
});

// ============================================================
// TELEGRAM WEBHOOK
// IMPORTANT: By default Telegram bots in groups only receive:
//   - /commands
//   - @bot_username mentions
//   - Replies to bot messages
// Regular messages need privacy mode DISABLED via BotFather.
// This handler covers ALL cases:
//   1. 'Valeran, ...' prefix (works after BotFather privacy fix)
//   2. '@ValeranSV_bot ...' mention (works NOW without BotFather)
//   3. Reply to a bot message (works NOW without BotFather)
// ============================================================
app.post('/api/telegram/webhook', async function(req, res) {
  var body = req.body;
  var msg  = (body && body.message) || (body && body.channel_post) || (body && body.edited_message);
  var text = (msg && msg.text && msg.text.trim()) || '';

  // Always ACK Telegram immediately
  res.sendStatus(200);

  if (!msg || !text) return;

  // Check if Valeran is addressed — multiple trigger patterns:
  // 1. Starts with 'Valeran' (requires privacy mode OFF in BotFather)
  // 2. Contains @ValeranSV_bot mention (works regardless of privacy mode)
  // 3. Is a reply to a Valeran message (works regardless of privacy mode)
  var isReplyToBot = msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot;
  var hasMention   = text.toLowerCase().indexOf('@valerансv_bot') > -1 || text.indexOf('@ValeranSV_bot') > -1;
  var hasValeranPrefix = /^valeran/i.test(text) || /^valera[,\s!?]/i.test(text) || /^\u0432\u0430\u043b\u0435\u0440\u0430/i.test(text);

  var isAddressed = hasValeranPrefix || hasMention || isReplyToBot;
  if (!isAddressed) return;

  try {
    // Strip trigger prefix to get the actual question
    var query = text
      .replace(/@ValeranSV_bot/gi, '')
      .replace(/^(valeran|valera|\u0432\u0430\u043b\u0435\u0440\u0430\u043d|\u0432\u0430\u043b\u0435\u0440\u0430)[,\s!?]*/i, '')
      .trim();
    if (!query) query = 'Hello, are you here?';

    var from   = (msg.from && msg.from.first_name) || 'Partner';
    var chatId = msg.chat.id;
    var sid    = await getActiveSessionId() || 'default';

    console.log('[TG] from:', from, 'query:', query.slice(0,80));

    var system = [
      'You are Valeran, the AI assistant for Synergy Ventures at Canton Fair 2026 in Guangzhou, China.',
      'You are replying to ' + from + ' in the team Telegram group.',
      'The team: Alexander Oslan (owner, EN), Ina Kanaplianikava (partner, RU), Konstantin Khoch (partner, RU), Konstantin Ganev (partner, BG), Slavi Mikinski (observer, BG).',
      'Be concise and practical. Max 200 words unless a detailed report is needed.',
      'IMPORTANT: Detect the language of the message and reply in the SAME language (English/Russian/Bulgarian).',
      'You help with: product research, margin calculations, supplier vetting, EU market analysis, weather, translations, logistics, scheduling, or anything else the team needs.'
    ].join(' ');

    var reply = await callAI([{ role: 'user', content: query }], system, 500, 22000);
    if (!reply) { console.error('[TG] callAI returned null'); return; }

    console.log('[TG] sending reply:', reply.slice(0,80));

    await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply,
        reply_to_message_id: msg.message_id,
        parse_mode: 'Markdown'
      })
    });

    // Save to DB (non-blocking)
    supabase.from('chat_messages').insert([
      { session_id: sid, role: 'user', content: query, partner_id: null },
      { session_id: sid, role: 'assistant', content: reply, partner_id: null }
    ]).then(function(){}).catch(function(){});

  } catch (e) {
    console.error('[TG] error:', e.message);
  }
});

cron.schedule('30 13 * * *', async function() {
  var sid = await getActiveSessionId(); if (!sid) return;
  var date = new Date().toISOString().split('T')[0];
  var report = await generateEveningReport(sid, date);
  await sendReportToTelegram(report);
  enrichAllProducts(sid).catch(console.error);
});
cron.schedule('0 23 * * *', async function() {
  var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  var date = tomorrow.toISOString().split('T')[0];
  var sid  = await getActiveSessionId(date); if (!sid) return;
  var report = await generateMorningReport(sid, date);
  await sendReportToTelegram(report);
});

async function getActiveSessionId(date) {
  var d = date || new Date().toISOString().split('T')[0];
  var r = await supabase.from('fair_sessions').select('id').lte('start_date', d).gte('end_date', d).single();
  return r.data && r.data.id || null;
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, function() { console.log('Valeran API on port ' + PORT); });
module.exports = app;