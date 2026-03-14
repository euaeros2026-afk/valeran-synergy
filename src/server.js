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
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 20, messages: [{ role: 'user', content: 'Say ONLINE' }] })
    });
    var d = await r.json();
    res.json({ status: r.status, reply: d.content && d.content[0] && d.content[0].text, error: d.error, keyPrefix: (process.env.ANTHROPIC_API_KEY||'').slice(0,20)+'...' });
  } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/chat/message', requireAuth, async function(req, res) {
  if (!req.body.text) return res.status(400).json({ error: 'No text' });
  var sid = req.body.session_id || await getActiveSessionId() || 'default';
  try {
    var result = await processMessage({ text: req.body.text, partnerId: req.partner && req.partner.id, sessionId: sid });
    res.json({ reply: result.reply || 'Message noted.', session_id: sid, responded: result.responded });
  } catch (e) { res.json({ reply: 'Error — try again.', session_id: sid }); }
});

app.get('/api/chat/messages', requireAuth, async function(req, res) {
  var sid = req.query.session_id || await getActiveSessionId() || 'default';
  var r = await supabase.from('chat_messages').select('*').eq('session_id', sid)
    .not('content', 'eq', '__VALERAN_WELCOME_SENT__').order('created_at', { ascending: true }).limit(60);
  res.json(r.error ? { error: r.error } : { messages: r.data || [] });
});

app.post('/api/chat/photo', requireAuth, upload.single('photo'), async function(req, res) {
  try {
    var sid = req.body.session_id || await getActiveSessionId() || 'default';
    if (!req.file) return res.status(400).json({ error: 'No photo' });
    var labels = [];
    try {
      var vr = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + process.env.GOOGLE_API_KEY, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ image: { content: req.file.buffer.toString('base64') }, features: [{ type: 'LABEL_DETECTION', maxResults: 8 }] }] })
      });
      var vd = await vr.json();
      labels = (vd.responses && vd.responses[0] && vd.responses[0].labelAnnotations || []).map(function(l){return l.description;});
    } catch(e) {}
    var q = 'Valeran, ' + ([req.body.caption, labels.length ? 'Product: '+labels.join(', ') : ''].filter(Boolean).join('. ') || 'Photo from Canton Fair');
    var result = await processMessage({ text: q, partnerId: req.partner && req.partner.id, sessionId: sid, messageType: 'photo' });
    res.json({ reply: result.reply || 'Photo logged.', visionLabels: labels, session_id: sid });
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
        body: JSON.stringify({ audio: { content: req.file.buffer.toString('base64') }, config: { encoding: 'WEBM_OPUS', sampleRateHertz: 48000, languageCode: 'en-US', alternativeLanguageCodes: ['ru-RU','bg-BG'] } })
      });
      var sd = await sr.json();
      transcript = (sd.results||[]).map(function(r){return r.alternatives[0].transcript;}).join(' ');
    } catch(e) {}
    if (!transcript) return res.status(400).json({ error: 'No transcript' });
    var result = await processMessage({ text: transcript, partnerId: req.partner && req.partner.id, sessionId: sid, messageType: 'voice' });
    res.json({ reply: result.reply || 'Voice noted.', transcript: transcript, session_id: sid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/suppliers', requireAuth, async function(req, res) {
  var q = supabase.from('suppliers').select('*').order('created_at', { ascending: false }).limit(parseInt(req.query.limit)||50);
  if (req.query.search) q = q.ilike('name', '%'+req.query.search+'%');
  var r = await q; res.json(r.error ? { error: r.error } : { suppliers: r.data||[] });
});
app.get('/api/suppliers/:id', requireAuth, async function(req, res) {
  var s = await supabase.from('suppliers').select('*').eq('id', req.params.id).single();
  var p = await supabase.from('products').select('*').eq('supplier_id', req.params.id);
  res.json({ supplier: s.data, products: p.data||[] });
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
app.post('/api/search', requireAuth, upload.single('image'), async function(req, res) {
  var results = { internal: [] };
  if (req.body.query) { var r = await supabase.from('products').select('*').ilike('name','%'+req.body.query+'%').limit(10); results.internal = r.data||[]; }
  res.json(results);
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
  if (!sid) return res.status(400).json({ error: 'No session' });
  try {
    var report = req.body.type === 'evening' ? await generateEveningReport(sid, d) : await generateMorningReport(sid, d);
    await sendReportToTelegram(report);
    res.json({ report: report });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/welcome', requireAuth, async function(req, res) { res.json(await sendWelcomeMessage()); });
app.get('/api/partners', requireAuth, async function(req, res) {
  var r = await supabase.from('partner_profiles').select('id, name, role, at_fair, language, email');
  res.json(r.error ? { error: r.error } : { partners: r.data||[] });
});

// ============================================================
// TELEGRAM WEBHOOK
// FIX 1: Runs AI BEFORE res.sendStatus(200) — keeps Vercel alive
// FIX 2: Includes reply_to_message context so Valeran sees
//        what message someone replied to
// ============================================================
app.post('/api/telegram/webhook', async function(req, res) {
  var body = req.body;
  var msg  = (body && body.message) || (body && body.channel_post) || (body && body.edited_message);
  var text = (msg && msg.text && msg.text.trim()) || '';

  if (!msg || !text) { res.sendStatus(200); return; }

  var isReply   = !!(msg.reply_to_message && msg.reply_to_message.from);
  var isMention = text.indexOf('@ValeranSV_bot') > -1;
  var isPrefix  = /^valeran/i.test(text) || /^valera[,\s]/i.test(text) || /^\u0432\u0430\u043b\u0435\u0440\u0430/i.test(text);

  if (!isPrefix && !isMention && !isReply) { res.sendStatus(200); return; }

  try {
    var from   = (msg.from && msg.from.first_name) || 'Partner';
    var chatId = msg.chat.id;
    var sid    = await getActiveSessionId() || 'default';

    // Build the query — include reply context if present
    // This is the KEY FIX: when Ina replies to a message, we pass BOTH
    // the original message AND Ina's request so Valeran has full context
    var query = text.replace(/@ValeranSV_bot/gi,'').replace(/^(valeran|valera|\u0432\u0430\u043b\u0435\u0440\u0430\u043d|\u0432\u0430\u043b\u0435\u0440\u0430)[,\s!?]*/i,'').trim();
    if (!query) query = 'Hello';

    // If replying to another message, prepend that context
    var replyCtx = '';
    if (msg.reply_to_message && msg.reply_to_message.text) {
      var replyFrom = (msg.reply_to_message.from && msg.reply_to_message.from.first_name) || 'someone';
      // Don't re-process if it's a reply to Valeran's own message
      var isReplyToValeran = msg.reply_to_message.from && msg.reply_to_message.from.is_bot;
      replyCtx = isReplyToValeran
        ? '[Context: you previously said: "' + msg.reply_to_message.text.slice(0,300) + '"]'
        : '[Context: ' + replyFrom + ' said: "' + msg.reply_to_message.text.slice(0,300) + '"]';
      query = replyCtx + '\n\n' + from + ' asks: ' + query;
    }

    console.log('[TG] ' + from + ': ' + query.slice(0,80));

    var system = [
      'You are Valeran — the AI assistant for Synergy Ventures at Canton Fair 2026 in Guangzhou, China.',
      'You are in the team Telegram group. You are replying to ' + from + '.',
      '',
      'TEAM (know them by name):',
      '- Alexander Oslan: owner/founder, speaks English',
      '- Ina Kanaplianikava: partner, at the fair, speaks Russian',
      '- Konstantin Khoch: partner, at the fair, speaks Russian',
      '- Konstantin Ganev: partner, at the fair, speaks Bulgarian',
      '- Slavi Mikinski: remote observer, speaks Bulgarian',
      '',
      'LANGUAGE RULE (CRITICAL): Detect the language of the incoming message and reply in that EXACT language.',
      'If message is in Bulgarian -> reply in Bulgarian.',
      'If message is in Russian -> reply in Russian.',
      'If message is in English -> reply in English.',
      'Never mix languages in one reply.',
      '',
      'CONTEXT RULE: When you see [Context: ...] at the start of a message, that is the message being replied to.',
      'Use that context to give a relevant answer. Never say you cannot see previous messages if context is provided.',
      '',
      'PERSONALITY: Direct, smart, practical. You know sourcing, margins, Chinese manufacturing, EU e-commerce.',
      'You can also help with: translations, weather, jokes, general questions — anything the team needs.',
      '',
      'FORMAT: Max 200 words. Use bullet points only when listing multiple items. No unnecessary preamble.'
    ].join(' ');

    var reply = await callAI([{ role: 'user', content: query }], system, 600, 18000);
    if (!reply) { console.error('[TG] AI returned null'); res.sendStatus(200); return; }

    await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply, reply_to_message_id: msg.message_id, parse_mode: 'Markdown' })
    });
    console.log('[TG] replied to ' + from + ': ' + reply.slice(0,60));

    supabase.from('chat_messages').insert([
      { session_id: sid, role: 'user', content: query, partner_id: null },
      { session_id: sid, role: 'assistant', content: reply, partner_id: null }
    ]).then(function(){}).catch(function(){});

  } catch (e) { console.error('[TG] error:', e.message); }

  res.sendStatus(200);
});

cron.schedule('30 13 * * *', async function() {
  var sid = await getActiveSessionId(); if (!sid) return;
  var report = await generateEveningReport(sid, new Date().toISOString().split('T')[0]);
  await sendReportToTelegram(report);
  enrichAllProducts(sid).catch(console.error);
});
cron.schedule('0 23 * * *', async function() {
  var t = new Date(); t.setDate(t.getDate()+1);
  var d = t.toISOString().split('T')[0];
  var sid = await getActiveSessionId(d); if (!sid) return;
  await sendReportToTelegram(await generateMorningReport(sid, d));
});

async function getActiveSessionId(date) {
  var d = date || new Date().toISOString().split('T')[0];
  var r = await supabase.from('fair_sessions').select('id').lte('start_date',d).gte('end_date',d).single();
  return r.data && r.data.id || null;
}

app.listen(process.env.PORT || 3001, function() { console.log('Valeran online'); });
module.exports = app;