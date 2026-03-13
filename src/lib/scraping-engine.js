// ============================================================
// VALERAN SCRAPING ENGINE
// Runs overnight during fair breaks
// Scrapes EU platforms + China platforms per product
// Auto-calculates margin estimates
// ============================================================

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ScraperAPI key for anti-bot bypass
const SCRAPER_KEY = process.env.SCRAPER_API_KEY;

// EU import cost constants (approximate)
const FREIGHT_PER_KG_EUR = 3.5;
const VAT_RATE = 0.20; // 20% average EU VAT
const AMAZON_FEE_RATE = 0.15; // 15% Amazon referral fee
const ADVERTISING_RATE = 0.08; // 8% ad spend estimate

// ============================================================
// SCRAPE AMAZON FOR PRODUCT
// ============================================================
async function scrapeAmazonDE(productName, keywords) {
  const query = encodeURIComponent(`${productName} ${(keywords || []).slice(0, 3).join(' ')}`);
  const url = `https://www.amazon.de/s?k=${query}`;

  try {
    const response = await axios.get(`http://api.scraperapi.com`, {
      params: { api_key: SCRAPER_KEY, url, country_code: 'de', render: 'false' },
      timeout: 30000
    });

    // Parse with Claude (handles changing HTML structure robustly)
    const parsePrompt = `Extract product listings from this Amazon.de HTML snippet.
Return ONLY JSON array of up to 5 results:
[{
  "name": "product name",
  "price_eur": number,
  "rating": number,
  "review_count": number,
  "asin": "string",
  "url": "string"
}]

HTML (truncated): ${response.data.slice(0, 8000)}`;

    const parsed = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: parsePrompt }]
    });

    const text = parsed.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.error('Amazon DE scrape failed:', e.message);
    return [];
  }
}

// ============================================================
// SCRAPE EMAG
// ============================================================
async function scrapeEMAG(productName) {
  const query = encodeURIComponent(productName);
  const url = `https://www.emag.ro/search/${query}`;

  try {
    const response = await axios.get(`http://api.scraperapi.com`, {
      params: { api_key: SCRAPER_KEY, url, country_code: 'ro', render: 'false' },
      timeout: 30000
    });

    const parsePrompt = `Extract product listings from this eMAG.ro HTML.
Return ONLY JSON array up to 5 items:
[{"name": "...", "price_eur": number, "rating": number, "review_count": number}]
HTML: ${response.data.slice(0, 6000)}`;

    const parsed = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: parsePrompt }]
    });

    return JSON.parse(parsed.content[0].text.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('eMAG scrape failed:', e.message);
    return [];
  }
}

// ============================================================
// SCRAPE ALIBABA FOR CHINA PRICING
// ============================================================
async function scrapeAlibaba(productName) {
  const query = encodeURIComponent(productName);
  const url = `https://www.alibaba.com/trade/search?SearchText=${query}`;

  try {
    const response = await axios.get(`http://api.scraperapi.com`, {
      params: { api_key: SCRAPER_KEY, url, country_code: 'cn', render: 'false' },
      timeout: 30000
    });

    const parsePrompt = `Extract product listings from this Alibaba HTML.
Return ONLY JSON array up to 5 items:
[{
  "supplier_name": "...",
  "price_usd_min": number,
  "price_usd_max": number,
  "moq": number,
  "gold_supplier": boolean,
  "trade_assurance": boolean
}]
HTML: ${response.data.slice(0, 6000)}`;

    const parsed = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: parsePrompt }]
    });

    return JSON.parse(parsed.content[0].text.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Alibaba scrape failed:', e.message);
    return [];
  }
}

// ============================================================
// EXTRACT REVIEW INSIGHTS
// ============================================================
async function extractReviewInsights(productName, amazonResults) {
  if (!amazonResults?.length) return { top_complaints: [], top_praise: [], questions_to_ask: [] };

  // Scrape top reviews for the best-rated product
  const topProduct = amazonResults.sort((a, b) => (b.review_count || 0) - (a.review_count || 0))[0];
  if (!topProduct?.asin) return { top_complaints: [], top_praise: [], questions_to_ask: [] };

  const reviewUrl = `https://www.amazon.de/product-reviews/${topProduct.asin}?sortBy=recent`;

  try {
    const response = await axios.get(`http://api.scraperapi.com`, {
      params: { api_key: SCRAPER_KEY, url: reviewUrl, country_code: 'de' },
      timeout: 30000
    });

    const insightPrompt = `Analyse these Amazon reviews for "${productName}".
Extract insights useful for a product sourcing team deciding whether to source and sell this product.
Return ONLY JSON:
{
  "top_complaints": ["complaint 1", "complaint 2", "complaint 3"],
  "top_praise": ["praise 1", "praise 2", "praise 3"],
  "differentiation_opportunities": ["opportunity 1", "opportunity 2"],
  "questions_to_ask_supplier": ["question 1", "question 2", "question 3"],
  "avg_quality_perception": "low|medium|high"
}

Reviews HTML: ${response.data.slice(0, 8000)}`;

    const parsed = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: insightPrompt }]
    });

    return JSON.parse(parsed.content[0].text.replace(/```json|```/g, '').trim());
  } catch (e) {
    return { top_complaints: [], top_praise: [], questions_to_ask: [] };
  }
}

// ============================================================
// CALCULATE GROSS MARGIN ESTIMATE
// ============================================================
function calculateMargin({ exworks_price_usd, eu_avg_price_eur, weight_grams, hs_customs_duty_rate }) {
  if (!exworks_price_usd || !eu_avg_price_eur) return null;

  const cogs = exworks_price_usd * 1.05; // +5% for packaging/QC
  const freight = ((weight_grams || 500) / 1000) * FREIGHT_PER_KG_EUR;
  const dutyRate = (hs_customs_duty_rate || 3.7) / 100;
  const landedCost = cogs + freight + (cogs * dutyRate);
  const vatCost = eu_avg_price_eur * VAT_RATE;
  const amazonFee = eu_avg_price_eur * AMAZON_FEE_RATE;
  const adSpend = eu_avg_price_eur * ADVERTISING_RATE;
  const totalCost = landedCost + vatCost + amazonFee + adSpend;
  const grossMargin = ((eu_avg_price_eur - totalCost) / eu_avg_price_eur) * 100;

  return Math.round(grossMargin * 10) / 10;
}

// ============================================================
// CALCULATE 5-DIMENSION SCORE
// ============================================================
async function calculateScore(product, euResults, chinaResults, reviewInsights) {
  const scorePrompt = `Score this product opportunity from 1-5 on each dimension.
Return ONLY JSON: {
  "category_attractiveness": number,
  "product_demand": number,
  "competition_difficulty": number,
  "sourcing_feasibility": number,
  "margin_quality": number,
  "reasoning": "one sentence"
}

Product: ${product.product_name}
EU avg price: €${product.eu_avg_price_eur}
Gross margin estimate: ${product.gross_margin_estimate}%
EU competitors found: ${euResults?.length || 0} (top reviews: ${euResults?.[0]?.review_count || 0})
China sources found: ${chinaResults?.length || 0}
Top complaint: ${reviewInsights?.top_complaints?.[0] || 'none'}
Category: ${product.category_auto}

Scoring guide:
- Category attractiveness: 5 = large growing market, 1 = tiny or declining
- Product demand: 5 = high search + sales evidence, 1 = no real demand signal
- Competition difficulty: 5 = easy to enter (fragmented), 1 = impossible (dominated)
- Sourcing feasibility: 5 = many suppliers, low MOQ, 1 = few sources, high MOQ
- Margin quality: 5 = >45% gross, 1 = <15% gross`;

  const parsed = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    messages: [{ role: 'user', content: scorePrompt }]
  });

  const scores = JSON.parse(parsed.content[0].text.replace(/```json|```/g, '').trim());
  const total = (scores.category_attractiveness + scores.product_demand +
    scores.competition_difficulty + scores.sourcing_feasibility + scores.margin_quality) / 5;

  return { ...scores, total: Math.round(total * 10) / 10 };
}

// ============================================================
// MAIN: RUN FULL INTELLIGENCE ON ONE PRODUCT
// ============================================================
async function enrichProduct(productId) {
  const { data: product } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .single();

  if (!product) return;

  console.log(`Enriching: ${product.product_name}`);

  // Parallel scraping
  const [amazonDE, emag, alibaba] = await Promise.all([
    scrapeAmazonDE(product.product_name, product.search_keywords),
    scrapeEMAG(product.product_name),
    scrapeAlibaba(product.product_name)
  ]);

  // Review insights
  const reviewInsights = await extractReviewInsights(product.product_name, amazonDE);

  // Calculate EU avg price
  const allEuPrices = [...amazonDE, ...emag].map(p => p.price_eur).filter(Boolean);
  const euAvgPrice = allEuPrices.length
    ? Math.round((allEuPrices.reduce((a, b) => a + b, 0) / allEuPrices.length) * 100) / 100
    : null;

  // China price floor
  const chinaFloorUsd = alibaba.length
    ? Math.min(...alibaba.map(p => p.price_usd_min).filter(Boolean))
    : null;

  // Margin calculation
  const grossMargin = calculateMargin({
    exworks_price_usd: product.exworks_price_usd_min || (chinaFloorUsd),
    eu_avg_price_eur: euAvgPrice,
    weight_grams: product.weight_grams,
    hs_customs_duty_rate: product.hs_customs_duty_rate
  });

  // Build update
  const update = {
    eu_top_competitors: [...amazonDE.slice(0, 3), ...emag.slice(0, 2)],
    eu_avg_price_eur: euAvgPrice,
    eu_price_range_min: allEuPrices.length ? Math.min(...allEuPrices) : null,
    eu_price_range_max: allEuPrices.length ? Math.max(...allEuPrices) : null,
    eu_review_insights: reviewInsights,
    china_source_matches: alibaba,
    china_price_floor_cny: chinaFloorUsd ? chinaFloorUsd * 7.2 : null,
    gross_margin_estimate: grossMargin,
    image_search_done: true,
    image_search_at: new Date().toISOString()
  };

  // Calculate scores
  const scores = await calculateScore({ ...product, ...update }, amazonDE, alibaba, reviewInsights);
  update.score_category_attractiveness = scores.category_attractiveness;
  update.score_product_demand = scores.product_demand;
  update.score_competition_difficulty = scores.competition_difficulty;
  update.score_sourcing_feasibility = scores.sourcing_feasibility;
  update.score_margin_quality = scores.margin_quality;
  update.total_score = scores.total;

  // Save to database
  await supabase.from('products').update(update).eq('id', productId);
  console.log(`✓ ${product.product_name} — score ${scores.total}/5, margin ~${grossMargin}%`);

  return { ...product, ...update, scores };
}

// ============================================================
// BATCH: ENRICH ALL UN-SCRAPED PRODUCTS FOR A SESSION
// ============================================================
async function enrichAllProducts(sessionId) {
  const { data: products } = await supabase
    .from('products')
    .select('id, product_name')
    .eq('fair_session_id', sessionId)
    .eq('image_search_done', false)
    .order('created_at');

  console.log(`Enriching ${products?.length || 0} products overnight...`);

  for (const product of (products || [])) {
    await enrichProduct(product.id);
    await sleep(2000); // Rate limiting
  }

  console.log('Overnight enrichment complete.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { enrichProduct, enrichAllProducts };
