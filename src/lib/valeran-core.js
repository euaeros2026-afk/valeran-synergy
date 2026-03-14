'use strict';
var supabaseJs = require('@supabase/supabase-js');
var supabase = supabaseJs.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
var MODEL = 'claude-haiku-4-5-20251001';

var BASE_SYSTEM = 'You are Valeran, the AI assistant for Synergy Ventures LLC-FZ at Canton Fair 2026 in Guangzhou, China. ' +
  'Company: Synergy Ventures sources products from Chinese manufacturers and sells in the EU via Shopify + Instagram/Facebook. Goal: max ROI. Any category, any product. ' +
  'Team: Alexander Oslan (owner, English), Ina Kanaplianikava (partner, Russian, at fair), Konstantin Khoch (partner, Russian, at fair), Konstantin Ganev (partner, Bulgarian, at fair), Slavi Mikinski (observer, Bulgarian, remote). ' +
  'Canton Fair 2026: Phase 1 Apr 15-19 (electronics, hardware, lighting), Phase 2 Apr 23-27 (home goods, furniture, gifts), Phase 3 May 1-5 (fashion, textiles, toys). Location: Pazhou Complex Guangzhou. April weather: 22-28C humid rain - bring umbrella. ' +
  'Margin formula: buy_usd x 0.92 = eur, x 1.12 freight, x 1.035 duty = landed. Net margin = (sell - landed - 15pct_fees - 10pct_ads) / sell. Target >35%. ' +
  'Sourcing: 1688 (cheapest), Alibaba (export), Taobao (CN retail), AliPrice (reverse image). EU: Amazon DE/UK/FR, eMAG Bulgaria/Romania. ' +
  'Compliance: CE (electronics/toys), RoHS (electronics), REACH (chemicals). Cost 500-5000 EUR per product. ' +
  'LANGUAGE RULE - ABSOLUTE: detect input language and reply in EXACT same language. Bulgarian in = Bulgarian out. Russian in = Russian out. English in = English out. NEVER mix. ' +'NEVER start your reply with a language label like "Bulgarian:", "Russian:", "English:" â just reply directly in the correct language. ' +
  'CONTEXT RULE: When message starts with [Context: ...] that is the replied-to message. USE IT FULLY. Never say you cannot see previous messages. ' +
  'TESTING MODE: Currently March 2026, testing before Canton Fair. Learn from all corrections. ' +
  'Personality: direct, confident, smart, practical. Max 200 words in Telegram unless full report. Can tell jokes.';

async function callAI(messages, system, maxTokens, timeoutMs) {
  maxTokens = maxTokens || 600;
  timeoutMs = timeoutMs || 22000;
  system = system || BASE_SYSTEM;
  var ctrl = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, timeoutMs);
  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: system, messages: messages }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    var d = await r.json();
    if (d.error) { console.error('[AI]', d.error.message); return null; }
    return d.content && d.content[0] && d.content[0].text || null;
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') { console.error('[AI] timeout'); return null; }
    console.error('[AI]', e.message);
    return null;
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
  try {
    await supabase.from('chat_messages').insert({ session_id: sessionId || 'default', partner_id: partnerId || null, role: role, content: content, source: source || 'web', telegram_user: telegramUser || null });
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
      await supabase.from('products').insert({ name: data.product.name, buy_price_usd: data.product.buy_price_usd, notes: data.product.notes, session_id: sessionId, created_by: partnerId });
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
  var system = BASE_SYSTEM + memory;
  var query = text.replace(/^(valeran|valera|\u0432\u0430\u043b\u0435\u0440\u0430\u043d|\u0432\u0430\u043b\u0435\u0440\u0430)[,\s!?]*/i, '').trim() || text;
  var msgs = history.map(function(m) { return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }; });
  msgs.push({ role: 'user', content: query });
  var reply = await callAI(msgs, system, 700, 22000) || 'Sorry, having trouble connecting. Please try again.';
  await saveMessage(sessionId, 'assistant', reply, null, 'web', null);
  return { responded: true, reply: reply };
}

async function analyseCatalogue(content, supplierId, sessionId, uploadId) {
  var prompt = 'Analyse this supplier catalogue from Canton Fair. Extract ALL products. Return a JSON array: [{"name":"...","description":"...","price_usd":null,"moq":null,"materials":"...","notes":"..."}]. Content: ' + content.slice(0, 5000);
  var raw = await callAI([{ role: 'user', content: prompt }], 'You are a product data extractor. Return only a valid JSON array.', 2000, 30000);
  var products = [];
  if (raw) {
    try { products = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {}
  }
  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    if (p && p.name) {
      await supabase.from('products').insert({ name: p.name, notes: [p.description, p.materials, p.notes].filter(Boolean).join(' | '), buy_price_usd: p.price_usd || null, supplier_id: supplierId || null, session_id: sessionId || 'default', category: 'Catalogue Import' }).catch(function() {});
    }
  }
  var summary = await callAI([{ role: 'user', content: 'Summarise this supplier catalogue in 3 sentences: ' + content.slice(0, 2000) }], BASE_SYSTEM, 200, 12000) || 'Catalogue analysed.';
  if (uploadId) {
    await supabase.from('catalogue_uploads').update({ analysis_status: 'done', products_extracted: products.length, summary: summary }).eq('id', uploadId);
  }
  return { products: products, summary: summary, count: products.length };
}

async function generateEveningReport(sessionId, date) {
  var memory = await loadMemory();
  var system = BASE_SYSTEM + memory;
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
  var system = BASE_SYSTEM + memory;
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