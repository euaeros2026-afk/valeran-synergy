// ============================================================
// VALERAN AI CORE — Memory-aware, context-rich, multilingual
// Key fixes: uses chat_messages table, loads valeran_memory,
// saves all conversations, learns from corrections
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

// ============================================================
// BASE SYSTEM PROMPT (static knowledge)
// ============================================================
const BASE_SYSTEM = `You are Valeran — the AI assistant and field intelligence system for Synergy Ventures LLC-FZ.

COMPANY: Synergy Ventures sources products from Chinese manufacturers at Canton Fair and sells in EU via Shopify + Instagram/Facebook. Goal: maximum ROI on capital. Any category, any product — if numbers work, it's worth it.

TEAM:
- Alexander Oslan (owner, English, Dubai)
- Ina Kanaplianikava (partner, Russian, at fair)
- Konstantin Khoch (partner, Russian, at fair)
- Konstantin Ganev (partner, Bulgarian, at fair)
- Slavi Mikinski (observer, Bulgarian, remote — needs full BG translations)

CANTON FAIR 2026:
- Phase 1: Apr 15-19 — Electronics, lighting, hardware, machinery, smart home, tools
- Phase 2: Apr 23-27 — Home goods, ceramics, furniture, garden, gifts, office
- Phase 3: May 1-5 — Fashion, textiles, toys, personal care, food, accessories
- Location: Pazhou Complex, Guangzhou. April weather: 22-28C, humid, frequent rain.

MARGIN FORMULA (always show breakdown when asked):
  Landed cost = factory_price_eur x 1.12 (freight) x 1.035 (avg duty)
  Net margin % = (sell_price - landed_cost - platform_fees_15pct - ads_10pct) / sell_price x 100
  Target: >35% net margin. Example: buy $4 = €3.65, landed = €4.24, sell €18, fees €4.50 → margin 51% ✅

SCORING (1-5 each): category attractiveness, product demand, competition difficulty, sourcing feasibility, margin quality.

COMPLIANCE FLAGS: CE (electronics/toys), RoHS (electronics), REACH (chemicals). Cost €500-5000 per product. Always mention for relevant categories.

PLATFORMS: 1688 (cheapest, domestic CN), Alibaba (export), Taobao (CN retail), AliPrice (reverse image search), Amazon DE/UK/FR, eMAG (BG/RO).

LANGUAGE RULE — ABSOLUTE: Detect input language. Reply in EXACT same language. Bulgarian in → Bulgarian out. Russian in → Russian out. English in → English out. Never mix. Never apologize for a language.

REPLY CONTEXT RULE: When message starts with [Context: ...] — that IS the content being replied to. Use it fully. Never say you cannot see previous messages.

PERSONALITY: Direct, confident, smart. Practical recommendations, not endless "it depends". Can be funny. Max 200 words in Telegram unless full report requested.`;

// ============================================================
// AI CALL
// ============================================================
async function callAI(messages, system, maxTokens, timeoutMs) {
  maxTokens = maxTokens || 600;
  timeoutMs = timeoutMs || 22000;
  system = system || BASE_SYSTEM;
  var ctrl = new AbortController();
  var timer = setTimeout(function(){ ctrl.abort(); }, timeoutMs);
  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: system, messages: messages }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    var d = await r.json();
    if (d.error) { console.error('[AI] error:', d.error.message); return null; }
    return d.content && d.content[0] && d.content[0].text || null;
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') { console.error('[AI] timeout'); return null; }
    console.error('[AI] fetch error:', e.message);
    return null;
  }
}

// ============================================================
// LOAD MEMORY (active facts, rules, corrections from DB)
// ============================================================
async function loadMemory() {
  try {
    var r = await supabase.from('valeran_memory').select('memory_type, subject, content').eq('active', true).order('created_at', { ascending: true }).limit(50);
    if (!r.data || r.data.length === 0) return '';
    var sections = { correction: [], preference: [], fact: [], business_rule: [], partner_profile: [] };
    r.data.forEach(function(m) {
      var key = m.memory_type || 'fact';
      if (sections[key]) sections[key].push((m.subject ? '[' + m.subject + '] ' : '') + m.content);
    });
    var parts = [];
    if (sections.business_rule.length) parts.push('ACTIVE RULES:\n' + sections.business_rule.join('\n'));
    if (sections.correction.length) parts.push('CORRECTIONS (things I got wrong before — do NOT repeat):\n' + sections.correction.join('\n'));
    if (sections.fact.length) parts.push('KNOWN FACTS:\n' + sections.fact.join('\n'));
    if (sections.preference.length) parts.push('TEAM PREFERENCES:\n' + sections.preference.join('\n'));
    if (sections.partner_profile.length) parts.push('PARTNER INFO:\n' + sections.partner_profile.join('\n'));
    return parts.length ? '\n\n=== VALERAN MEMORY (loaded from DB) ===\n' + parts.join('\n\n') + '\n===' : '';
  } catch(e) {
    console.error('[memory] load error:', e.message);
    return '';
  }
}

// ============================================================
// SAVE CORRECTION / FEEDBACK
// ============================================================
async function saveCorrection(content, partnerId, subject) {
  try {
    await supabase.from('valeran_memory').insert({
      memory_type: 'correction',
      subject: subject || 'user_feedback',
      content: content,
      source: 'feedback',
      partner_id: partnerId || null,
      active: true
    });
    console.log('[memory] correction saved:', content.slice(0,60));
  } catch(e) {
    console.error('[memory] save error:', e.message);
  }
}

// ============================================================
// DETECT CORRECTION IN MESSAGE
// ============================================================
function detectCorrection(text) {
  var lower = text.toLowerCase();
  var correctionPhrases = [
    'that is wrong', 'thats wrong', 'you are wrong', 'incorrect', 'that\'s not right',
    'wrong answer', 'you got it wrong', 'mistake', 'that was wrong',
    'не е вярно', 'грешно е', 'грешка', 'не е правилно',
    'неправильно', 'ошибка', 'это неверно', 'не так'
  ];
  return correctionPhrases.some(function(p){ return lower.indexOf(p) > -1; });
}

// ============================================================
// GET CONVERSATION HISTORY
// ============================================================
async function getChatHistory(sessionId, limit) {
  limit = limit || 12;
  try {
    var r = await supabase.from('chat_messages').select('role, content')
      .eq('session_id', sessionId)
      .not('content', 'ilike', '__VALERAN_%')
      .order('created_at', { ascending: false })
      .limit(limit);
    return (r.data || []).reverse();
  } catch(e) {
    console.error('[history] load error:', e.message);
    return [];
  }
}

// ============================================================
// SAVE MESSAGE TO DB
// ============================================================
async function saveMessage(sessionId, role, content, partnerId, source, telegramUser) {
  try {
    await supabase.from('chat_messages').insert({
      session_id: sessionId || 'default',
      partner_id: partnerId || null,
      role: role,
      content: content,
      source: source || 'web',
      telegram_user: telegramUser || null
    });
  } catch(e) {
    console.error('[save] message error:', e.message);
  }
}

// ============================================================
// DETECT VALERAN TRIGGER
// ============================================================
function isValeranCalled(text) {
  if (!text) return false;
  var t = text.toLowerCase().trim();
  return /^valeran/.test(t) || /^valera[,\s!?]/.test(t) ||
         t.startsWith('\u0432\u0430\u043b\u0435\u0440\u0430\u043d') ||
         t.startsWith('\u0432\u0430\u043b\u0435\u0440\u0430');
}

// ============================================================
// PROCESS MESSAGE (web app)
// ============================================================
async function processMessage(opts) {
  var text = opts.text;
  var partnerId = opts.partnerId;
  var sessionId = opts.sessionId || 'default';

  if (!text) return { responded: false };

  var triggered = isValeranCalled(text);
  var isCorrection = detectCorrection(text);

  // Save user message
  await saveMessage(sessionId, 'user', text, partnerId, 'web', null);

  // If it's a correction, save to memory
  if (isCorrection) {
    var correctionText = text.replace(/^(valeran|valera)[,\s!?]*/i, '').trim();
    await saveCorrection('User said: ' + correctionText, partnerId, 'user_correction');
  }

  // Background entity extraction
  extractEntities(text, partnerId, sessionId).catch(function(){});

  if (!triggered) return { responded: false, silent: true };

  // Load memory + history in parallel
  var memoryAndHistory = await Promise.all([loadMemory(), getChatHistory(sessionId)]);
  var memory = memoryAndHistory[0];
  var history = memoryAndHistory[1];

  var system = BASE_SYSTEM + memory;
  var query = text.replace(/^(valeran|valera|\u0432\u0430\u043b\u0435\u0440\u0430\u043d|\u0432\u0430\u043b\u0435\u0440\u0430)[,\s!?]*/i, '').trim() || text;

  var messages = history.map(function(m){ return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }; });
  messages.push({ role: 'user', content: query });

  var reply = await callAI(messages, system, 700, 22000) || 'Sorry, having trouble connecting. Please try again.';

  await saveMessage(sessionId, 'assistant', reply, null, 'web', null);

  return { responded: true, reply: reply };
}

// ============================================================
// BACKGROUND ENTITY EXTRACTION
// ============================================================
async function extractEntities(text, partnerId, sessionId) {
  if (!text || text.length < 20) return;
  try {
    var prompt = 'Extract Canton Fair supplier/product data from this message. Return ONLY valid JSON.\nMessage: "' + text.slice(0,400) + '"\nReturn: {"has_supplier":false,"has_product":false,"supplier":{"name":null,"hall":null,"booth_number":null,"contact_person":null,"wechat":null},"product":{"name":null,"buy_price_usd":null,"notes":null}}';
    var raw = await callAI([{ role: 'user', content: prompt }], 'Extract data, return only valid JSON, no explanation.', 250, 8000);
    if (!raw) return;
    var data = JSON.parse(raw.replace(/```json|```/g,'').trim());
    if (data.has_supplier && data.supplier && data.supplier.name) {
      await supabase.from('suppliers').upsert({ name: data.supplier.name, hall: data.supplier.hall, booth_number: data.supplier.booth_number, contact_person: data.supplier.contact_person, wechat: data.supplier.wechat, session_id: sessionId, created_by: partnerId }, { onConflict: 'name', ignoreDuplicates: true });
    }
    if (data.has_product && data.product && data.product.name) {
      await supabase.from('products').insert({ name: data.product.name, buy_price_usd: data.product.buy_price_usd, notes: data.product.notes, session_id: sessionId, created_by: partnerId });
    }
  } catch(e) {}
}

// ============================================================
// ANALYSE CATALOGUE (PDF/text content)
// ============================================================
async function analyseCatalogue(content, supplierId, sessionId, uploadId) {
  var prompt = `You are analysing a supplier catalogue from Canton Fair. Extract ALL products with their details.
Catalogue content:
${content.slice(0, 6000)}

Return a JSON array of products:
[{"name":"...","description":"...","price_usd":null,"moq":null,"materials":"...","dimensions":"...","certifications":"...","notes":"..."}]
Include every product you can find. Return ONLY the JSON array.`;

  var raw = await callAI([{ role: 'user', content: prompt }], 'You are a product data extractor. Return only valid JSON arrays.', 2000, 30000);
  if (!raw) return { products: [], summary: 'Analysis failed' };

  var products = [];
  try {
    products = JSON.parse(raw.replace(/```json|```/g,'').trim());
  } catch(e) {
    console.error('[catalogue] parse error:', e.message);
  }

  // Save extracted products to DB
  for (var p of products) {
    if (p.name) {
      await supabase.from('products').insert({
        name: p.name, notes: [p.description, p.materials, p.certifications].filter(Boolean).join(' | '),
        buy_price_usd: p.price_usd || null, supplier_id: supplierId || null,
        session_id: sessionId || 'default', category: 'Catalogue Import'
      }).then(function(){}).catch(function(){});
    }
  }

  var summary = await callAI([{ role: 'user', content: 'Summarise this supplier catalogue in 3 sentences, note key product categories, price range, and quality impression:\n' + content.slice(0,3000) }], BASE_SYSTEM, 300, 15000) || 'Catalogue analysed.';

  // Update upload record
  if (uploadId) {
    await supabase.from('catalogue_uploads').update({ analysis_status: 'done', products_extracted: products.length, summary: summary, raw_analysis: { products: products.slice(0,50) } }).eq('id', uploadId);
  }

  return { products, summary, count: products.length };
}

// ============================================================
// GENERATE EVENING REPORT
// ============================================================
async function generateEveningReport(sessionId, date) {
  var memory = await loadMemory();
  var system = BASE_SYSTEM + memory;
  var products = await supabase.from('products').select('name, buy_price_usd, sell_price_eur, margin_pct, notes, category').eq('session_id', sessionId).gte('created_at', date).order('created_at', { ascending: false }).limit(15);
  var suppliers = await supabase.from('suppliers').select('name, hall, booth_number, contact_person').eq('session_id', sessionId).gte('created_at', date).limit(10);
  var meetings = await supabase.from('meetings').select('scheduled_at, notes').gte('scheduled_at', date).limit(8);
  var research = await supabase.from('product_research').select('product_name, platform, price_eur, rating, top_complaints').gte('created_at', date).limit(10);

  var prompt = 'Generate a structured EVENING REPORT for Synergy Ventures at Canton Fair 2026.\n' +
    'Date: ' + date + '\n' +
    'Products logged: ' + JSON.stringify((products.data||[]).slice(0,8)) + '\n' +
    'Suppliers visited: ' + JSON.stringify((suppliers.data||[]).slice(0,5)) + '\n' +
    'Tomorrow meetings: ' + JSON.stringify((meetings.data||[]).slice(0,5)) + '\n' +
    'EU competitor data: ' + JSON.stringify((research.data||[]).slice(0,5)) + '\n\n' +
    'STRUCTURE:\n📊 DAY SUMMARY — numbers\n🏆 TOP PRODUCTS — top 3-5 with margin analysis and EU competitor comparison\n🏭 SUPPLIER HIGHLIGHTS\n📅 TOMORROW — schedule and talking points\n⚡ ACTION ITEMS\n\nMax 600 words. Be specific and actionable.';

  var contentEn = await callAI([{ role: 'user', content: prompt }], system, 1200, 30000) || 'Report generation failed.';
  var contentBg = await callAI([{ role: 'user', content: 'Преведи на български, запази емоджитата и форматирането:\n\n' + contentEn }], 'Превеждай точно на български.', 1200, 25000) || '';

  var r = await supabase.from('reports').insert({ type: 'evening', session_id: sessionId, content: JSON.stringify({ en: contentEn, bg: contentBg }), created_at: new Date().toISOString() }).select().single();
  return Object.assign({}, r.data || {}, { title: '📊 Evening Report · ' + date, content_en: contentEn, content_bg: contentBg });
}

// ============================================================
// GENERATE MORNING REPORT
// ============================================================
async function generateMorningReport(sessionId, date) {
  var memory = await loadMemory();
  var system = BASE_SYSTEM + memory;
  var products = await supabase.from('products').select('name, buy_price_usd, sell_price_eur, margin_pct, notes, category').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(10);
  var meetings = await supabase.from('meetings').select('scheduled_at, notes').gte('scheduled_at', date).limit(8);
  var research = await supabase.from('product_research').select('product_name, platform, price_eur, rating, top_complaints, top_praises').order('created_at', { ascending: false }).limit(8);

  var prompt = 'Generate a MORNING BRIEFING for Synergy Ventures at Canton Fair 2026.\n' +
    'Date: ' + date + '\n' +
    'Products to follow up: ' + JSON.stringify((products.data||[]).slice(0,6)) + '\n' +
    'Today meetings: ' + JSON.stringify(meetings.data||[]) + '\n' +
    'Overnight research findings: ' + JSON.stringify((research.data||[]).slice(0,5)) + '\n\n' +
    'STRUCTURE:\n🌅 GOOD MORNING — date + phase\n🎯 PRIORITY FOLLOW-UPS — specific questions to ask each supplier\n📅 TODAY AGENDA — each meeting with prep notes and key questions\n🔍 EXPLORE TODAY — specific halls/categories worth visiting\n💡 OVERNIGHT INSIGHT — key finding from EU/CN research\n\nMax 500 words. Be specific.';

  var contentEn = await callAI([{ role: 'user', content: prompt }], system, 1000, 30000) || 'Morning briefing failed.';
  var contentBg = await callAI([{ role: 'user', content: 'Преведи на български:\n\n' + contentEn }], 'Превеждай точно на български.', 1000, 25000) || '';

  var r = await supabase.from('reports').insert({ type: 'morning', session_id: sessionId, content: JSON.stringify({ en: contentEn, bg: contentBg }), created_at: new Date().toISOString() }).select().single();
  return Object.assign({}, r.data || {}, { title: '🌅 Morning Briefing · ' + date, content_en: contentEn, content_bg: contentBg });
}

module.exports = { processMessage, generateEveningReport, generateMorningReport, isValeranCalled, callAI, saveMessage, loadMemory, saveCorrection, analyseCatalogue };
