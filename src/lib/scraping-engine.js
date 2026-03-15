'use strict';
// Synergy Ventures - Scraping Engine
// Uses ScraperAPI to pull price data from Amazon DE, eMAG, 1688, Alibaba
// ScraperAPI key stored in process.env.SCRAPERAPI_KEY

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SCRAPER_KEY = process.env.SCRAPERAPI_KEY;

async function scrape(targetUrl, countryCode) {
  if (!SCRAPER_KEY) throw new Error('SCRAPER_API_KEY not set in Vercel environment variables');
  const cc = countryCode || 'de';
  const url = 'https://api.scraperapi.com?api_key=' + SCRAPER_KEY + '&url=' + encodeURIComponent(targetUrl) + '&render=false&country_code=' + cc;
  const ctrl = new AbortController();
  setTimeout(function() { ctrl.abort(); }, 30000);
  const r = await fetch(url, { signal: ctrl.signal });
  if (!r.ok) throw new Error('ScraperAPI ' + r.status + ' for ' + targetUrl);
  return await r.text();
}

async function scrapeAmazonDE(query, productId) {
  const searchUrl = 'https://www.amazon.de/s?k=' + encodeURIComponent(query) + '&language=en_GB';
  console.log('[scraper] Amazon DE:', query);
  const html = await scrape(searchUrl, 'de');
  const results = [];
  // Match price + ASIN from search result page
  const priceRe = /class="a-price-whole">([\d.]+)<\/span>/g;
  const titleRe = /<span class="a-size-medium[^"]*">([^<]{10,120})<\/span>/g;
  const asinRe = /data-asin="([A-Z0-9]{10})"/g;
  const asins = []; let am;
  while ((am = asinRe.exec(html)) && asins.length < 10) if (!asins.includes(am[1])) asins.push(am[1]);
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push(parseFloat(pm[1].replace('.','').replace(',','.')));
  let tm; let i = 0;
  while ((tm = titleRe.exec(html)) && results.length < 5) {
    const title = tm[1].replace(/&amp;/g,'&').replace(/&#\d+;/g,'').trim();
    if (title.length < 10) { i++; continue; }
    results.push({
      source: 'amazon_de',
      title: title,
      price_eur: prices[i] || null,
      asin: asins[i] || null,
      url: asins[i] ? 'https://www.amazon.de/dp/' + asins[i] : searchUrl
    });
    i++;
  }
  console.log('[scraper] Amazon DE found', results.length, 'results');
  return results;
}

async function scrapeAlibaba(query, productId) {
  const searchUrl = 'https://www.alibaba.com/trade/search?SearchText=' + encodeURIComponent(query) + '&IndexArea=product_en';
  console.log('[scraper] Alibaba:', query);
  const html = await scrape(searchUrl, 'us');
  const results = [];
  const priceRe = /\$([\d.]+)\s*-\s*\$([\d.]+)/g;
  const titleRe = /class="[^"]*search-card-e-title[^"]*"[^>]*>\s*<a[^>]*>([^<]{10,150})<\/a>/g;
  const moqRe = /Minimum order quantity[^\d]*(\d+)/gi;
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push({ min: parseFloat(pm[1]), max: parseFloat(pm[2]) });
  const moqs = []; let mm;
  while ((mm = moqRe.exec(html)) && moqs.length < 10) moqs.push(parseInt(mm[1]));
  let tm; let i = 0;
  while ((tm = titleRe.exec(html)) && results.length < 5) {
    const title = tm[1].replace(/&amp;/g,'&').trim();
    if (title.length < 8) { i++; continue; }
    results.push({
      source: 'alibaba',
      title: title,
      price_usd_min: prices[i] ? prices[i].min : null,
      price_usd_max: prices[i] ? prices[i].max : null,
      moq: moqs[i] || null,
      url: searchUrl
    });
    i++;
  }
  console.log('[scraper] Alibaba found', results.length, 'results');
  return results;
}

async function scrape1688(query) {
  const searchUrl = 'https://s.1688.com/selloffer/offer_search.htm?keywords=' + encodeURIComponent(query);
  console.log('[scraper] 1688:', query);
  const html = await scrape(searchUrl, 'cn');
  const results = [];
  const priceRe = /class="[^"]*price[^"]*"[^>]*>[\s\S]*?([\d.]+)[\s\S]*?<\/[^>]+>/g;
  const titleRe = /class="[^"]*title[^"]*"[^>]*>([^<]{5,100})<\/[^>]+>/g;
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push(parseFloat(pm[1]));
  let tm; let i = 0;
  while ((tm = titleRe.exec(html)) && results.length < 5) {
    const title = tm[1].trim();
    if (title.length < 4) { i++; continue; }
    results.push({
      source: '1688',
      title: title,
      price_cny: prices[i] || null,
      url: searchUrl
    });
    i++;
  }
  console.log('[scraper] 1688 found', results.length, 'results');
  return results;
}

async function scrapeEmag(query) {
  const searchUrl = 'https://www.emag.bg/search/' + encodeURIComponent(query);
  console.log('[scraper] eMAG BG:', query);
  const html = await scrape(searchUrl, 'bg');
  const results = [];
  const priceRe = /class="[^"]*product-new-price[^"]*"[^>]*>([\d\s.,]+)<span/g;
  const titleRe = /class="card-v2-title[^"]*"[^>]*>([^<]{8,120})</g;
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push(pm[1].replace(/\s/g,'').trim());
  let tm; let i = 0;
  while ((tm = titleRe.exec(html)) && results.length < 5) {
    const title = tm[1].replace(/&amp;/g,'&').trim();
    if (title.length < 5) { i++; continue; }
    results.push({
      source: 'emag_bg',
      title: title,
      price_bgn: prices[i] ? parseFloat(prices[i].replace(',','.')) : null,
      url: searchUrl
    });
    i++;
  }
  console.log('[scraper] eMAG found', results.length, 'results');
  return results;
}

async function researchProduct(productName, productId) {
  console.log('[scraper] researching product:', productName);
  var [amazonResults, alibabaResults, res1688, emagResults] = await Promise.allSettled([
    scrapeAmazonDE(productName, productId),
    scrapeAlibaba(productName, productId),
    scrape1688(productName),
    scrapeEmag(productName)
  ]);
  var allResults = {
    product_id: productId,
    product_name: productName,
    amazon_de: amazonResults.status === 'fulfilled' ? amazonResults.value : [],
    alibaba: alibabaResults.status === 'fulfilled' ? alibabaResults.value : [],
    c1688: res1688.status === 'fulfilled' ? res1688.value : [],
    emag_bg: emagResults.status === 'fulfilled' ? emagResults.value : [],
    errors: [amazonResults, alibabaResults, res1688, emagResults]
      .filter(function(r) { return r.status === 'rejected'; })
      .map(function(r) { return r.reason && r.reason.message; }),
    scraped_at: new Date().toISOString()
  };
  // Save to Supabase products table as notes / research cache
  if (productId) {
    try {
      await supabase.from('products').update({
        notes: JSON.stringify(allResults).slice(0, 2000)
      }).eq('id', productId);
    } catch(e) { console.error('[scraper] save error', e.message); }
  }
  return allResults;
}

async function enrichAllProducts(sessionId) {
  console.log('[scraper] enrichAllProducts session:', sessionId);
  if (!SCRAPER_KEY) { console.log('[scraper] SCRAPER_API_KEY not set, skipping enrichment'); return; }
  try {
    var r = await supabase.from('products')
      .select('id,product_name,notes')
      .order('created_at', { ascending: false })
      .limit(5);
    if (!r.data || !r.data.length) { console.log('[scraper] no products to enrich'); return; }
    for (var p of r.data) {
      // Skip if already researched in last 24h
      if (p.notes) {
        try {
          var cached = JSON.parse(p.notes);
          if (cached.scraped_at && (Date.now() - new Date(cached.scraped_at).getTime()) < 86400000) {
            console.log('[scraper] skip (fresh):', p.product_name); continue;
          }
        } catch(e) {}
      }
      await researchProduct(p.product_name, p.id);
      await new Promise(function(resolve) { setTimeout(resolve, 2000); }); // Rate limit
    }
  } catch(e) { console.error('[enrichAll]', e.message); }
}

module.exports = {
  scrapeAmazonDE: scrapeAmazonDE,
  scrapeAlibaba: scrapeAlibaba,
  scrape1688: scrape1688,
  scrapeEmag: scrapeEmag,
  researchProduct: researchProduct,
  enrichAllProducts: enrichAllProducts
};
