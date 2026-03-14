// ============================================================
// VALERAN AI CORE — Fixed version
// Key fixes:
//   1. Uses Haiku (fast, <4s) not Sonnet (slow, 15-30s)
//   2. Table names fixed: partner_profiles, chat_messages
//   3. Single AI call for active responses (no chained calls)
//   4. Entity extraction is fire-and-forget (non-blocking)
//   5. processMessage is now a simple, fast, reliable function
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FAST_MODEL    = 'claude-haiku-4-5-20251001'; // ~2-4s
const SMART_MODEL   = 'claude-haiku-4-5-20251001'; // keep Haiku throughout for Vercel Hobby

// ============================================================
// ANTHROPIC CALL HELPER
// ============================================================
async function callAI(messages, system, maxTokens = 600, timeoutMs = 22000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = { model: FAST_MODEL, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const d = await r.json();
    return d?.content?.[0]?.text || null;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return null;
    console.error('AI call error:', e.message);
    return null;
  }
}

// ============================================================
// VALERAN SYSTEM PROMPT
// ============================================================
const VALERAN_SYSTEM = `You are Valeran, the AI field intelligence assistant for Synergy Ventures at Canton Fair 2026 in Guangzhou, China. Synergy Ventures is a Dubai-registered company that sources products from Chinese manufacturers to sell in the EU.

YOUR ROLE:
- Help the team research products, suppliers, and margins
- Calculate landed costs and EU margin estimates
- Provide market intelligence (EU demand + China supply)
- Be a practical, concise assistant — the team is busy on the fair floor

TEAM LANGUAGES: English, Russian, Bulgarian — always detect and match the input language.

CANTON FAIR PHASES:
- Phase 1 (Apr 15-19): Electronics, lighting, hardware, tools, machinery
- Phase 2 (Apr 23-27): Home goods, ceramics, furniture, gifts, garden
- Phase 3 (May 1-5): Fashion, textiles, toys, personal care, food

MARGIN CALCULATION FORMULA:
Landed cost = factory price × 1.13 (shipping ~8%, duty ~5%) + VAT depends on EU country
EU margin % = (sell price - landed cost - marketplace fees - ads) / sell price × 100
Target: >35% gross margin after all costs

PRODUCT SCORING (1-5 each dimension):
- Category attractiveness (EU market size & growth)
- Product demand (search volume, marketplace sales)
- Competition difficulty (brand dominance, review barriers)
- Sourcing feasibility (MOQ, quality, lead time)
- Margin quality (after all costs)

RESPONSE STYLE:
- Be concise and practical — use bullet points and tables
- Max 250 words unless a report is requested
- Flag important insights: ✅ good margin, ⚠️ compliance risk, ❌ too competitive
- For margin questions, always show the calculation breakdown`;

// ============================================================
// DETECT IF VALERAN IS CALLED
// ============================================================
function isValeranCalled(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return ['valeran', 'valera', 'валеран', 'валера'].some(t => lower.includes(t));
}

// ============================================================
// EXTRACT ENTITIES — fire-and-forget background task
// ============================================================
async function extractAndSaveEntities(text, partnerId, sessionId) {
  try {
    const prompt = `Extract structured data from this message from a Canton Fair attendee.
Return ONLY valid JSON, nothing else. If a field has no data, use null.

Message: "${text.slice(0, 500)}"

Return:
{
  "has_supplier": boolean,
  "has_product": boolean,
  "supplier": { "name": null, "hall": null, "booth": null, "contact": null, "wechat": null },
  "product": { "name": null, "price_usd": null, "price_cny": null, "moq": null, "notes": null },
  "tags": [],
  "language": "en"
}`;

    const raw = await callAI([{ role: 'user', content: prompt }], null, 400, 12000);
    if (!raw) return;
    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());

    // Save supplier if found
    if (data.has_supplier && data.supplier?.name) {
      await supabase.from('suppliers').upsert({
        name: data.supplier.name,
        hall: data.supplier.hall,
        booth_number: data.supplier.booth,
        contact_person: data.supplier.contact,
        wechat: data.supplier.wechat,
        session_id: sessionId,
        created_by: partnerId
      }, { onConflict: 'name' });
    }

    // Save product if found
    if (data.has_product && data.product?.name) {
      await supabase.from('products').insert({
        name: data.product.name,
        buy_price_usd: data.product.price_usd,
        notes: data.product.notes,
        session_id: sessionId,
        created_by: partnerId
      });
    }
  } catch (e) {
    console.error('Entity extraction failed (non-blocking):', e.message);
  }
}

// ============================================================
// GET RECENT CHAT HISTORY
// ============================================================
async function getChatHistory(sessionId, limit = 10) {
  try {
    const { data } = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .neq('content', '__VALERAN_WELCOME_SENT__')
      .order('created_at', { ascending: false })
      .limit(limit);
    return (data || []).reverse();
  } catch (e) {
    return [];
  }
}

// ============================================================
// PROCESS MESSAGE — main entry point
// Fast path: direct AI call + save. Entity extraction is async background.
// ============================================================
async function processMessage({ text, partnerId, sessionId, messageType = 'text', mediaUrl = null }) {
  if (!text) return { responded: false };

  const triggered = isValeranCalled(text);

  // Save incoming message
  try {
    await supabase.from('chat_messages').insert({
      session_id: sessionId || 'default',
      partner_id: partnerId || null,
      role: 'user',
      content: text
    });
  } catch (e) {
    console.error('Save message error:', e.message);
  }

  // Always extract entities in background (non-blocking)
  if (partnerId && sessionId) {
    extractAndSaveEntities(text, partnerId, sessionId).catch(() => {});
  }

  if (!triggered) {
    return { responded: false, silent: true };
  }

  // Get conversation history for context
  const history = await getChatHistory(sessionId || 'default');

  // Build messages array with history
  const query = text.replace(/^valeran[,\s]*/i, '').trim() || text;
  const messages = [
    ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: query }
  ];

  // Get AI response
  const reply = await callAI(messages, VALERAN_SYSTEM, 600, 22000)
    || 'Sorry, I could not process that right now. Please try again.';

  // Save assistant response
  try {
    await supabase.from('chat_messages').insert({
      session_id: sessionId || 'default',
      partner_id: null,
      role: 'assistant',
      content: reply
    });
  } catch (e) {
    console.error('Save reply error:', e.message);
  }

  return { responded: true, reply };
}

// ============================================================
// GENERATE EVENING REPORT
// ============================================================
async function generateEveningReport(sessionId, date) {
  const { data: products } = await supabase
    .from('products')
    .select('name, buy_price_usd, sell_price_eur, margin_pct, notes')
    .eq('session_id', sessionId)
    .gte('created_at', date)
    .order('margin_pct', { ascending: false })
    .limit(10);

  const { data: meetings } = await supabase
    .from('meetings')
    .select('supplier_id, scheduled_at, notes')
    .gte('scheduled_at', date)
    .limit(10);

  const stats = {
    products_logged: products?.length || 0,
    meetings_tomorrow: meetings?.length || 0,
    date
  };

  const prompt = `Generate a concise evening report for the Synergy Ventures team at Canton Fair.
Date: ${date}
Products logged today (${stats.products_logged}): ${JSON.stringify(products?.slice(0,5))}
Tomorrow's meetings (${stats.meetings_tomorrow}): ${JSON.stringify(meetings?.slice(0,5))}

Include: day summary, top 3 products with highlights, tomorrow's schedule, key action items.
Be direct and scannable — the team is tired. Max 400 words.`;

  const contentEn = await callAI([{ role: 'user', content: prompt }], null, 800, 25000)
    || 'Evening report generation failed.';

  const bgPrompt = `Translate to Bulgarian (keep emojis and formatting):\n\n${contentEn}`;
  const contentBg = await callAI([{ role: 'user', content: bgPrompt }], null, 800, 20000) || '';

  const { data: report } = await supabase.from('reports').insert({
    type: 'evening',
    session_id: sessionId,
    content: JSON.stringify({ en: contentEn, bg: contentBg, stats }),
    created_at: new Date().toISOString()
  }).select().single();

  return { ...report, title: `Evening Report · ${date}`, content_en: contentEn, content_bg: contentBg };
}

// ============================================================
// GENERATE MORNING REPORT
// ============================================================
async function generateMorningReport(sessionId, date) {
  const { data: shortlisted } = await supabase
    .from('products')
    .select('name, buy_price_usd, sell_price_eur, margin_pct, notes')
    .eq('session_id', sessionId)
    .order('margin_pct', { ascending: false })
    .limit(8);

  const { data: meetings } = await supabase
    .from('meetings')
    .select('scheduled_at, notes')
    .gte('scheduled_at', date)
    .limit(5);

  const prompt = `Generate a morning briefing for the Synergy Ventures team at Canton Fair.
Date: ${date}
Top products to follow up: ${JSON.stringify(shortlisted?.slice(0,5))}
Today's meetings: ${JSON.stringify(meetings)}

Include: priority follow-ups with specific questions to ask, today's meeting prep, recommended areas to explore.
Be actionable — the team reads this over breakfast. Max 350 words.`;

  const contentEn = await callAI([{ role: 'user', content: prompt }], null, 800, 25000)
    || 'Morning report generation failed.';

  const bgPrompt = `Translate to Bulgarian (keep emojis and formatting):\n\n${contentEn}`;
  const contentBg = await callAI([{ role: 'user', content: bgPrompt }], null, 800, 20000) || '';

  const { data: report } = await supabase.from('reports').insert({
    type: 'morning',
    session_id: sessionId,
    content: JSON.stringify({ en: contentEn, bg: contentBg }),
    created_at: new Date().toISOString()
  }).select().single();

  return { ...report, title: `Morning Briefing · ${date}`, content_en: contentEn, content_bg: contentBg };
}

module.exports = { processMessage, generateEveningReport, generateMorningReport, isValeranCalled, callAI };
