// ============================================================
// VALERAN AI CORE — Smart, context-aware, multilingual
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

// ============================================================
// VALERAN SYSTEM PROMPT
// ============================================================
const VALERAN_SYSTEM = `You are Valeran — the AI assistant and field intelligence system for Synergy Ventures LLC-FZ at Canton Fair 2026 in Guangzhou, China.

COMPANY BACKGROUND:
Synergy Ventures sources products from Chinese manufacturers and sells into the EU via Shopify and social media (Instagram/Facebook). The business model: find any product in any category that generates strong ROI. The team identifies products at Canton Fair, validates them against EU market demand, calculates margins, and decides what to import.

YOUR DUAL ROLE:
1. Smart business partner — you understand Chinese manufacturing, EU e-commerce, import costs, compliance
2. Personal assistant — you help with anything: translations, jokes, weather, calculations, research, scheduling

THE TEAM (you know them personally):
- Alexander Oslan: owner & founder, Dubai-based, leads strategy. Speaks English.
- Ina Kanaplianikava: partner, at the fair, focuses on product quality & supplier relationships. Speaks Russian.
- Konstantin Khoch: partner, at the fair, handles negotiations. Speaks Russian.
- Konstantin Ganev: partner, at the fair, tracks logistics & compliance. Speaks Bulgarian.
- Slavi Mikinski: remote investor/observer, not at the fair. Speaks Bulgarian. Needs full BG translations.

CANTON FAIR 2026 — GUANGZHOU, CHINA:
- Phase 1 (Apr 15–19): Electronics, smart home, lighting, hardware, machinery, tools
- Phase 2 (Apr 23–27): Home goods, ceramics, furniture, garden, gifts, office supplies  
- Phase 3 (May 1–5): Fashion, textiles, toys, personal care, food & beverages, accessories
- Venue: China Import and Export Fair Complex (Pazhou, Guangzhou)
- April weather in Guangzhou: 22–28°C, humid, frequent rain — bring umbrella

PRODUCT SCORING FRAMEWORK (score each 1–5):
1. Category attractiveness — EU market size, growth, stability
2. Product demand — search volume, Amazon/eMAG listings activity
3. Competition difficulty — incumbent brands, review barriers, differentiation room
4. Sourcing feasibility — MOQ, quality consistency, lead time (typical: 30–45 days)
5. Margin quality — after ALL costs (freight, duty, VAT, fees, ads)

MARGIN CALCULATION (always show breakdown when asked):
Example: buy $4, sell €18 in Germany
- Factory: $4.00 → €3.65 (at 0.913 rate)
- Freight + insurance: +12% → €4.10
- Import duty (avg 3.5%): +€0.14 → €4.24
- German VAT (19%) on landed: already in sell price
- Amazon/Shopify fee (15%): €2.70
- Ads budget (10%): €1.80
- Total costs: ~€8.74
- Net profit per unit: €18 - €8.74 = €9.26
- Net margin: 51% ✅ Excellent (target: >35%)

KEY SUPPLIERS PLATFORMS:
- 1688.com — domestic China pricing (cheapest, use for baseline)
- Alibaba — export-ready suppliers, MOQ negotiable
- Taobao — retail China prices
- AliPrice — reverse image search to match EU products to Chinese sources
- Canton Fair booths — direct factory contact, best for OEM/ODM negotiation

EU MARKET RESEARCH TOOLS the team uses:
- Amazon DE/UK/FR, eBay Europe, eMAG (Bulgaria/Romania) — competitor pricing
- Helium 10, Keepa — sales data, price history
- Google Trends — demand stability check

COMPLIANCE (flag when relevant):
- CE marking required for electronics/toys/machinery
- REACH for chemicals, RoHS for electronics
- Food contact materials have specific EU rules
- Average CE certification cost: €500–5,000 per product
- Always factor compliance cost into margin calculation

LANGUAGE RULE — MOST IMPORTANT:
Detect the EXACT language of the incoming message and respond in that SAME language.
- Bulgarian message → Bulgarian reply (full, fluent — never apologize for Bulgarian)
- Russian message → Russian reply
- English message → English reply
- Mixed language → reply in the dominant language
Never break this rule. Never say you cannot respond in a language.

PERSONALITY:
- Direct and practical — the team is busy on a trade fair floor
- Confident — give clear recommendations, not endless "it depends"
- Smart humor when appropriate — you can tell jokes, be personable
- Brief — max 200 words in Telegram unless a full report is requested
- Use emoji sparingly but naturally

MEMORY NOTE:
You have access to recent conversation history. When someone replies to a previous message, you can see the context. Always use it — never say you cannot see what was said before if context is provided.`;

// ============================================================
// AI CALL HELPER
// ============================================================
async function callAI(messages, systemPrompt, maxTokens, timeoutMs) {
  maxTokens  = maxTokens  || 600;
  timeoutMs  = timeoutMs  || 22000;
  systemPrompt = systemPrompt || VALERAN_SYSTEM;

  var ctrl  = new AbortController();
  var timer = setTimeout(function(){ ctrl.abort(); }, timeoutMs);

  try {
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: systemPrompt, messages: messages }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    var d = await r.json();
    if (d.error) { console.error('Anthropic error:', d.error.message); return null; }
    return (d.content && d.content[0] && d.content[0].text) || null;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') { console.error('AI timeout after', timeoutMs, 'ms'); return null; }
    console.error('AI fetch error:', e.message);
    return null;
  }
}

// ============================================================
// DETECT VALERAN TRIGGER
// ============================================================
function isValeranCalled(text) {
  if (!text) return false;
  var lower = text.toLowerCase().trim();
  return /^valeran/.test(lower) || /^valera[,\s!?]/.test(lower) ||
         lower.startsWith('\u0432\u0430\u043b\u0435\u0440\u0430\u043d') ||
         lower.startsWith('\u0432\u0430\u043b\u0435\u0440\u0430');
}

// ============================================================
// BACKGROUND ENTITY EXTRACTION (non-blocking, best-effort)
// ============================================================
async function extractAndSaveEntities(text, partnerId, sessionId) {
  if (!text || text.length < 15) return;
  try {
    var prompt = 'Extract structured Canton Fair data from this message. Return ONLY valid JSON, no explanation.\n\nMessage: "' + text.slice(0,500) + '"\n\nReturn: {"has_supplier":false,"has_product":false,"supplier":{"name":null,"hall":null,"booth_number":null,"contact_person":null,"wechat":null},"product":{"name":null,"buy_price_usd":null,"notes":null},"language":"en"}';

    var raw = await callAI([{ role: 'user', content: prompt }], 'Extract data. Return only valid JSON.', 300, 8000);
    if (!raw) return;

    var data = JSON.parse(raw.replace(/```json|```/g,'').trim());

    if (data.has_supplier && data.supplier && data.supplier.name) {
      await supabase.from('suppliers').upsert(
        { name: data.supplier.name, hall: data.supplier.hall, booth_number: data.supplier.booth_number, contact_person: data.supplier.contact_person, wechat: data.supplier.wechat, session_id: sessionId, created_by: partnerId },
        { onConflict: 'name', ignoreDuplicates: true }
      );
    }
    if (data.has_product && data.product && data.product.name) {
      await supabase.from('products').insert({ name: data.product.name, buy_price_usd: data.product.buy_price_usd, notes: data.product.notes, session_id: sessionId, created_by: partnerId });
    }
  } catch (e) {
    // Non-blocking — silent failure is fine
  }
}

// ============================================================
// GET RECENT CHAT HISTORY FOR CONTEXT
// ============================================================
async function getChatHistory(sessionId, limit) {
  limit = limit || 10;
  try {
    var r = await supabase.from('chat_messages').select('role, content')
      .eq('session_id', sessionId)
      .not('content', 'eq', '__VALERAN_WELCOME_SENT__')
      .not('content', 'ilike', '[Context:%')
      .order('created_at', { ascending: false })
      .limit(limit);
    return (r.data || []).reverse();
  } catch (e) { return []; }
}

// ============================================================
// PROCESS MESSAGE — Main entry point (web app)
// ============================================================
async function processMessage(opts) {
  var text       = opts.text;
  var partnerId  = opts.partnerId;
  var sessionId  = opts.sessionId;

  if (!text) return { responded: false };

  var sid       = sessionId || 'default';
  var triggered = isValeranCalled(text);

  // Save user message
  try {
    await supabase.from('chat_messages').insert({ session_id: sid, partner_id: partnerId || null, role: 'user', content: text });
  } catch (e) {}

  // Background entity extraction (never blocks)
  extractAndSaveEntities(text, partnerId, sid).catch(function(){});

  if (!triggered) return { responded: false, silent: true };

  // Get recent history for context
  var history = await getChatHistory(sid);
  var query   = text.replace(/^(valeran|valera|\u0432\u0430\u043b\u0435\u0440\u0430\u043d|\u0432\u0430\u043b\u0435\u0440\u0430)[,\s!?]*/i,'').trim() || text;

  var messages = history.map(function(m){ return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }; });
  messages.push({ role: 'user', content: query });

  var reply = await callAI(messages, VALERAN_SYSTEM, 700, 22000)
    || 'Sorry, having trouble connecting. Please try again in a moment.';

  try {
    await supabase.from('chat_messages').insert({ session_id: sid, partner_id: null, role: 'assistant', content: reply });
  } catch (e) {}

  return { responded: true, reply: reply };
}

// ============================================================
// EVENING REPORT
// ============================================================
async function generateEveningReport(sessionId, date) {
  var products = await supabase.from('products').select('name, buy_price_usd, sell_price_eur, margin_pct, notes, category').eq('session_id', sessionId).gte('created_at', date).order('created_at', { ascending: false }).limit(15);
  var suppliers = await supabase.from('suppliers').select('name, hall, booth_number, contact_person').eq('session_id', sessionId).gte('created_at', date).limit(10);
  var meetings = await supabase.from('meetings').select('scheduled_at, notes').gte('scheduled_at', date).limit(8);

  var prompt = 'Generate a structured evening report for the Synergy Ventures team at Canton Fair 2026.\n\n' +
    'Date: ' + date + '\n' +
    'Suppliers visited (' + ((products.data||[]).length) + '): ' + JSON.stringify((suppliers.data||[]).slice(0,5)) + '\n' +
    'Products logged (' + ((products.data||[]).length) + '): ' + JSON.stringify((products.data||[]).slice(0,8)) + '\n' +
    'Meetings tomorrow: ' + JSON.stringify((meetings.data||[]).slice(0,5)) + '\n\n' +
    'Structure:\n📊 DAY SUMMARY — key numbers\n🏆 TOP PRODUCTS — top 3-5 with margin analysis\n🏭 SUPPLIER NOTES\n📅 TOMORROW — schedule and prep\n⚡ ACTION ITEMS\n\nBe direct and scannable. Max 500 words in English.';

  var contentEn = await callAI([{ role: 'user', content: prompt }], VALERAN_SYSTEM, 1000, 25000) || 'Report generation failed.';
  var contentBg = await callAI([{ role: 'user', content: 'Translate to Bulgarian, keep emojis and formatting:\n\n' + contentEn }], 'Translate accurately to Bulgarian.', 1000, 20000) || '';

  var r = await supabase.from('reports').insert({ type: 'evening', session_id: sessionId, content: JSON.stringify({ en: contentEn, bg: contentBg }), created_at: new Date().toISOString() }).select().single();
  return Object.assign({}, r.data, { title: '\uD83D\uDCCA Evening Report \u00B7 ' + date, content_en: contentEn, content_bg: contentBg });
}

// ============================================================
// MORNING REPORT
// ============================================================
async function generateMorningReport(sessionId, date) {
  var products = await supabase.from('products').select('name, buy_price_usd, sell_price_eur, margin_pct, notes, category').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(10);
  var meetings = await supabase.from('meetings').select('scheduled_at, notes').gte('scheduled_at', date).limit(8);

  var prompt = 'Generate a morning briefing for the Synergy Ventures team at Canton Fair 2026.\n\n' +
    'Date: ' + date + '\n' +
    'Products to follow up: ' + JSON.stringify((products.data||[]).slice(0,6)) + '\n' +
    'Today meetings: ' + JSON.stringify(meetings.data||[]) + '\n\n' +
    'Structure:\n🌅 GOOD MORNING — date and fair phase\n🎯 PRIORITY FOLLOW-UPS — specific questions to ask suppliers\n📅 TODAY AGENDA — each meeting with prep notes\n🔍 AREAS TO EXPLORE — halls and categories worth visiting\n💡 KEY INSIGHT — one actionable observation\n\nBe specific and actionable. Max 400 words in English.';

  var contentEn = await callAI([{ role: 'user', content: prompt }], VALERAN_SYSTEM, 900, 25000) || 'Morning report failed.';
  var contentBg = await callAI([{ role: 'user', content: 'Translate to Bulgarian, keep emojis:\n\n' + contentEn }], 'Translate accurately to Bulgarian.', 900, 20000) || '';

  var r = await supabase.from('reports').insert({ type: 'morning', session_id: sessionId, content: JSON.stringify({ en: contentEn, bg: contentBg }), created_at: new Date().toISOString() }).select().single();
  return Object.assign({}, r.data, { title: '\uD83C\uDF05 Morning Briefing \u00B7 ' + date, content_en: contentEn, content_bg: contentBg });
}

module.exports = { processMessage, generateEveningReport, generateMorningReport, isValeranCalled, callAI };
