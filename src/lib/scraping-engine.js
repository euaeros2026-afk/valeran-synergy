'use strict';
var supabaseJs = require('@supabase/supabase-js');
var supabase = supabaseJs.createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
var SCRAPER_KEY = process.env.SCRAPERAPI_KEY || process.env.SCRAPER_API_KEY || '';

async function scrapeAmazonDE(query, productId) {
  if (!SCRAPER_KEY) return [];
  try {
    var url = 'https://www.amazon.de/s?k=' + encodeURIComponent(query) + '&language=en_GB';
    var scraperUrl = 'https://api.scraperapi.com/?api_key=' + SCRAPER_KEY + '&url=' + encodeURIComponent(url);
    var ctrl = new AbortController();
    var timer = setTimeout(function() { ctrl.abort(); }, 30000);
    var r = await fetch(scraperUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    var html = await r.text();
    var results = [];
    var titleRegex = /aria-label="([^"]{10,200})"/g;
    var ratingRegex = /([\d.]+) out of 5/g;
    var priceRegex = /class="a-offscreen">([^<]+)</g;
    var titles = [], ratings = [], prices = [], m;
    while ((m = titleRegex.exec(html)) !== null && titles.length < 8) titles.push(m[1].trim());
    while ((m = ratingRegex.exec(html)) !== null && ratings.length < 8) ratings.push(parseFloat(m[1]));
    while ((m = priceRegex.exec(html)) !== null && prices.length < 8) prices.push(m[1]);
    for (var i = 0; i < Math.min(titles.length, 5); i++) {
      var priceEur = prices[i] ? parseFloat(prices[i].replace(/[^\d.,]/g, '').replace(',', '.')) : null;
      var result = { product_id: productId || null, platform: 'amazon_de', search_query: query, product_name: titles[i] ? titles[i].slice(0, 200) : null, price_eur: priceEur, rating: ratings[i] || null, url: url, raw_data: { position: i + 1 } };
      results.push(result);
      await supabase.from('product_research').insert(result);
    }
    console.log('[scraper] Amazon DE:', results.length, 'for', query);
    return results;
  } catch(e) { console.error('[scraper] Amazon DE:', e.message); return []; }
}

async function scrapeAlibaba(query, productId) {
  if (!SCRAPER_KEY) return [];
  try {
    var url = 'https://www.alibaba.com/trade/search?SearchText=' + encodeURIComponent(query);
    var scraperUrl = 'https://api.scraperapi.com/?api_key=' + SCRAPER_KEY + '&url=' + encodeURIComponent(url);
    var ctrl = new AbortController();
    var timer = setTimeout(function() { ctrl.abort(); }, 30000);
    var r = await fetch(scraperUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    var html = await r.text();
    var results = [];
    var priceRegex = /\$([\d.]+)\s*-\s*\$([\d.]+)/g;
    var titleRegex = /class="[^"]*product-title[^"]*"[^>]*>([^<]{10,200})<\/a>/g;
    var titles = [], prices = [], m;
    while ((m = titleRegex.exec(html)) !== null && titles.length < 8) titles.push(m[1].trim());
    while ((m = priceRegex.exec(html)) !== null && prices.length < 8) prices.push({ min: parseFloat(m[1]), max: parseFloat(m[2]) });
    for (var i = 0; i < Math.min(titles.length, 5); i++) {
      var result = { product_id: productId || null, platform: 'alibaba', search_query: query, product_name: titles[i] ? titles[i].slice(0, 200) : null, price_eur: prices[i] ? prices[i].min * 0.92 : null, url: url, raw_data: { price_range_usd: prices[i], position: i + 1 } };
      results.push(result);
      await supabase.from('product_research').insert(result);
    }
    console.log('[scraper] Alibaba:', results.length, 'for', query);
    return results;
  } catch(e) { console.error('[scraper] Alibaba:', e.message); return []; }
}

async function researchProduct(productName, productId) {
  console.log('[scraper] Researching:', productName);
  var eu = await scrapeAmazonDE(productName, productId).catch(function() { return []; });
  var cn = await scrapeAlibaba(productName, productId).catch(function() { return []; });
  return { eu: eu, cn: cn };
}

async function enrichAllProducts(sessionId) {
  console.log('[scraper] Enrichment start for session:', sessionId);
  var result = await supabase.from('products').select('id, name').eq('session_id', sessionId).limit(20);
  var products = result.data || [];
  if (!products.length) { console.log('[scraper] No products'); return; }
  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    if (p.name) {
      await researchProduct(p.name, p.id).catch(function() {});
      await new Promise(function(resolve) { setTimeout(resolve, 3000); });
    }
  }
  console.log('[scraper] Enrichment done for', products.length, 'products');
}

module.exports = { enrichAllProducts: enrichAllProducts, researchProduct: researchProduct, scrapeAmazonDE: scrapeAmazonDE, scrapeAlibaba: scrapeAlibaba };