'use strict';
var supabaseJs = require('@supabase/supabase-js');
var supabase = supabaseJs.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
var MODEL = 'claude-haiku-4-5-20251001';

function buildSystemPrompt() {
  var now = new Date();
  var sofiaTime = now.toLocaleString('en-GB', {timeZone:'Europe/Sofia', weekday:'short', day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'}) + ' (Sofia/Bulgaria time, UTC+2 summer UTC+3)';
  var chinaTime = new Date(now.getTime() + 8*3600000).toISOString().replace('T',' ').slice(0,16) + ' China time (UTC+8)';
  var days = Math.max(0, Math.round((new Date('2026-04-15T00:00:00+08:00') - now) / 86400000));
    'Team: Alexander Oslan (EN/owner/Sofia), Ina Kanaplianikava (RU), Konstantin Khoch (RU), Konstantin Ganev (BG), Slavi Mikinski (BG/remote). ' +
    'Margin target >35%. Landed cost = exworks x1.12freight x1.035duty + 15pct fees + 10pct ads. ' +
    'Sourcing: 1688 cheapest CN, Alibaba for export, AliPrice for reverse image. EU: Amazon DE/FR/UK, eMAG BG/RO. ' +
    'CE required for electronics/toys. RoHS. REACH for chemicals. Budget 500-5000 EUR per product. ' +
    'LANGUAGE RULE: detect input language, reply ONLY in same language. BG=BG RU=RU EN=EN. Never mix. Never use language prefix labels. ' +
    'CONTEXT RULE: [Context: ...] at start means the message being replied to. Use it fully. ' +
    'CURRENT TIME: ' + sofiaTime + ' | China: ' + chinaTime + '. Days until Canton Fair Phase 1: ' + days + '. ' +
    'TIME RULE: ALWAYS answer time questions in SOFIA/BULGARIA time first. Only mention China time if specifically asked. The team is based in Sofia, Bulgaria. ' +
    'WEB SEARCH: You have a live web_search tool. ALWAYS use it for: visa rules, regulations, prices, recent news, anything time-sensitive. Do NOT rely on training data for current facts like visa requirements — they change. ' +
    'Style: direct, practical, no fluff. Short in Telegram (2-3 sentences). Detailed on web when asked.';
}
var BASE_SYSTEM = buildSystemPrompt();

async function callAI(messages, system, maxTokens, timeoutMs, skipWebSearch) {
  var sys = (typeof system === 'string' && system) ? system : buildSystemPrompt();
  var ctrl = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, timeoutMs || 55000);

  async function doCall(withSearch) {
    var body = { model: 'claude-sonnet-4-6', tools: [{type: "web_search_20250305", name: "web_search"}], max_tokens: maxTokens || 1000, system: sys, messages: messages };
    var headers = { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
    if (withSearch) {
      body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
      headers['anthropic-beta'] = 'web-search-2025-03-05';
    }
    var r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok) { var e = await r.json().catch(function(){return {};}); console.error('[callAI]', r.status, JSON.stringify(e).slice(0,100)); return null; }
    var data = await r.json();
    var text = '';
    if (data.content) { for (var i = 0; i < data.content.length; i++) { if (data.content[i].type === 'text') text += data.content[i].text; } }
    return text.trim() || null;
  }

  try {
    var reply = skipWebSearch ? null : await doCall(true);
    if (!reply) reply = await doCall(false);
    clearTimeout(timer);
    return reply;
  } catch(e) {
    clearTimeout(timer);
    console.error('[callAI]', e.message);
    try { return await doCall(false); } catch(e2) { return null; }
  }
}

function isValeranCalled(text) {
  if (!text) return false;
  var t = text.toLowerCase().trim();
  return /^valeran/.test(t) || /^valera[,\s!?]/.test(t) || t.indexOf('\u0432\u0430\u043b\u0435\u0440\u0430') === 0;
}

async function loadMemory() {
  try {
    var r = await supabase.from('valeran_memory').select('memory_type, subject, content').eq('active', true).order('created_at', { ascending: true }).limit(50);
    if (!r.data || !r.data.length) return '';
    var rules = [], corrections = [], facts = [];
    for (var i = 0; i < r.data.length; i++) {
      var m = r.data[i];
      var line = (m.subject ? '[' + m.subject + '] ' : '') + m.content;
      if (m.memory_type === 'business_rule') rules.push(line);
      else if (m.memory_type === 'correction') corrections.push(line);
      else facts.push(line);
    }
    var parts = [];
    if (rules.length) parts.push('ACTIVE RULES: ' + rules.join(' | '));
    if (corrections.length) parts.push('CORRECTIONS (do NOT repeat these mistakes): ' + corrections.join(' | '));
    if (facts.length) parts.push('KNOWN FACTS: ' + facts.join(' | '));
    return parts.length ? ' === MEMORY === ' + parts.join(' === ') + ' ===' : '';
  } catch(e) { return ''; }
}

async function saveCorrection(content, partnerId, subject) {
  try {
    await supabase.from('valeran_memory').insert({ memory_type: 'correction', subject: subject || 'feedback', content: content, source: 'feedback', partner_id: partnerId || null, active: true });
  } catch(e) { console.error('[memory]', e.message); }
}

async function saveMessage(sessionId, role, content, partnerId, source, telegramUser) {
  // Strip language labels from assistant messages before saving
  if (role === 'assistant' && content) {
    content = content
      .replace(/^\*\*[A-Z]{2,3}\*\*[^\n]*\n*/gm, '')
      .replace(/^[A-Z]{2,3}:[^\n]*\n*/gm, '')
      .trim();
  }
  try {
    await supabase.from('chat_messages').insert({
      session_id: sessionId || 'team-chat',
      partner_id: partnerId || null,
      role: role,
      content: content,
      source: source || 'web',
      telegram_user: telegramUser || null
    });
  } catch(e) { console.error('[save]', e.message); }
}
async function getChatHistory(sessionId) {
  var sid = sessionId || 'team-chat';
  try {
    var r = await supabase.from('chat_messages').select('role, content, telegram_user').eq('session_id', sid).not('content', 'ilike', '__VALERAN_%').order('created_at', { ascending: false }).limit(12);
    return (r.data || []).reverse();
  } catch(e) { return []; }
}

async function extractEntities(text, partnerId, sessionId) {
  if (!text || text.length < 20) return;
  try {
    var prompt = 'Extract Canton Fair data from this message. Return ONLY valid JSON. Message: "' + text.slice(0, 400) + '" Return: {"has_supplier":false,"has_product":false,"supplier":{"name":null,"hall":null,"booth_number":null,"contact_person":null},"product":{"name":null,"buy_price_usd":null,"notes":null}}';
    var raw = await callAI([{ role: 'user', content: prompt }], 'Extract data, return only valid JSON.', 200, 8000);
    if (!raw) return;
    var data = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (data.has_supplier && data.supplier && data.supplier.name) {
      await supabase.from('suppliers').upsert({ name: data.supplier.name, hall: data.supplier.hall, booth_number: data.supplier.booth_number, contact_person: data.supplier.contact_person, session_id: sessionId, created_by: partnerId }, { onConflict: 'name', ignoreDuplicates: true });
    }
    if (data.has_product && data.product && data.product.name) {
      await supabase.from('products').insert({ product_name: data.product.name, buy_price_usd: data.product.buy_price_usd, notes: data.product.notes, session_id: sessionId, created_by: partnerId });
    }
  } catch(e) {}
}

async function processMessage(opts) {
  var text = opts.text;
  var partnerId = opts.partnerId;
  var sessionId = opts.sessionId || 'team-chat';
  var senderName = opts.senderName || null;
  if (!text) return { responded: false };
  var triggered = isValeranCalled(text);
  var isCorrection = /that.s wrong|wrong answer|incorrect|mistake|\u043d\u0435 \u0435 \u0432\u044f\u0440\u043d\u043e|\u0433\u0440\u0435\u0448\u043a\u0430|\u043d\u0435\u043f\u0440\u0430\u0432\u0438\u043b\u044c\u043d\u043e|\u043e\u0448\u0438\u0431\u043a\u0430/i.test(text);
  await saveMessage(sessionId, 'user', text, partnerId, 'web', senderName);
  if (isCorrection) {
    var corrText = text.replace(/^(valeran|valera)[,\s!?]*/i, '').trim();
    await saveCorrection('User correction: ' + corrText, partnerId, 'user_correction');
  }
  extractEntities(text, partnerId, sessionId).catch(function() {});
  if (!triggered) return { responded: false, silent: true };
  var memAndHistory = await Promise.all([loadMemory(), getChatHistory(sessionId)]);
  var memory = memAndHistory[0];
  var history = memAndHistory[1];
  var system = buildSystemPrompt() + memory;
  var query = text.replace(/^(valeran|valera|\u0432\u0430\u043b\u0435\u0440\u0430\u043d|\u0432\u0430\u043b\u0435\u0440\u0430)[,\s!?]*/i, '').trim() || text;
  var msgs = history.map(function(m) { return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }; });
  msgs.push({ role: 'user', content: query });
  var reply = await callAI(msgs, system, 700, 22000) || 'Sorry, having trouble connecting. Please try again.';
  await saveMessage(sessionId, 'assistant', reply, null, 'web', null);
  return { responded: true, reply: reply };
}

async function analyseCatalogue(content, supplierId, sessionId, uploadId) {
  // Auto-extract supplier name from catalogue content
  if (!supplierId) {
    try {
      var supPrompt = 'From this catalogue, extract only the company/supplier name. Return JSON: {"name":"Company Name"}. Content: ' + content.slice(0,600);
      var supRaw = await callAI([{role:'user',content:supPrompt}], 'Extract company name. Return only valid JSON.', 80, 6000);
      if (supRaw) {
        var supData = JSON.parse(supRaw.replace(/```json|```/g,'').trim());
        if (supData && supData.name && supData.name.length > 2) {
          var exSup = await supabase.from('suppliers').select('id').ilike('company_name', supData.name).limit(1);
          if (exSup.data && exSup.data.length) {
            supplierId = exSup.data[0].id;
          } else {
            var newSup = await supabase.from('suppliers').insert({company_name: supData.name, fair_session_id: null}).select('id').single();
            if (newSup.data) supplierId = newSup.data.id;
          }
        }
      }
    } catch(supErr) { console.error('[sup extract]', supErr.message); }
  }
  var prompt = 'You are a Canton Fair sourcing analyst. Analyse this supplier catalogue. Extract ALL products into a JSON array. Each product must have: name, description, price_usd (number or null), moq (min order qty, number or null), materials, certifications, notes. Return ONLY valid JSON array, no other text. Content: ' + content.slice(0, 5000);
  var raw = await callAI([{ role: 'user', content: prompt }], 'You are a product data extractor. Return only a valid JSON array.', 2000, 30000);
  var products = [];
  if (raw) {
    try { products = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
  }
  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    if (p && p.name) {
      await supabase.from('products').insert({ product_name: p.name, notes: [p.description, p.materials, p.notes].filter(Boolean).join(' | '), buy_price_usd: p.price_usd || null, supplier_id: supplierId || null, fair_session_id: null, category: 'Catalogue Import' }).catch(function() {});
    }
  }
  var summary = await callAI([{ role: 'user', content: 'Summarise this supplier catalogue for a Telegram group. Format: *SUPPLIER OVERVIEW* line, then • bullet points for top products with price ranges and MOQ where available, then • key advantages. Use *Bold* for section titles, • for bullets. Max 200 words. No ## headers, no language prefix labels. Content: ' + content.slice(0, 2000) }], buildSystemPrompt(), 200, 12000) || 'Catalogue analysed.';
  if (uploadId) {
    await supabase.from('catalogue_uploads').update({ analysis_status: 'done', products_extracted: products.length, summary: summary.slice(0,2000), supplier_id: supplierId || null }).eq('id', uploadId);
  }
  return { products: products, summary: summary, count: products.length };
}

async function generateEveningReport(sessionId, date) {
  var memory = await loadMemory();
  var system = buildSystemPrompt() + memory;
  var prods = await supabase.from('products').select('name, buy_price_usd, sell_price_eur, notes, category').eq('session_id', sessionId).gte('created_at', date).limit(15);
  var supps = await supabase.from('suppliers').select('name, hall, booth_number').eq('session_id', sessionId).gte('created_at', date).limit(10);
  var meets = await supabase.from('meetings').select('scheduled_at, notes').gte('scheduled_at', date).limit(8);
  var research = await supabase.from('product_research').select('product_name, platform, price_eur, rating').gte('created_at', date).limit(10);
  var prompt = 'Generate a structured EVENING REPORT for Synergy Ventures at Canton Fair 2026. Date: ' + date + '. Products logged: ' + JSON.stringify((prods.data||[]).slice(0,8)) + '. Suppliers visited: ' + JSON.stringify((supps.data||[]).slice(0,5)) + '. Tomorrow meetings: ' + JSON.stringify((meets.data||[]).slice(0,5)) + '. EU competitor research: ' + JSON.stringify((research.data||[]).slice(0,5)) + '. Structure: EMOJI DAY SUMMARY (numbers), EMOJI TOP PRODUCTS (top 3-5 with margin highlights), EMOJI SUPPLIER NOTES, EMOJI TOMORROW SCHEDULE, EMOJI ACTION ITEMS. Max 600 words.';
  var contentEn = await callAI([{ role: 'user', content: prompt }], system, 1200, 30000) || 'Report generation failed.';
  var contentBg = await callAI([{ role: 'user', content: 'Translate to Bulgarian keeping emojis and structure: ' + contentEn }], 'Translate accurately to Bulgarian.', 1200, 25000) || '';
  var r = await supabase.from('reports').insert({ type: 'evening', session_id: sessionId, content: JSON.stringify({ en: contentEn, bg: contentBg }), created_at: new Date().toISOString() }).select().single();
  return Object.assign({}, r.data || {}, { title: 'Evening Report - ' + date, content_en: contentEn, content_bg: contentBg });
}

async function generateMorningReport(sessionId, date) {
  var memory = await loadMemory();
  var system = buildSystemPrompt() + memory;
  var prods = await supabase.from('products').select('name, buy_price_usd, notes, category').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(10);
  var meets = await supabase.from('meetings').select('scheduled_at, notes').gte('scheduled_at', date).limit(8);
  var research = await supabase.from('product_research').select('product_name, platform, price_eur, rating').order('created_at', { ascending: false }).limit(8);
  var prompt = 'Generate a MORNING BRIEFING for Synergy Ventures at Canton Fair 2026. Date: ' + date + '. Products to follow up: ' + JSON.stringify((prods.data||[]).slice(0,6)) + '. Today meetings: ' + JSON.stringify(meets.data||[]) + '. Research findings: ' + JSON.stringify((research.data||[]).slice(0,5)) + '. Structure: EMOJI GOOD MORNING (date+phase), EMOJI PRIORITY FOLLOW-UPS (specific supplier questions), EMOJI TODAY AGENDA (each meeting with prep), EMOJI EXPLORE TODAY (halls/categories), EMOJI KEY INSIGHT. Max 500 words.';
  var contentEn = await callAI([{ role: 'user', content: prompt }], system, 1000, 30000) || 'Morning report failed.';
  var contentBg = await callAI([{ role: 'user', content: 'Translate to Bulgarian: ' + contentEn }], 'Translate accurately to Bulgarian.', 1000, 25000) || '';
  var r = await supabase.from('reports').insert({ type: 'morning', session_id: sessionId, content: JSON.stringify({ en: contentEn, bg: contentBg }), created_at: new Date().toISOString() }).select().single();
  return Object.assign({}, r.data || {}, { title: 'Morning Briefing - ' + date, content_en: contentEn, content_bg: contentBg });
}

module.exports = {
  processMessage: processMessage,
  generateEveningReport: generateEveningReport,
  generateMorningReport: generateMorningReport,
  isValeranCalled: isValeranCalled,
  callAI: callAI,
  saveMessage: saveMessage,
  loadMemory: loadMemory,
  saveCorrection: saveCorrection,
  analyseCatalogue: analyseCatalogue
};