// ============================================================
// VALERAN SCRAPING ENGINE
// Uses ScraperAPI to search Amazon DE + Alibaba/1688
// Saves competitive intelligence to product_research table
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SCRAPER_KEY = process.env.SCRAPERAPI_KEY || process.env.SCRAPER_API_KEY;

// ============================================================
// SCRAPE AMAZON.DE — EU competitor data
// ============================================================
async function scrapeAmazonDE(searchQuery, productId) {
  if (!SCRAPER_KEY) { console.log('[scraper] No ScraperAPI key'); return []; }
  try {
    var url = 'https://www.amazon.de/s?k=' + encodeURIComponent(searchQuery) + '&language=en_GB';
    var scraperUrl = 'https://api.scraperapi.com/?api_key=' + SCRAPER_KEY + '&url=' + encodeURIComponent(url) + '&render=false&country_code=de';

    var r = await fetch(scraperUrl, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.error('[scraper] Amazon DE status:', r.status); return []; }
    var html = await r.text();

    // Parse results from HTML
    var results = [];
    var priceRegex = /data-asin="([^"]+)"[sS]*?class="[^"]*a-price[^"]*"[sS]*?<span class="a-offscreen">([^<]+)</span>/g;
    var titleRegex = /aria-label="([^"]{10,200})"/g;
    var ratingRegex = /([d.]+) out of 5/g;

    var titles = [], ratings = [], prices = [];
    var m;
    while ((m = titleRegex.exec(html)) !== null && titles.length < 10) titles.push(m[1].trim());
    while ((m = ratingRegex.exec(html)) !== null && ratings.length < 10) ratings.push(parseFloat(m[1]));
    while ((m = priceRegex.exec(html)) !== null && prices.length < 10) prices.push(m[2]);

    for (var i = 0; i < Math.min(titles.length, 5); i++) {
      var priceEur = prices[i] ? parseFloat(prices[i].replace(/[€,]/g, '').replace(',', '.')) : null;
      var result = {
        product_id: productId || null,
        platform: 'amazon_de',
        search_query: searchQuery,
        product_name: titles[i] ? titles[i].slice(0, 200) : null,
        price_eur: priceEur,
        rating: ratings[i] || null,
        url: url,
        raw_data: { position: i + 1 }
      };
      results.push(result);
      await supabase.from('product_research').insert(result);
    }

    console.log('[scraper] Amazon DE: found', results.length, 'results for', searchQuery);
    return results;
  } catch(e) {
    console.error('[scraper] Amazon DE error:', e.message);
    return [];
  }
}

// ============================================================
// SCRAPE ALIBABA — China supply data
// ============================================================
async function scrapeAlibaba(searchQuery, productId) {
  if (!SCRAPER_KEY) return [];
  try {
    var url = 'https://www.alibaba.com/trade/search?SearchText=' + encodeURIComponent(searchQuery) + '&IndexArea=product_en';
    var scraperUrl = 'https://api.scraperapi.com/?api_key=' + SCRAPER_KEY + '&url=' + encodeURIComponent(url) + '&render=false';

    var r = await fetch(scraperUrl, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return [];
    var html = await r.text();

    var results = [];
    // Parse price ranges and product names from Alibaba HTML
    var priceRegex = /\$([\d.]+)\s*-\s*\$([\d.]+)/g;
    var titleRegex = /class="[^"]*product-title[^"]*"[^>]*>([^<]{10,200})<\/a>/g;
    var moqRegex = /([\d,]+)\s*(?:piece|pcs|unit|set)s?\s*(?:\(min[\s.]*order\)|min\.?)/gi;

    var titles = [], prices = [], moqs = [];
    var m;
    while ((m = titleRegex.exec(html)) !== null && titles.length < 8) titles.push(m[1].trim());
    while ((m = priceRegex.exec(html)) !== null && prices.length < 8) prices.push({ min: parseFloat(m[1]), max: parseFloat(m[2]) });
    while ((m = moqRegex.exec(html)) !== null && moqs.length < 8) moqs.push(parseInt(m[1].replace(/,/g,'')));

    for (var i = 0; i < Math.min(titles.length, 5); i++) {
      var result = {
        product_id: productId || null,
        platform: 'alibaba',
        search_query: searchQuery,
        product_name: titles[i] ? titles[i].slice(0, 200) : null,
        price_eur: prices[i] ? prices[i].min * 0.92 : null, // approx USD to EUR
        url: url,
        raw_data: { price_range_usd: prices[i], moq: moqs[i] || null, position: i + 1 }
      };
      results.push(result);
      await supabase.from('product_research').insert(result);
    }

    console.log('[scraper] Alibaba: found', results.length, 'results for', searchQuery);
    return results;
  } catch(e) {
    console.error('[scraper] Alibaba error:', e.message);
    return [];
  }
}

// ============================================================
// SCRAPE AMAZON PRODUCT PAGE for reviews
// ============================================================
async function scrapeProductReviews(asin, productId) {
  if (!SCRAPER_KEY || !asin) return null;
  try {
    var url = 'https://www.amazon.de/dp/' + asin + '?language=en_GB';
    var scraperUrl = 'https://api.scraperapi.com/?api_key=' + SCRAPER_KEY + '&url=' + encodeURIComponent(url);
    var r = await fetch(scraperUrl, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    var html = await r.text();

    // Extract review snippets
    var reviewRegex = /class="[^"]*review-text[^"]*"[sS]*?<span[^>]*>([^<]{20,500})<\/span>/g;
    var reviews = [];
    var m;
    while ((m = reviewRegex.exec(html)) !== null && reviews.length < 20) {
      reviews.push(m[1].trim().replace(/\s+/g, ' '));
    }

    // Use AI to summarise complaints and praises
    if (reviews.length > 0) {
      var { callAI } = require('./valeran-core');
      var summary = await callAI([{ role: 'user', content: 'From these Amazon reviews, extract: 1) top 3 complaints, 2) top 3 praises, 3) one sentence summary.\n\nReviews:\n' + reviews.slice(0,10).join('\n') }], 'Extract insights from reviews. Be concise.', 300, 15000);

      await supabase.from('product_research').update({
        reviews_summary: summary,
        review_count: reviews.length,
        raw_data: { asin, review_snippets: reviews.slice(0,5) }
      }).eq('product_id', productId).eq('platform', 'amazon_de');

      return { summary, reviewCount: reviews.length };
    }
    return null;
  } catch(e) {
    console.error('[scraper] reviews error:', e.message);
    return null;
  }
}

// ============================================================
// FULL PRODUCT RESEARCH — runs both EU + CN searches
// ============================================================
async function researchProduct(productName, productId) {
  console.log('[scraper] Researching:', productName);
  var results = await Promise.allSettled([
    scrapeAmazonDE(productName, productId),
    scrapeAlibaba(productName, productId)
  ]);
  var euResults = results[0].value || [];
  var cnResults = results[1].value || [];
  console.log('[scraper] Research complete. EU:', euResults.length, 'CN:', cnResults.length);
  return { eu: euResults, cn: cnResults };
}

// ============================================================
// ENRICH ALL PRODUCTS (overnight batch)
// ============================================================
async function enrichAllProducts(sessionId) {
  console.log('[scraper] Starting overnight enrichment for session:', sessionId);
  var { data: products } = await supabase.from('products').select('id, name').eq('session_id', sessionId).limit(20);
  if (!products || products.length === 0) { console.log('[scraper] No products to enrich'); return; }

  for (var p of products) {
    if (p.name) {
      await researchProduct(p.name, p.id);
      await new Promise(function(resolve){ setTimeout(resolve, 3000); }); // rate limit
    }
  }
  console.log('[scraper] Enrichment complete for', products.length, 'products');
}

module.exports = { enrichAllProducts, researchProduct, scrapeAmazonDE, scrapeAlibaba };
