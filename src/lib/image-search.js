'use strict';
// Synergy Ventures - Image Search Module
// Google Vision API (env: GOOGLE_API_KEY) + ScraperAPI (env: SCRAPERAPI_KEY)
// Searches: Amazon DE, eMAG BG, Alibaba, 1688, AliExpress

const VISION_KEY  = process.env.GOOGLE_API_KEY;
const SCRAPER_KEY = process.env.SCRAPERAPI_KEY;

async function callVisionAPI(base64Image, mimeType) {
  if (!VISION_KEY) throw new Error('GOOGLE_API_KEY not set');
  const ctrl = new AbortController();
  setTimeout(function() { ctrl.abort(); }, 20000);
  const r = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + VISION_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
    body: JSON.stringify({ requests: [{ image: { content: base64Image }, features: [
      { type: 'LABEL_DETECTION', maxResults: 12 },
      { type: 'WEB_DETECTION',   maxResults: 12 },
      { type: 'OBJECT_LOCALIZATION', maxResults: 6 },
      { type: 'TEXT_DETECTION' }
    ]}]})
  });
  if (!r.ok) throw new Error('Vision API ' + r.status + ': ' + await r.text());
  const data = await r.json();
  if (!data.responses || !data.responses[0]) throw new Error('Vision API empty response');
  return data.responses[0];
}

function extractSearchTerms(visionResult) {
  const terms = []; const seen = new Set();
  function add(s) {
    if (!s) return;
    const c = s.trim();
    if (c.length < 3 || seen.has(c.toLowerCase())) return;
    seen.add(c.toLowerCase()); terms.push(c);
  }
  if (visionResult.webDetection && visionResult.webDetection.webEntities)
    visionResult.webDetection.webEntities.filter(e => e.score > 0.45 && e.description).slice(0,6).forEach(e => add(e.description));
  if (visionResult.labelAnnotations)
    visionResult.labelAnnotations.filter(l => l.score > 0.75).slice(0,5).forEach(l => add(l.description));
  if (visionResult.textAnnotations && visionResult.textAnnotations[0])
    visionResult.textAnnotations[0].description.split('\n').slice(0,4).forEach(l => { if (l.length >= 3 && l.length <= 60) add(l.trim()); });
  if (visionResult.localizedObjectAnnotations)
    visionResult.localizedObjectAnnotations.filter(o => o.score > 0.7).forEach(o => add(o.name));
  return terms.slice(0, 8);
}

async function scrape(targetUrl, cc) {
  if (!SCRAPER_KEY) throw new Error('SCRAPERAPI_KEY not configured in Vercel env vars');
  const ctrl = new AbortController();
  setTimeout(function() { ctrl.abort(); }, 28000);
  const r = await fetch('https://api.scraperapi.com?api_key=' + SCRAPER_KEY + '&url=' + encodeURIComponent(targetUrl) + '&render=false&country_code=' + (cc||'de'), { signal: ctrl.signal });
  if (!r.ok) throw new Error('ScraperAPI ' + r.status);
  return await r.text();
}

function parseResults(html, titleRe, priceRe, source, searchUrl) {
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push(pm[1].trim());
  const results = []; let tm; let i = 0;
  while ((tm = titleRe.exec(html)) && results.length < 5) {
    const t = tm[1].replace(/&amp;/g,'&').replace(/&#[0-9]+;/g,'').trim();
    if (t.length < 6) { i++; continue; }
    results.push({ title: t, price: prices[i] || null, source: source, url: searchUrl });
    i++;
  }
  return results;
}

async function searchProduct(base64Image, mimeType, opts) {
  opts = opts || {};
  const result = { vision: {}, searchTerms: [], markets: {}, errors: [] };

  if (base64Image && VISION_KEY) {
    try {
      const v = await callVisionAPI(base64Image, mimeType || 'image/jpeg');
      result.vision.labels      = (v.labelAnnotations||[]).slice(0,8).map(l=>l.description);
      result.vision.webEntities = ((v.webDetection||{}).webEntities||[]).filter(e=>e.score>0.4&&e.description).slice(0,8).map(e=>e.description);
      result.vision.text        = v.textAnnotations && v.textAnnotations[0] ? v.textAnnotations[0].description.slice(0,300) : '';
      result.vision.objects     = (v.localizedObjectAnnotations||[]).filter(o=>o.score>0.6).slice(0,4).map(o=>o.name);
      result.searchTerms        = extractSearchTerms(v);
    } catch(e) { result.errors.push('Vision: ' + e.message); result.vision.error = e.message; }
  }

  const kw = opts.keywords || result.searchTerms.slice(0,3).join(' ') || '';
  if (!kw) { result.errors.push('No search terms'); return result; }
  result.queryUsed = kw;

  if (SCRAPER_KEY) {
    await Promise.all([
      scrape('https://www.amazon.de/s?k=' + encodeURIComponent(kw) + '&language=en_GB','de')
        .then(html => { result.markets['Amazon DE'] = parseResults(html,
          /class="a-size-medium[^"]*">([^<]{10,120})<\/span>/g,
          /class="a-price-whole">([\d.]+)<\/span>/g, 'Amazon DE',
          'https://www.amazon.de/s?k=' + encodeURIComponent(kw)); })
        .catch(e => { result.markets['Amazon DE']=[]; result.errors.push('AmazonDE: '+e.message); }),
      scrape('https://www.alibaba.com/trade/search?SearchText=' + encodeURIComponent(kw) + '&IndexArea=product_en','us')
        .then(html => { result.markets['Alibaba'] = parseResults(html,
          /class="[^"]*search-card-e-title[^"]*"[^>]*>\s*<[^>]+>([^<]{8,150})<\/[^>]+>/g,
          /\$([\d.]+-[\d.]+)/g, 'Alibaba',
          'https://www.alibaba.com/trade/search?SearchText=' + encodeURIComponent(kw)); })
        .catch(e => { result.markets['Alibaba']=[]; result.errors.push('Alibaba: '+e.message); }),
      scrape('https://s.1688.com/selloffer/offer_search.htm?keywords=' + encodeURIComponent(kw),'cn')
        .then(html => { result.markets['1688'] = parseResults(html,
          /class="[^"]*title[^"]*"[^>]*>([^<]{5,100})<\/[^>]+>/g,
          /class="[^"]*price[^"]*"[^>]*>([\d.]+)/g, '1688.com',
          'https://s.1688.com/selloffer/offer_search.htm?keywords=' + encodeURIComponent(kw)); })
        .catch(e => { result.markets['1688']=[]; result.errors.push('1688: '+e.message); }),
      scrape('https://www.emag.bg/search/' + encodeURIComponent(kw),'bg')
        .then(html => { result.markets['eMAG'] = parseResults(html,
          /class="card-v2-title[^"]*"[^>]*>([^<]{8,120})</g,
          /class="[^"]*product-new-price[^"]*"[^>]*>([\d\s.,]+)<span/g, 'eMAG BG',
          'https://www.emag.bg/search/' + encodeURIComponent(kw)); })
        .catch(e => { result.markets['eMAG']=[]; result.errors.push('eMAG: '+e.message); }),
      scrape('https://www.aliexpress.com/w/wholesale-' + encodeURIComponent(kw).replace(/%20/g,'-') + '.html','us')
        .then(html => { result.markets['AliExpress'] = parseResults(html,
          /productTitle[^"]*"[^>]*>([^<]{10,120})</g,
          /formatPrice[^>]*>\$([\d.]+)/g, 'AliExpress',
          'https://www.aliexpress.com/w/wholesale-' + encodeURIComponent(kw).replace(/%20/g,'-') + '.html'); })
        .catch(e => { result.markets['AliExpress']=[]; result.errors.push('AliExpress: '+e.message); })
    ]);
  } else {
    result.errors.push('SCRAPERAPI_KEY not set - add to Vercel env vars');
  }
  return result;
}

function formatForAI(r) {
  const lines = [];
  if (r.vision && r.vision.webEntities && r.vision.webEntities.length)
    lines.push('Product identified: ' + r.vision.webEntities.slice(0,4).join(', '));
  if (r.vision && r.vision.objects && r.vision.objects.length)
    lines.push('Objects detected: ' + r.vision.objects.join(', '));
  if (r.vision && r.vision.text && r.vision.text.length > 3)
    lines.push('Text in image: ' + r.vision.text.slice(0,200));
  if (r.queryUsed) lines.push('Search query: ' + r.queryUsed);
  lines.push('');
  for (const market in r.markets) {
    const items = r.markets[market];
    if (!items || !items.length) { lines.push(market + ': no results'); continue; }
    lines.push(market + ':');
    items.slice(0,4).forEach(item => lines.push('  - ' + item.title + (item.price ? ' [' + item.price + ']' : '')));
  }
  if (r.errors && r.errors.length) lines.push('Notes: ' + r.errors.join('; '));
  return lines.join('\n');
}

module.exports = { searchProduct, callVisionAPI, extractSearchTerms, formatForAI };
