'use strict';
// Synergy Ventures - Scraping Engine v2
// Uses ScraperAPI (env: SCRAPERAPI_KEY) for price research

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const SCRAPER_KEY = process.env.SCRAPERAPI_KEY;

async function scrape(targetUrl, cc) {
  if (!SCRAPER_KEY) throw new Error('SCRAPERAPI_KEY not set in Vercel env vars');
  const url = 'https://api.scraperapi.com?api_key=' + SCRAPER_KEY + '&url=' + encodeURIComponent(targetUrl) + '&render=false&country_code=' + (cc || 'de');
  const ctrl = new AbortController();
  setTimeout(function() { ctrl.abort(); }, 30000);
  const r = await fetch(url, { signal: ctrl.signal });
  if (!r.ok) throw new Error('ScraperAPI ' + r.status);
  return await r.text();
}

async function scrapeAmazonDE(query) {
  console.log('[scraper] Amazon DE:', query);
  const html = await scrape('https://www.amazon.de/s?k=' + encodeURIComponent(query) + '&language=en_GB', 'de');
  const results = [];
  const titleRe = /class="a-size-medium[^"]*">([^<]{10,120})<\/span>/g;
  const priceRe = /class="a-price-whole">([\d.]+)<\/span>/g;
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push(pm[1] + ' EUR');
  let tm; let i = 0;
  while ((tm = titleRe.exec(html)) && results.length < 5) {
    const t = tm[1].replace(/&amp;/g,'&').trim();
    if (t.length < 10) { i++; continue; }
    results.push({ source: 'amazon_de', title: t, price: prices[i] || null, url: 'https://www.amazon.de/s?k=' + encodeURIComponent(query) });
    i++;
  }
  return results;
}

async function scrapeAlibaba(query) {
  console.log('[scraper] Alibaba:', query);
  const html = await scrape('https://www.alibaba.com/trade/search?SearchText=' + encodeURIComponent(query) + '&IndexArea=product_en', 'us');
  const results = [];
  const priceRe = /\$([\d.]+)\s*-\s*\$([\d.]+)/g;
  const titleRe = /class="[^"]*search-card-e-title[^"]*"[^>]*>\s*<[^>]+>([^<]{8,150})<\/[^>]+>/g;
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push('$' + pm[1] + '-$' + pm[2] + ' USD');
  let tm; let i = 0;
  while ((tm = titleRe.exec(html)) && results.length < 5) {
    const t = tm[1].replace(/&amp;/g,'&').trim();
    if (t.length < 8) { i++; continue; }
    results.push({ source: 'alibaba', title: t, price: prices[i] || null, url: 'https://www.alibaba.com/trade/search?SearchText=' + encodeURIComponent(query) });
    i++;
  }
  return results;
}

async function scrapeEmag(query) {
  console.log('[scraper] eMAG BG:', query);
  const html = await scrape('https://www.emag.bg/search/' + encodeURIComponent(query), 'bg');
  const results = [];
  const priceRe = /class="[^"]*product-new-price[^"]*"[^>]*>([\d\s.,]+)<span/g;
  const titleRe = /class="card-v2-title[^"]*"[^>]*>([^<]{8,120})</g;
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push(pm[1].trim() + ' BGN');
  let tm; let i = 0;
  while ((tm = titleRe.exec(html)) && results.length < 5) {
    const t = tm[1].replace(/&amp;/g,'&').trim();
    if (t.length < 5) { i++; continue; }
    results.push({ source: 'emag_bg', title: t, price: prices[i] || null, url: 'https://www.emag.bg/search/' + encodeURIComponent(query) });
    i++;
  }
  return results;
}

async function researchProduct(productName, productId) {
  console.log('[scraper] researching:', productName);
  const [amazon, alibaba, emag] = await Promise.allSettled([
    scrapeAmazonDE(productName),
    scrapeAlibaba(productName),
    scrapeEmag(productName)
  ]);
  const result = {
    product_id: productId, product_name: productName,
    amazon_de:  amazon.status  === 'fulfilled' ? amazon.value  : [],
    alibaba:    alibaba.status === 'fulfilled' ? alibaba.value : [],
    emag_bg:    emag.status    === 'fulfilled' ? emag.value    : [],
    errors: [amazon,alibaba,emag].filter(r=>r.status==='rejected').map(r=>r.reason&&r.reason.message),
    scraped_at: new Date().toISOString()
  };
  if (productId) {
    try { await supabase.from('products').update({ notes: JSON.stringify(result).slice(0,2000) }).eq('id', productId); }
    catch(e) { console.error('[scraper save]', e.message); }
  }
  return result;
}

async function enrichAllProducts(sessionId) {
  if (!SCRAPER_KEY) { console.log('[scraper] SCRAPERAPI_KEY not set, skipping'); return; }
  console.log('[scraper] enrichAll session:', sessionId);
  try {
    const r = await supabase.from('products').select('id,product_name,notes').order('created_at',{ascending:false}).limit(5);
    if (!r.data || !r.data.length) return;
    for (const p of r.data) {
      try { const c = JSON.parse(p.notes||'{}'); if (c.scraped_at && Date.now()-new Date(c.scraped_at).getTime() < 86400000) continue; } catch(e) {}
      await researchProduct(p.product_name, p.id);
      await new Promise(res => setTimeout(res, 2000));
    }
  } catch(e) { console.error('[enrichAll]', e.message); }
}

module.exports = { scrapeAmazonDE, scrapeAlibaba, scrapeEmag, researchProduct, enrichAllProducts };
