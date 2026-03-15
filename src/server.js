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


// Save a team message (no AI response) ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ for group chat between members
app.post('/api/chat/send', requireAuth, async function(req, res) {
  if (!req.body.text) return res.status(400).json({ error: 'No text' });
  var sid = 'team-chat';
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
  var sid = 'team-chat';
  try {
    var result = await core.processMessage({ text: req.body.text, partnerId: req.partner && req.partner.id, sessionId: sid });
    res.json({ reply: result.responded ? result.reply : null, session_id: sid, responded: result.responded });
  } catch(e) { res.json({ reply: 'Error ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ try again.', session_id: sid }); }
});

app.get('/api/chat/messages', requireAuth, async function(req, res) {
  var sid = 'team-chat';
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
    var sid = req.body.session_id || null;
    var upR = await supabase.from('catalogue_uploads').insert({ filename: req.file.originalname || 'file', supplier_id: req.body.supplier_id || null, session_id: sid, uploaded_by: req.partner && req.partner.id, analysis_status: 'processing' }).select().single();
    var uploadId = upR.data && upR.data.id;
    var fileMime = req.file.mimetype || '';
    var fileExt = (req.file.originalname||'').toLowerCase().split('.').pop();
    var isPdfUp = fileExt === 'pdf' || fileMime === 'application/pdf';
    var isImgUp = ['jpg','jpeg','png','gif','webp'].indexOf(fileExt) > -1 || fileMime.indexOf('image/') === 0;
    var fileText = req.file.buffer.toString('utf-8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
    if (fileText.trim().length < 20 && (isPdfUp || isImgUp)) {
      var b64up = req.file.buffer.toString('base64');
      var vMimeUp = isPdfUp ? 'application/pdf' : (fileMime || 'image/jpeg');
      var vBody = isPdfUp
        ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64up } }, { type: 'text', text: 'Analyse this supplier catalogue/document. Extract all products, prices, MOQ, contacts. Provide a structured summary.' }]
        : [{ type: 'image', source: { type: 'base64', media_type: vMimeUp, data: b64up } }, { type: 'text', text: 'This is a supplier catalogue image. Extract all visible products, prices, MOQ, and contacts.' }];
      if (uploadId) supabase.from('catalogue_uploads').update({ analysis_status: 'processing' }).eq('id', uploadId);
      fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: vBody }] }) })
        .then(function(vr) { return vr.json(); })
        .then(function(vd) {
          var vs = vd.content && vd.content[0] && vd.content[0].text || 'Could not extract content.';
          if (uploadId) supabase.from('catalogue_uploads').update({ analysis_status: 'done', summary: vs.slice(0,2000), products_extracted: 0 }).eq('id', uploadId);
          supabase.from('chat_messages').insert({ session_id: sid, role: 'assistant', content: ('📎 *'+(req.file.originalname||'file')+'*\n\n'+vs).slice(0,2000), source: 'web', telegram_user: 'Valeran' }).catch(function(){});
        })
        .catch(function(ve) { if (uploadId) supabase.from('catalogue_uploads').update({ analysis_status: 'failed', summary: ve.message }).eq('id', uploadId); });
      return res.json({ success: true, uploadId: uploadId, filename: req.file.originalname, message: 'Scanning with AI vision...' });
    }
    if (fileText.trim().length < 20) {
      if (uploadId) await supabase.from('catalogue_uploads').update({ analysis_status: 'failed', summary: 'Could not extract text.' }).eq('id', uploadId);
      return res.json({ success: false, message: 'Could not extract text.' });
    }
    res.json({ success: true, uploadId: uploadId, filename: req.file.originalname, message: 'Analysing...' });
    core.analyseCatalogue(fileText, req.body.supplier_id || null, sid, uploadId)
    .then(function(result) {
      var msg2 = '📎 *' + (req.file.originalname || 'file') + '* — ' + (result.count || 0) + ' products extracted.\n\n' + (result.summary || 'Analysis complete.');
      supabase.from('chat_messages').insert({ session_id: sid, role: 'assistant', content: msg2.slice(0,2000), source: 'web', telegram_user: 'Valeran' }).catch(function(){});
    })
    .catch(function(e) {
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
    var sid = req.body.session_id || (await getActiveSessionId()) || 'team-chat';
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
    var sid = req.body.session_id || (await getActiveSessionId()) || 'team-chat';
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
  if (req.query.search) q = q.ilike('company_name', '%' + req.query.search + '%');
  var r = await q; res.json(r.error ? { error: r.error } : { suppliers: r.data || [] });
});
app.get('/api/suppliers/:id', requireAuth, async function(req, res) {
  var s = await supabase.from('suppliers').select('*').eq('id', req.params.id).single();
  var p = await supabase.from('products').select('*').eq('supplier_id', req.params.id);
  res.json({ supplier: s.data, products: p.data || [] });
});
app.post('/api/suppliers', requireAuth, async function(req, res) {
  var r = await supabase.from('suppliers').insert(req.body).select().single();
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
  var r = await supabase.from('products').insert(req.body).select().single();
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
app.get('/api/stats', requireAuth, async function(req, res) {
  try {
    var [ps,ss,us] = await Promise.all([
      supabase.from('products').select('*', { count: 'exact', head: true }),
      supabase.from('suppliers').select('*', { count: 'exact', head: true }),
      supabase.from('catalogue_uploads').select('*', { count: 'exact', head: true })
    ]);
    res.json({ products: ps.count||0, suppliers: ss.count||0, uploads: us.count||0, meetings: 0 });
  } catch(e) { res.json({ products:0, suppliers:0, uploads:0, meetings:0 }); }
});

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

app.get('/api/debug/tg', async function(req, res) {
  var result = { steps: [] };
  try {
    result.steps.push('1_start');
    var sid = (await getActiveSessionId()) || 'team-chat';
    result.sid = sid;
    result.steps.push('2_sid='+sid);
    var memory = await core.loadMemory();
    supabase.from('chat_messages').insert({session_id:sid,role:'user',content:'TRACE1_memory_loaded',source:'telegram',telegram_user:'TRACE'});
    result.memLen = memory.length;
    result.steps.push('3_mem='+memory.length);
    var histR = await supabase.from('chat_messages').select('role,content').eq('session_id',sid).order('created_at',{ascending:false}).limit(3);
    result.histCount = (histR.data||[]).length;
    result.steps.push('4_hist='+result.histCount);
    var reply = await core.callAI([{role:'user',content:'Say CONFIRM in one word'}], TG_SYSTEM+memory, 50, 10000);
    result.reply = reply ? reply.slice(0,50) : null;
    result.steps.push('5_reply='+(reply?reply.slice(0,20):'NULL'));
    if (reply) {
      var saveR = await supabase.from('chat_messages').insert({session_id:sid,role:'assistant',content:'DEBUG_TG_TEST_'+Date.now(),source:'telegram',telegram_user:'Valeran'});
      result.saveError = saveR.error ? saveR.error.message : null;
      result.steps.push('6_save='+(saveR.error?saveR.error.message:'OK'));
    }
    res.json({ok:true, result:result});
  } catch(e) {
    res.json({ok:false, error:e.message, steps:result.steps});
  }
});

// ---- HELPERS ----
  'Team: Alexander (EN), Ina (RU), Konstantin Khoch (RU), Konstantin Ganev (BG), Slavi (BG). ' +
  'LANGUAGE: detect the language of the message and reply ONLY in that language. ONE language only per reply. Never reply in two languages. Never mix. BG message=BG reply only. RU message=RU reply only. EN message=EN reply only. ' +
  'STYLE: short and direct. 1-3 sentences for simple questions. No fluff. ' +
  'Use [Context:...] when present ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ that is what someone replied to.';

function cleanTG(s) {
  if (!s) return s;
  // Strip language label lines: **EN**, **EN** (for X), EN:, English: etc
  s = s.replace(/^\*\*(?:EN|BG|RU|English|Bulgarian|Russian)\*\*[^\n]*\n*/gim, '');
  s = s.replace(/^(?:EN|BG|RU|English|Bulgarian|Russian):[^\n]*\n*/gim, '');
  // Strip markdown HR separators (---)
  s = s.replace(/^---+\s*$/gm, '');
  // Convert markdown tables to plain list
  s = s.replace(/^\|.+\|\s*$/gm, function(row) {
    // Skip separator rows (|---|---|)
    if (/^\|[\s|:-]+\|$/.test(row)) return '';
    // Extract cells
    var cells = row.split('|').map(function(c){return c.trim();}).filter(function(c){return c.length > 0;});
    return cells.join(' • ');
  });
  // Convert ## headers to *BOLD*
  s = s.replace(/^#{1,6}\s+(.+)/gm, function(_, t) { return '\n*' + t.trim() + '*'; });
  // Convert **bold** to *bold* (Telegram format)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  // Normalise bullet points
  s = s.replace(/^[\s]*[-*\u2022\u2013]\s+/gm, '\u2022 ');
  // Collapse excessive blank lines
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
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
// For documents: takes 10-20s ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Telegram retries after 5s (harmless).
// For text: takes 3-5s ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ within Telegram's window.

app.post('/api/telegram/webhook', async function(req, res) {
app.post('/api/telegram/webhook', async function(req, res) {
  var update = req.body;
  var msg = update.message || update.edited_message || update.channel_post;

  // Always respond 200 to Telegram immediately (Telegram requires < 5s response)
  res.status(200).json({ok: true});

  // No message or bot message — nothing to do
  if (!msg || !msg.text || (msg.from && msg.from.is_bot)) return;

  var chatId = msg.chat.id;
  var userText = msg.text;
  var fromName = msg.from ? (msg.from.first_name || msg.from.username || 'User') : 'User';
  var sessionId = 'tg-' + chatId;

  // Process asynchronously — Vercel keeps function alive (maxDuration:60 in vercel.json)
  try {
    // Send "typing" indicator
    await tgSend(chatId, null, 'typing');

    // Load conversation history from DB
    var historyRows = [];
    try {
      var hResp = await fetch(process.env.SUPABASE_URL + '/rest/v1/chat_messages?session_id=eq.' + sessionId + '&order=created_at.asc&limit=20', {
        headers: {'apikey': process.env.SUPABASE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_KEY}
      });
      if (hResp.ok) {
        var hData = await hResp.json();
        historyRows = Array.isArray(hData) ? hData : [];
      }
    } catch(e) { /* history optional */ }

    var history = historyRows.map(function(r) { return {role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content}; });

    // Call Valeran AI via core.processMessage
    var reply = await core.processMessage({
      text: userText,
      fromName: fromName,
      sessionId: sessionId,
      history: history,
      source: 'telegram'
    });

    if (!reply) reply = 'Извините, не удалось получить ответ.';

    // Save user message to DB
    try {
      await fetch(process.env.SUPABASE_URL + '/rest/v1/chat_messages', {
        method: 'POST',
        headers: {'apikey': process.env.SUPABASE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal'},
        body: JSON.stringify({session_id: sessionId, role: 'user', content: userText, source: 'telegram', telegram_user: fromName})
      });
    } catch(e) { /* non-fatal */ }

    // Save assistant reply to DB
    try {
      await fetch(process.env.SUPABASE_URL + '/rest/v1/chat_messages', {
        method: 'POST',
        headers: {'apikey': process.env.SUPABASE_KEY, 'Authorization': 'Bearer ' + process.env.SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal'},
        body: JSON.stringify({session_id: sessionId, role: 'assistant', content: reply, source: 'telegram'})
      });
    } catch(e) { /* non-fatal */ }

    // Send reply to Telegram
    await tgSend(chatId, reply);

  } catch(err) {
    console.error('TG handler error:', err && err.message ? err.message : err);
    try { await tgSend(chatId, 'Произошла ошибка. Попробуйте ещё раз.'); } catch(_) {}
  }
});
// ---- PROCESS-TG ----
app.post('/api/process-tg', async function(req, res) {
  var { query, from, chatId, msgId, sid } = req.body || {};
  if (!query || !chatId) { res.sendStatus(200); return; }
  try {
    var memory = await core.loadMemory();
    var histR = await supabase.from('chat_messages')
      .select('role,content').eq('session_id', sid)
      .order('created_at', { ascending: false }).limit(10);
    var history = (histR.data || []).reverse();
    var msgs = history.map(function(m) {
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
    });
    msgs.push({ role: 'user', content: from + ': ' + query });
    var reply = await core.callAI(msgs, TG_SYSTEM + memory, 400, 4000);
    if (reply) {
      reply = cleanTG(reply);
      await tgSend(chatId, reply, msg.message_id);
      await supabase.from('chat_messages').insert([
        { session_id: sid, role: 'user', content: from + ': ' + query, source: 'telegram', telegram_user: from },
        { session_id: sid, role: 'assistant', content: reply, source: 'telegram', telegram_user: 'Valeran' }
      ]);
    }
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