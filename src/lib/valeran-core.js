// ============================================================
// VALERAN AI CORE
// The brain. Processes every message, decides when to respond,
// extracts structured data, generates reports.
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ============================================================
// VALERAN SYSTEM PROMPT
// ============================================================
const VALERAN_SYSTEM = `You are Valeran, the AI assistant for Synergy Ventures — a Dubai-registered company founded by partners sourcing products from China to sell in the EU via Shopify.

Your team is attending the Canton Fair in Guangzhou, China. Your role has two modes:

## SILENT MODE (default)
When your name is NOT mentioned, you silently process every message and:
- Extract any supplier information (company, hall, booth, contact)
- Extract any product information (name, price, MOQ, specs)
- Extract any meeting commitments or schedule items
- Tag the message with relevant categories
- Store everything in the database
- NEVER respond in silent mode — just process and store

## ACTIVE MODE  
When someone says "Valeran" in their message, you respond helpfully.
You also act as a general assistant for any question outside Synergy Ventures scope.

## TEAM
- Partners speak English, Russian, and Bulgarian
- One remote partner (observer) needs everything in Bulgarian
- Always detect the language of the input and respond in the same language
- For reports, generate English + Bulgarian versions

## CORE BUSINESS LOGIC
You understand the dual-stream product discovery system:
- EU side: Amazon DE/UK/FR, eMAG, eBay Europe — demand validation
- China side: 1688, Alibaba, AliPrice — supply validation
- Decision engine: 5-dimension scoring (category attractiveness, product demand, competition difficulty, sourcing feasibility, margin quality) — each scored 1-5

## CANTON FAIR PHASES
- Phase 1 (Apr 15-19): Electronics, machinery, lighting, hardware, tools
- Phase 2 (Apr 23-27): Home goods, ceramics, furniture, gifts, garden
- Phase 3 (May 1-5): Fashion, textiles, toys, personal care, food

## PRODUCT CATEGORY AUTO-ASSIGNMENT
When a product is mentioned, automatically assign it to the closest Canton Fair section.
If nothing fits, suggest a new category name.

## RESPONSE STYLE
- Concise and professional
- Use data tables when presenting product comparisons
- Flag important insights (good margin, EU compliance issues, strong competition)
- In Bulgarian for the remote partner
- Never be verbose — your team is busy at a trade fair`;

// ============================================================
// DETECT IF VALERAN IS CALLED
// ============================================================
function isValeranCalled(text) {
  const triggers = ['valeran', 'valera', 'валеран', 'валера'];
  const lower = text.toLowerCase();
  return triggers.some(t => lower.includes(t));
}

// ============================================================
// EXTRACT ENTITIES FROM MESSAGE
// Runs silently on every message
// ============================================================
async function extractEntities(message, partnerId, sessionId) {
  const extractPrompt = `Extract structured data from this message from a Canton Fair attendee.
Return ONLY valid JSON, nothing else.

Message: "${message}"

Return this exact structure (use null for missing fields):
{
  "has_supplier": boolean,
  "has_product": boolean,
  "has_meeting": boolean,
  "supplier": {
    "company_name": string|null,
    "hall": string|null,
    "booth_number": string|null,
    "contact_name": string|null,
    "contact_phone": string|null,
    "contact_wechat": string|null,
    "oem_available": boolean|null,
    "odm_available": boolean|null,
    "notes": string|null
  },
  "product": {
    "product_name": string|null,
    "category_suggestion": string|null,
    "exworks_price_cny": number|null,
    "exworks_price_usd": number|null,
    "moq_standard": number|null,
    "key_features": string[]|null,
    "materials": string|null,
    "notes": string|null
  },
  "meeting": {
    "title": string|null,
    "meeting_date": string|null,
    "meeting_time": string|null,
    "location": string|null,
    "contact_name": string|null,
    "agenda": string|null
  },
  "tags": string[],
  "language": "en"|"ru"|"bg"
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: extractPrompt }]
    });

    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('Entity extraction failed:', e);
    return null;
  }
}

// ============================================================
// SAVE EXTRACTED ENTITIES TO DATABASE
// ============================================================
async function saveEntities(extracted, partnerId, sessionId, messageId) {
  if (!extracted) return {};
  const result = {};

  // Save supplier
  if (extracted.has_supplier && extracted.supplier?.company_name) {
    const { data: supplier } = await supabase
      .from('suppliers')
      .upsert({
        ...extracted.supplier,
        logged_by: partnerId,
        fair_session_id: sessionId
      }, { onConflict: 'company_name,hall,booth_number', ignoreDuplicates: false })
      .select()
      .single();

    if (supplier) result.supplier_id = supplier.id;
  }

  // Save product
  if (extracted.has_product && extracted.product?.product_name) {
    // Auto-assign category
    const category = await autoAssignCategory(extracted.product);

    const { data: product } = await supabase
      .from('products')
      .insert({
        ...extracted.product,
        category_auto: extracted.product.category_suggestion,
        category_id: category?.id,
        supplier_id: result.supplier_id || null,
        logged_by: partnerId,
        fair_session_id: sessionId,
        status: 'reviewing'
      })
      .select()
      .single();

    if (product) result.product_id = product.id;
  }

  // Save meeting
  if (extracted.has_meeting && extracted.meeting?.title) {
    const { data: meeting } = await supabase
      .from('meetings')
      .insert({
        ...extracted.meeting,
        supplier_id: result.supplier_id || null,
        created_by: partnerId
      })
      .select()
      .single();

    if (meeting) result.meeting_id = meeting.id;
  }

  return result;
}

// ============================================================
// AUTO-ASSIGN CATEGORY
// ============================================================
async function autoAssignCategory(product) {
  // Get existing categories
  const { data: categories } = await supabase
    .from('categories')
    .select('id, name, canton_fair_section');

  const catList = categories?.map(c => c.name).join(', ') || '';

  const prompt = `Given this product: "${product.product_name}" (${product.notes || ''}),
assign it to the most appropriate category from this list: ${catList}
If none fit well, suggest a new category name.
Return ONLY JSON: {"category_name": "...", "is_new": boolean}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 100,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.replace(/```json|```/g, '').trim();
  const result = JSON.parse(text);

  if (result.is_new) {
    const { data: newCat } = await supabase
      .from('categories')
      .insert({ name: result.category_name, created_by: 'valeran_auto' })
      .select().single();
    return newCat;
  }

  const match = categories?.find(c => c.name === result.category_name);
  return match || null;
}

// ============================================================
// PROCESS INCOMING MESSAGE (main entry point)
// ============================================================
async function processMessage({ text, partnerId, sessionId, messageType = 'text', mediaUrl = null }) {
  // Get partner info
  const { data: partner } = await supabase
    .from('partners')
    .select('*')
    .eq('id', partnerId)
    .single();

  const triggered = isValeranCalled(text);

  // Always extract entities silently
  const extracted = await extractEntities(text, partnerId, sessionId);

  // Save message to DB
  const { data: savedMessage } = await supabase
    .from('messages')
    .insert({
      sender_id: partnerId,
      sender_type: 'partner',
      content: text,
      message_type: messageType,
      media_url: mediaUrl,
      tags: extracted?.tags || [],
      valeran_triggered: triggered,
      fair_session_id: sessionId
    })
    .select().single();

  // Save extracted entities
  const entityRefs = await saveEntities(extracted, partnerId, sessionId, savedMessage?.id);

  // Update message with entity references
  if (savedMessage && (entityRefs.supplier_id || entityRefs.product_id || entityRefs.meeting_id)) {
    await supabase.from('messages').update(entityRefs).eq('id', savedMessage.id);
  }

  // If not triggered, return silent acknowledgment
  if (!triggered) {
    return { responded: false, extracted, entityRefs };
  }

  // Build conversation context
  const { data: recentMessages } = await supabase
    .from('messages')
    .select('sender_type, content, created_at')
    .eq('fair_session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(20);

  const history = (recentMessages || []).reverse().map(m => ({
    role: m.sender_type === 'partner' ? 'user' : 'assistant',
    content: m.content
  }));

  // Get today's stats for context
  const today = new Date().toISOString().split('T')[0];
  const { count: todayProducts } = await supabase
    .from('products')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', today);

  const contextNote = `[Context: ${todayProducts || 0} products logged today. Partner: ${partner?.full_name}. Language preference: ${partner?.preferred_language || 'en'}]`;

  // Generate Valeran response
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: VALERAN_SYSTEM + '\n\n' + contextNote,
    messages: [
      ...history,
      { role: 'user', content: text }
    ]
  });

  const valeranReply = response.content[0].text;

  // Save Valeran's response
  const { data: valeranMessage } = await supabase
    .from('messages')
    .insert({
      sender_type: 'valeran',
      content: valeranReply,
      message_type: 'text',
      valeran_triggered: true,
      fair_session_id: sessionId
    })
    .select().single();

  return {
    responded: true,
    reply: valeranReply,
    extracted,
    entityRefs,
    messageId: valeranMessage?.id
  };
}

// ============================================================
// GENERATE EVENING REPORT
// ============================================================
async function generateEveningReport(sessionId, date) {
  const { data: session } = await supabase.from('fair_sessions').select('*').eq('id', sessionId).single();
  const { data: todayProducts } = await supabase.from('products').select('*, suppliers(company_name, hall, booth_number)').eq('fair_session_id', sessionId).gte('created_at', date).order('total_score', { ascending: false });
  const { data: todayMessages } = await supabase.from('messages').select('*, partners(full_name)').eq('fair_session_id', sessionId).gte('created_at', date);
  const { data: tomorrowMeetings } = await supabase.from('meetings').select('*, suppliers(company_name)').eq('meeting_date', getTomorrow(date)).order('meeting_time');

  const stats = {
    products_logged: todayProducts?.length || 0,
    suppliers_met: new Set(todayProducts?.map(p => p.supplier_id).filter(Boolean)).size,
    messages_sent: todayMessages?.length || 0,
    meetings_tomorrow: tomorrowMeetings?.length || 0
  };

  const reportPrompt = `Generate a structured evening report for the Synergy Ventures team at Canton Fair.

Date: ${date}
Phase: ${session?.phase_number} - ${session?.name}

Stats: ${JSON.stringify(stats)}

Products logged today: ${JSON.stringify(todayProducts?.slice(0, 10))}

Meetings tomorrow: ${JSON.stringify(tomorrowMeetings)}

Generate a concise, structured report covering:
1. Day summary (key numbers)
2. Top products found today with scores and margin highlights
3. Notable supplier observations
4. Tomorrow's schedule and recommended talking points for each meeting
5. Action items

Write in a professional but direct tone. The team is tired after a long day — be clear and scannable.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: reportPrompt }]
  });

  const reportEn = response.content[0].text;

  // Translate to Bulgarian for remote partner
  const bgResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: `Translate this report to Bulgarian:\n\n${reportEn}` }]
  });
  const reportBg = bgResponse.content[0].text;

  // Save report
  const { data: report } = await supabase.from('reports').insert({
    report_type: 'evening',
    fair_session_id: sessionId,
    report_date: date,
    title: `Evening Report · ${date} · Phase ${session?.phase_number}`,
    content_en: reportEn,
    content_bg: reportBg,
    stats,
    top_products: todayProducts?.slice(0, 5),
    meetings_tomorrow: tomorrowMeetings
  }).select().single();

  return report;
}

// ============================================================
// GENERATE MORNING REPORT
// ============================================================
async function generateMorningReport(sessionId, date) {
  const { data: session } = await supabase.from('fair_sessions').select('*').eq('id', sessionId).single();
  const { data: shortlisted } = await supabase.from('products').select('*, suppliers(company_name, contact_name, hall, booth_number)').eq('fair_session_id', sessionId).in('status', ['reviewing', 'shortlisted']).order('total_score', { ascending: false }).limit(15);
  const { data: todayMeetings } = await supabase.from('meetings').select('*, suppliers(company_name, contact_name, contact_phone)').eq('meeting_date', date).order('meeting_time');

  const reportPrompt = `Generate a morning briefing for the Synergy Ventures team before they go to Canton Fair today.

Date: ${date} (Phase ${session?.phase_number})

Products to evaluate further today: ${JSON.stringify(shortlisted?.slice(0, 8))}

Today's scheduled meetings: ${JSON.stringify(todayMeetings)}

Generate:
1. Priority products to follow up on today — with specific questions to ask suppliers based on review insights
2. Today's meeting agenda — with preparation notes for each meeting
3. Categories to focus on today (based on scoring so far)
4. Recommended new areas to explore
5. One key insight from overnight market intelligence

Be specific and actionable. The team reads this over breakfast.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: reportPrompt }]
  });

  const reportEn = response.content[0].text;

  const bgResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: `Translate this to Bulgarian:\n\n${reportEn}` }]
  });

  const { data: report } = await supabase.from('reports').insert({
    report_type: 'morning',
    fair_session_id: sessionId,
    report_date: date,
    title: `Morning Briefing · ${date} · Phase ${session?.phase_number}`,
    content_en: reportEn,
    content_bg: bgResponse.content[0].text,
    meetings_tomorrow: todayMeetings
  }).select().single();

  return report;
}

function getTomorrow(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

module.exports = { processMessage, generateEveningReport, generateMorningReport, isValeranCalled };
