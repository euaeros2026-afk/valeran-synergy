'use strict';
// Synergy Ventures - Image Search Module
// Google Cloud Vision API + ScraperAPI reverse product search
// Searches: Amazon DE, eMAG BG/RO, Alibaba, 1688, AliExpress

const VISION_KEY = process.env.GOOGLE_API_KEY;
const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const SCRAPER_BASE = 'https://api.scraperapi.com';

async function callVisionAPI(base64Image, mimeType) {
  if (!VISION_KEY) throw new Error('GOOGLE_API_KEY not set');
  const endpoint = 'https://vision.googleapis.com/v1/images:annotate?key=' + VISION_KEY;
  const body = {
    requests: [{
      image: { content: base64Image },
      features: [
        { type: 'LABEL_DETECTION',       maxResults: 12 },
        { type: 'WEB_DETECTION',         maxResults: 12 },
        { type: 'OBJECT_LOCALIZATION',   maxResults: 6  },
        { type: 'TEXT_DETECTION'                        }
      ]
    }]
  };
  const ctrl = new AbortController();
  setTimeout(function() { ctrl.abort(); }, 20000);
  const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
  if (!r.ok) throw new Error('Vision API ' + r.status + ': ' + await r.text());
  const data = await r.json();
  if (!data.responses || !data.responses[0]) throw new Error('Vision API empty response');
  return data.responses[0];
}

function extractSearchTerms(visionResult) {
  const terms = [];
  const seen = new Set();
  function add(s) {
    if (!s) return;
    const clean = s.trim();
    if (clean.length < 3 || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    terms.push(clean);
  }
  // Web entities are most accurate for product names
  if (visionResult.webDetection && visionResult.webDetection.webEntities) {
    visionResult.webDetection.webEntities
      .filter(function(e) { return e.score > 0.45 && e.description; })
      .slice(0, 6).forEach(function(e) { add(e.description); });
  }
  // Labels
  if (visionResult.labelAnnotations) {
    visionResult.labelAnnotations
      .filter(function(l) { return l.score > 0.75; })
      .slice(0, 5).forEach(function(l) { add(l.description); });
  }
  // Text in image (model numbers, brand names)
  if (visionResult.textAnnotations && visionResult.textAnnotations[0]) {
    const text = visionResult.textAnnotations[0].description || '';
    text.split('\n').slice(0, 4).forEach(function(line) {
      if (line.length >= 3 && line.length <= 60) add(line.trim());
    });
  }
  // Object names
  if (visionResult.localizedObjectAnnotations) {
    visionResult.localizedObjectAnnotations
      .filter(function(o) { return o.score > 0.7; })
      .forEach(function(o) { add(o.name); });
  }
  return terms.slice(0, 8);
}

async function scrape(url) {
  if (!SCRAPER_KEY) throw new Error('SCRAPER_API_KEY not configured');
  const target = SCRAPER_BASE + '?api_key=' + SCRAPER_KEY + '&url=' + encodeURIComponent(url) + '&render=false&country_code=de';
  const ctrl = new AbortController();
  setTimeout(function() { ctrl.abort(); }, 28000);
  const r = await fetch(target, { signal: ctrl.signal });
  if (!r.ok) throw new Error('ScraperAPI returned ' + r.status);
  return await r.text();
}

function parseAmazonDE(html, kw) {
  const out = [];
  // Match product titles in search results
  const re = /<span class="a-size-medium[^"]*">([^<]{15,150})<\/span>/g;
  const priceRe = /class="a-price-whole">([\d.,]+)/g;
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push(pm[1]);
  let i = 0; let m;
  while ((m = re.exec(html)) && out.length < 5) {
    const title = m[1].replace(/&amp;/g,'&').replace(/&#\d+;/g,'').trim();
    if (title.length < 10) continue;
    out.push({ title: title, price: prices[i] ? prices[i] + ' EUR' : null, source: 'Amazon DE', url: 'https://www.amazon.de/s?k=' + encodeURIComponent(kw) });
    i++;
  }
  return out;
}

function parseAlibaba(html, kw) {
  const out = [];
  const re = /class="[^"]*title[^"]*"[^>]*>\s*<a[^>]*>([^<]{10,150})<\/a>/g;
  const priceRe = /\$([\d.]+)\s*-\s*\$([\d.]+)/g;
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push('$' + pm[1] + '-$' + pm[2]);
  let m; let i = 0;
  while ((m = re.exec(html)) && out.length < 5) {
    const title = m[1].replace(/&amp;/g,'&').trim();
    if (title.length < 8) continue;
    out.push({ title: title, price: prices[i] ? prices[i] + ' USD exw' : null, source: 'Alibaba', url: 'https://www.alibaba.com/trade/search?SearchText=' + encodeURIComponent(kw) });
    i++;
  }
  return out;
}

function parse1688(html, kw) {
  const out = [];
  // 1688 titles are in various span/div structures
  const re = /<div class="[^"]*title[^"]*"[^>]*>([^<]{5,100})<\/div>/g;
  const priceRe = /class="[^"]*price[^"]*"[^>]*>\s*([\d.,￥]+)/g;
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push(pm[1] + ' CNY');
  let m; let i = 0;
  while ((m = re.exec(html)) && out.length < 5) {
    const title = m[1].trim();
    if (title.length < 4) continue;
    out.push({ title: title, price: prices[i] || null, source: '1688.com', url: 'https://s.1688.com/selloffer/offer_search.htm?keywords=' + encodeURIComponent(kw) });
    i++;
  }
  return out;
}

function parseEmag(html, kw) {
  const out = [];
  const re = /class="card-v2-title[^"]*"[^>]*>([^<]{8,120})</g;
  const priceRe = /class="[^"]*product-new-price[^"]*"[^>]*>([\d.,\s]+)<span/g;
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push(pm[1].trim() + ' Lei');
  let m; let i = 0;
  while ((m = re.exec(html)) && out.length < 5) {
    const title = m[1].replace(/&amp;/g,'&').trim();
    if (title.length < 5) continue;
    out.push({ title: title, price: prices[i] || null, source: 'eMAG BG', url: 'https://www.emag.bg/search/' + encodeURIComponent(kw) });
    i++;
  }
  return out;
}

function parseAliexpress(html, kw) {
  const out = [];
  const re = /productTitle[^"]*"[^>]*>([^<]{10,120})</g;
  const priceRe = /formatPrice[^>]*>\$([\d.]+)/g;
  const prices = []; let pm;
  while ((pm = priceRe.exec(html)) && prices.length < 10) prices.push('$' + pm[1]);
  let m; let i = 0;
  while ((m = re.exec(html)) && out.length < 5) {
    const title = m[1].replace(/&amp;/g,'&').trim();
    if (title.length < 8) continue;
    out.push({ title: title, price: prices[i] || null, source: 'AliExpress', url: 'https://www.aliexpress.com/w/wholesale-' + encodeURIComponent(kw).replace(/%20/g,'-') + '.html' });
    i++;
  }
  return out;
}

async function searchProduct(base64Image, mimeType, opts) {
  opts = opts || {};
  var result = { vision: {}, searchTerms: [], markets: {}, errors: [] };

  // Step 1: Vision API
  var visionData = null;
  if (base64Image && VISION_KEY) {
    try {
      visionData = await callVisionAPI(base64Image, mimeType || 'image/jpeg');
      result.vision.labels = (visionData.labelAnnotations || []).slice(0, 8).map(function(l) { return l.description; });
      result.vision.webEntities = ((visionData.webDetection || {}).webEntities || [])
        .filter(function(e) { return e.score > 0.4 && e.description; })
        .slice(0, 8).map(function(e) { return e.description; });
      result.vision.text = visionData.textAnnotations && visionData.textAnnotations[0] ? visionData.textAnnotations[0].description.slice(0, 300) : '';
      result.vision.objects = (visionData.localizedObjectAnnotations || []).filter(function(o) { return o.score > 0.6; }).slice(0, 4).map(function(o) { return o.name; });
      result.searchTerms = extractSearchTerms(visionData);
    } catch(e) {
      result.errors.push('Vision: ' + e.message);
      result.vision.error = e.message;
    }
  }

  // Determine search query
  var kw = opts.keywords || result.searchTerms.slice(0, 3).join(' ') || '';
  if (!kw) { result.errors.push('No search terms found'); return result; }
  result.queryUsed = kw;

  // Step 2: Parallel market scraping
  if (SCRAPER_KEY) {
    var tasks = [
      scrape('https://www.amazon.de/s?k=' + encodeURIComponent(kw) + '&language=en_GB')
        .then(function(html) { result.markets['Amazon DE'] = parseAmazonDE(html, kw); })
        .catch(function(e) { result.markets['Amazon DE'] = []; result.errors.push('AmazonDE: ' + e.message); }),
      scrape('https://www.alibaba.com/trade/search?SearchText=' + encodeURIComponent(kw) + '&IndexArea=product_en')
        .then(function(html) { result.markets['Alibaba'] = parseAlibaba(html, kw); })
        .catch(function(e) { result.markets['Alibaba'] = []; result.errors.push('Alibaba: ' + e.message); }),
      scrape('https://s.1688.com/selloffer/offer_search.htm?keywords=' + encodeURIComponent(kw))
        .then(function(html) { result.markets['1688'] = parse1688(html, kw); })
        .catch(function(e) { result.markets['1688'] = []; result.errors.push('1688: ' + e.message); }),
      scrape('https://www.emag.bg/search/' + encodeURIComponent(kw))
        .then(function(html) { result.markets['eMAG'] = parseEmag(html, kw); })
        .catch(function(e) { result.markets['eMAG'] = []; result.errors.push('eMAG: ' + e.message); }),
      scrape('https://www.aliexpress.com/w/wholesale-' + encodeURIComponent(kw).replace(/%20/g,'-') + '.html')
        .then(function(html) { result.markets['AliExpress'] = parseAliexpress(html, kw); })
        .catch(function(e) { result.markets['AliExpress'] = []; result.errors.push('AliExpress: ' + e.message); })
    ];
    await Promise.all(tasks);
  } else {
    result.errors.push('SCRAPER_API_KEY not configured - set it in Vercel environment variables');
  }

  return result;
}

function formatForAI(r) {
  var lines = [];
  if (r.vision && r.vision.webEntities && r.vision.webEntities.length) {
    lines.push('Product identified: ' + r.vision.webEntities.slice(0,4).join(', '));
  }
  if (r.vision && r.vision.objects && r.vision.objects.length) {
    lines.push('Objects detected: ' + r.vision.objects.join(', '));
  }
  if (r.vision && r.vision.text && r.vision.text.length > 3) {
    lines.push('Text visible in image: ' + r.vision.text.slice(0,200));
  }
  if (r.queryUsed) lines.push('Search query: ' + r.queryUsed);
  lines.push('');
  for (var market in r.markets) {
    var items = r.markets[market];
    if (!items || !items.length) { lines.push(market + ': no results found'); continue; }
    lines.push(market + ':');
    items.slice(0,4).forEach(function(item) {
      lines.push('  - ' + item.title + (item.price ? ' [' + item.price + ']' : ''));
    });
  }
  if (r.errors && r.errors.length) {
    lines.push('\nSearch notes: ' + r.errors.join('; '));
  }
  return lines.join('\n');
}

module.exports = {
  searchProduct: searchProduct,
  callVisionAPI: callVisionAPI,
  extractSearchTerms: extractSearchTerms,
  formatForAI: formatForAI
};
