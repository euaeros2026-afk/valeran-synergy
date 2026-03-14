// ============================================================
// VALERAN AI CORE — Complete rewrite
// Fast, reliable, single Haiku call per message
// Full personality, Canton Fair context, memory-aware
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

// ============================================================
// VALERAN SYSTEM PROMPT — Full personality + Canton Fair context
// ============================================================
const VALERAN_SYSTEM = `You are Valeran — the AI field intelligence assistant for Synergy Ventures LLC-FZ at Canton Fair 2026 in Guangzhou, China.

COMPANY: Synergy Ventures sources products from Chinese manufacturers and sells into the EU market via Shopify, Instagram, and Facebook marketing. The business model is pure return-on-capital: any category, any product — if the numbers work, it's worth pursuing.

YOUR ROLE — you are simultaneously:
1. A smart business partner who understands Chinese sourcing and EU e-commerce
2. A field assistant helping the team log suppliers, products, and meetings at the fair
3. A market intelligence engine (EU demand + China supply analysis)
4. A personal assistant for anything the team needs — translations, calculations, research, etc.

YOUR PERSONALITY:
- Direct, practical, confident — no fluff
- Smart and business-focused — you understand margins, MOQ, HS codes, VAT, logistics
- Multilingual — detect the language of each message and respond in the SAME language (English, Russian, or Bulgarian)
- You remember context from earlier in the conversation
- You have a dry sense of humour but stay professional

THE TEAM (know them by name):
- Alexander Oslan (Owner/Lead) — at the fair, speaks EN
- Ina Kanaplianikava (Partner) — at the fair, speaks RU
- Konstantin Khoch (Partner) — at the fair, speaks RU  
- Konstantin Ganev (Partner) — at the fair, speaks BG, needs everything in Bulgarian
- Slavi Mikinski (Observer) — remote, speaks BG, observer only

CANTON FAIR 2026 PHASES:
- Phase 1: Apr 15-19 — Electronics, machinery, lighting, hardware, tools, smart home
- Phase 2: Apr 23-27 — Home goods, ceramics, furniture, gifts, garden, office
- Phase 3: May 1-5 — Fashion, textiles, toys, personal care, food, accessories

PRODUCT SCORING FRAMEWORK (5 dimensions, 1-5 each):
1. Category attractiveness — EU market size, growth trajectory, competition level
2. Product demand — search volume, marketplace listings, buyer intent
3. Competition difficulty — brand dominance, review barriers, differentiation room
4. Sourcing feasibility — MOQ, quality consistency, lead time, supplier reliability
5. Margin quality — landed cost vs EU retail after freight, VAT, duties, ads

MARGIN CALCULATION:
Landed cost = factory price × currency rate + freight (~8-12%) + customs duty (avg 3-6%) + VAT (country-specific)
Target gross margin: >35% after all costs and marketplace/advertising fees
Example: Buy at $4 → ~€3.65 × 1.18 (duty+freight) = €4.31 landed → sell €16 → margin ~73% before ads

WHAT YOU ACTIVELY DO:
- Respond to "Valeran, [question]" in Telegram and web app
- Help calculate margins on the spot with the formula above
- Research suppliers and products when asked
- Flag compliance requirements (CE marking, RoHS, REACH) for EU market
- Generate daily evening reports and morning briefings
- Suggest questions to ask suppliers based on product category
- Identify products by photo (Google Vision integration)
- Transcribe voice notes

RESPONSE STYLE:
- Concise and scannable — the team is busy on a trade fair floor
- Use bullet points and tables for comparisons
- Always show margin calculations broken down
- Flag risks with ⚠️, good opportunities with ✅, issues with ❌
- Max 300 words unless a full report is requested
- For reports, be comprehensive and structured

You are also a general personal assistant — if someone asks you something outside Synergy Ventures (translations, calculations, travel info, anything) — just help them. You are always helpful.`;

// ============================================================
// ANTHROPIC API CALL — fast, reliable, with timeout
// ============================================================
async function callAI(messages, systemPrompt, maxTokens = 600, timeoutMs = 22000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPrompt || VALERAN_SYSTEM,
        messages
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const d = await r.json();
    if (d.error) {
      console.error('Anthropic error:', JSON.stringify(d.error));
      return null;
    }
    return d?.content?.[0]?.text || null;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      console.error('Anthropic call timed out after', timeoutMs, 'ms');
      return null;
    }
    console.error('Anthropic fetch error:', e.message);
    return null;
  }
}

// ============================================================
// DETECT IF VALERAN IS ADDRESSED
// ============================================================
function isValeranCalled(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  return ['valeran', 'valera', 'валеран', 'валера'].some(t => lower.startsWith(t));
}

// ============================================================
// BACKGROUND ENTITY EXTRACTION (non-blocking)
// ============================================================
async function extractAndSaveEntities(text, partnerId, sessionId) {
  try {
    const prompt = `Extract structured data from this Canton Fair message. Return ONLY valid JSON.

Message: "${text.slice(0, 600)}"

Return this exact structure (null for missing fields):
{
  "has_supplier": boolean,
  "has_product": boolean,
  "supplier": { "name": null, "hall": null, "booth_number": null, "contact_person": null, "wechat": null, "notes": null },
  "product": { "name": null, "buy_price_usd": null, "notes": null },
  "language": "en"
}`;

    const raw = await callAI([{ role: 'user', content: prompt }], 'Extract structured data. Return only valid JSON.', 400, 10000);
    if (!raw) return;

    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());

    if (data.has_supplier && data.supplier?.name) {
      await supabase.from('suppliers').upsert(
        { ...data.supplier, session_id: sessionId, created_by: partnerId },
        { onConflict: 'name', ignoreDuplicates: true }
      );
    }
    if (data.has_product && data.product?.name) {
      await supabase.from('products').insert(
        { ...data.product, session_id: sessionId, created_by: partnerId }
      );
    }
  } catch (e) {
    console.error('Entity extraction error (non-blocking):', e.message);
  }
}

// ============================================================
// GET RECENT CONVERSATION HISTORY
// ============================================================
async function getChatHistory(sessionId, limit = 8) {
  try {
    const { data } = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .not('content', 'eq', '__VALERAN_WELCOME_SENT__')
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data || []).reverse();
  } catch (e) {
    return [];
  }
}

// ============================================================
// PROCESS MESSAGE — Main entry point
// ============================================================
async function processMessage({ text, partnerId, sessionId, messageType = 'text', mediaUrl = null }) {
  if (!text) return { responded: false };

  const sid = sessionId || 'default';
  const triggered = isValeranCalled(text);

  // Save user message to DB
  try {
    await supabase.from('chat_messages').insert({
      session_id: sid,
      partner_id: partnerId || null,
      role: 'user',
      content: text
    });
  } catch (e) { console.error('Save user msg error:', e.message); }

  // Fire-and-forget entity extraction (never blocks response)
  if (triggered || text.length > 20) {
    extractAndSaveEntities(text, partnerId, sid).catch(() => {});
  }

  if (!triggered) {
    return { responded: false, silent: true };
  }

  // Build conversation context
  const history = await getChatHistory(sid);
  const query = text.replace(/^(valeran|valera|валеран|валера)[,\s]*/i, '').trim() || text;

  const messages = [
    ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: query }
  ];

  // Get Valeran's response
  const reply = await callAI(messages, VALERAN_SYSTEM, 700, 22000)
    || 'I am having trouble connecting right now. Please try again in a moment.';

  // Save assistant response
  try {
    await supabase.from('chat_messages').insert({
      session_id: sid,
      partner_id: null,
      role: 'assistant',
      content: reply
    });
  } catch (e) { console.error('Save assistant msg error:', e.message); }

  return { responded: true, reply };
}

// ============================================================
// GENERATE EVENING REPORT
// ============================================================
async function generateEveningReport(sessionId, date) {
  const { data: products } = await supabase
    .from('products').select('name, buy_price_usd, sell_price_eur, margin_pct, notes, category')
    .eq('session_id', sessionId).gte('created_at', date)
    .order('created_at', { ascending: false }).limit(15);

  const { data: suppliers } = await supabase
    .from('suppliers').select('name, hall, booth_number, contact_person')
    .eq('session_id', sessionId).gte('created_at', date).limit(10);

  const { data: meetings } = await supabase
    .from('meetings').select('scheduled_at, notes').gte('scheduled_at', date).limit(8);

  const prompt = `Generate a structured evening report for the Synergy Ventures team at Canton Fair 2026.

Date: ${date}
Suppliers visited today (${suppliers?.length || 0}): ${JSON.stringify(suppliers?.slice(0,5))}
Products logged today (${products?.length || 0}): ${JSON.stringify(products?.slice(0,8))}
Tomorrow's meetings (${meetings?.length || 0}): ${JSON.stringify(meetings?.slice(0,5))}

Structure the report as:
📊 DAY SUMMARY — key numbers
🏆 TOP PRODUCTS — top 3-5 with margin highlights and scores
🏭 SUPPLIER NOTES — notable observations
📅 TOMORROW — schedule and prep notes for each meeting
⚡ ACTION ITEMS — concrete next steps

Be direct and scannable. The team is tired. Max 500 words in English.`;

  const contentEn = await callAI([{ role: 'user', content: prompt }], VALERAN_SYSTEM, 1000, 25000)
    || 'Report generation failed — please generate manually.';

  const bgPrompt = `Translate this evening report to Bulgarian, keeping all emojis and formatting:\n\n${contentEn}`;
  const contentBg = await callAI([{ role: 'user', content: bgPrompt }], 'You are a professional translator. Translate accurately.', 1000, 20000) || '';

  const { data: report } = await supabase.from('reports').insert({
    type: 'evening',
    session_id: sessionId,
    content: JSON.stringify({ en: contentEn, bg: contentBg }),
    created_at: new Date().toISOString()
  }).select().single();

  return { ...report, title: `📊 Evening Report · ${date}`, content_en: contentEn, content_bg: contentBg };
}

// ============================================================
// GENERATE MORNING REPORT
// ============================================================
async function generateMorningReport(sessionId, date) {
  const { data: shortlisted } = await supabase
    .from('products').select('name, buy_price_usd, sell_price_eur, margin_pct, notes, category')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false }).limit(10);

  const { data: meetings } = await supabase
    .from('meetings').select('scheduled_at, notes').gte('scheduled_at', date).limit(8);

  const prompt = `Generate a morning briefing for the Synergy Ventures team at Canton Fair 2026.

Date: ${date}
Top products to follow up on: ${JSON.stringify(shortlisted?.slice(0,6))}
Today's scheduled meetings: ${JSON.stringify(meetings)}

Structure the briefing as:
🌅 GOOD MORNING — date and phase
🎯 PRIORITY FOLLOW-UPS — which products to revisit and WHY, with specific questions to ask suppliers
📅 TODAY'S AGENDA — each meeting with prep notes
🔍 AREAS TO EXPLORE — categories or halls to focus on today
💡 KEY INSIGHT — one actionable observation from yesterday's data

Be specific and actionable. The team reads this over breakfast. Max 400 words in English.`;

  const contentEn = await callAI([{ role: 'user', content: prompt }], VALERAN_SYSTEM, 900, 25000)
    || 'Morning briefing generation failed.';

  const bgPrompt = `Translate to Bulgarian, keeping all emojis and formatting:\n\n${contentEn}`;
  const contentBg = await callAI([{ role: 'user', content: bgPrompt }], 'You are a professional translator.', 900, 20000) || '';

  const { data: report } = await supabase.from('reports').insert({
    type: 'morning',
    session_id: sessionId,
    content: JSON.stringify({ en: contentEn, bg: contentBg }),
    created_at: new Date().toISOString()
  }).select().single();

  return { ...report, title: `🌅 Morning Briefing · ${date}`, content_en: contentEn, content_bg: contentBg };
}

module.exports = { processMessage, generateEveningReport, generateMorningReport, isValeranCalled, callAI };
