'use strict';
// Synergy Ventures - Image Search Module v3
// Google Cloud Vision API + ScraperAPI market search

var VISION_KEY  = process.env.GOOGLE_API_KEY;
var SCRAPER_KEY = process.env.SCRAPERAPI_KEY;

function scrapeUrl(targetUrl, countryCode) {
  if (!SCRAPER_KEY) {
    return Promise.reject(new Error('SCRAPERAPI_KEY not set in Vercel environment variables'));
  }
  var apiUrl = 'https://api.scraperapi.com?api_key=' + SCRAPER_KEY +
    '&url=' + encodeURIComponent(targetUrl) +
    '&render=false&country_code=' + (countryCode || 'de');
  var ctrl = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, 28000);
  return fetch(apiUrl, { signal: ctrl.signal })
    .then(function(r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('ScraperAPI HTTP ' + r.status);
      return r.text();
    });
}

function callVisionAPI(base64Image, mimeType) {
  if (!VISION_KEY) return Promise.reject(new Error('GOOGLE_API_KEY not set'));
  var url = 'https://vision.googleapis.com/v1/images:annotate?key=' + VISION_KEY;
  var body = JSON.stringify({
    requests: [{
      image: { content: base64Image },
      features: [
        { type: 'LABEL_DETECTION',     maxResults: 12 },
        { type: 'WEB_DETECTION',       maxResults: 12 },
        { type: 'OBJECT_LOCALIZATION', maxResults: 6  },
        { type: 'TEXT_DETECTION'                      }
      ]
    }]
  });
  var ctrl = new AbortController();
  var timer = setTimeout(function() { ctrl.abort(); }, 20000);
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, signal: ctrl.signal })
    .then(function(r) {
      clearTimeout(timer);
      if (!r.ok) return r.text().then(function(t) { throw new Error('Vision API ' + r.status + ': ' + t); });
      return r.json();
    })
    .then(function(data) {
      if (!data.responses || !data.responses[0]) throw new Error('Vision API empty response');
      return data.responses[0];
    });
}

function extractSearchTerms(visionResult) {
  var terms = [];
  var seen = {};
  function add(s) {
    if (!s) return;
    var c = s.trim();
    if (c.length < 3 || seen[c.toLowerCase()]) return;
    seen[c.toLowerCase()] = true;
    terms.push(c);
  }
  var wd = visionResult.webDetection;
  if (wd && wd.webEntities) {
    wd.webEntities.filter(function(e) { return e.score > 0.45 && e.description; }).slice(0, 6).forEach(function(e) { add(e.description); });
  }
  if (visionResult.labelAnnotations) {
    visionResult.labelAnnotations.filter(function(l) { return l.score > 0.75; }).slice(0, 5).forEach(function(l) { add(l.description); });
  }
  if (visionResult.textAnnotations && visionResult.textAnnotations[0]) {
    visionResult.textAnnotations[0].description.split('\n').slice(0, 4).forEach(function(l) { if (l.length >= 3 && l.length <= 60) add(l.trim()); });
  }
  if (visionResult.localizedObjectAnnotations) {
    visionResult.localizedObjectAnnotations.filter(function(o) { return o.score > 0.7; }).forEach(function(o) { add(o.name); });
  }
  return terms.slice(0, 8);
}

function parseHtml(html, titleRe, priceRe, sourceName, searchUrl) {
  var prices = [];
  var pm;
  var pCopy = new RegExp(priceRe.source, priceRe.flags);
  while ((pm = pCopy.exec(html)) && prices.length < 10) prices.push(pm[1].trim());
  var results = [];
  var tm;
  var tCopy = new RegExp(titleRe.source, titleRe.flags);
  var idx = 0;
  while ((tm = tCopy.exec(html)) && results.length < 5) {
    var title = tm[1].replace(/&amp;/g, '&').replace(/&#[0-9]+;/g, '').trim();
    if (title.length < 6) { idx++; continue; }
    results.push({ title: title, price: prices[idx] || null, source: sourceName, url: searchUrl });
    idx++;
  }
  return results;
}

function searchProduct(base64Image, mimeType, opts) {
  opts = opts || {};
  var result = { vision: {}, searchTerms: [], markets: {}, errors: [] };
  var visionPromise = (base64Image && VISION_KEY)
    ? callVisionAPI(base64Image, mimeType || 'image/jpeg').then(function(v) {
        result.vision.labels      = (v.labelAnnotations || []).slice(0, 8).map(function(l) { return l.description; });
        result.vision.webEntities = ((v.webDetection || {}).webEntities || []).filter(function(e) { return e.score > 0.4 && e.description; }).slice(0, 8).map(function(e) { return e.description; });
        result.vision.text        = v.textAnnotations && v.textAnnotations[0] ? v.textAnnotations[0].description.slice(0, 300) : '';
        result.vision.objects     = (v.localizedObjectAnnotations || []).filter(function(o) { return o.score > 0.6; }).slice(0, 4).map(function(o) { return o.name; });
        result.searchTerms        = extractSearchTerms(v);
      }).catch(function(e) { result.errors.push('Vision: ' + e.message); result.vision.error = e.message; })
    : Promise.resolve();

  return visionPromise.then(function() {
    var kw = opts.keywords || result.searchTerms.slice(0, 3).join(' ') || '';
    if (!kw) { result.errors.push('No search terms found'); return result; }
    result.queryUsed = kw;
    if (!SCRAPER_KEY) { result.errors.push('SCRAPERAPI_KEY not set -- add to Vercel env vars'); return result; }

    var tasks = [
      scrapeUrl('https://www.amazon.de/s?k=' + encodeURIComponent(kw) + '&language=en_GB', 'de')
        .then(function(html) {
          result.markets['Amazon DE'] = parseHtml(html,
            /class="a-size-medium[^"]*">([^<]{10,120})<\/span>/g,
            /class="a-price-whole">([0-9.]+)<\/span>/g,
            'Amazon DE', 'https://www.amazon.de/s?k=' + encodeURIComponent(kw));
        }).catch(function(e) { result.markets['Amazon DE'] = []; result.errors.push('AmazonDE: ' + e.message); }),
      scrapeUrl('https://www.alibaba.com/trade/search?SearchText=' + encodeURIComponent(kw) + '&IndexArea=product_en', 'us')
        .then(function(html) {
          result.markets['Alibaba'] = parseHtml(html,
            /class="[^"]*search-card-e-title[^"]*"[^>]*>[^<]*<[^>]+>([^<]{8,150})<\/[^>]+>/g,
            /[$]([0-9.]+-[0-9.]+)/g,
            'Alibaba', 'https://www.alibaba.com/trade/search?SearchText=' + encodeURIComponent(kw));
        }).catch(function(e) { result.markets['Alibaba'] = []; result.errors.push('Alibaba: ' + e.message); }),
      scrapeUrl('https://www.emag.bg/search/' + encodeURIComponent(kw), 'bg')
        .then(function(html) {
          result.markets['eMAG'] = parseHtml(html,
            /class="card-v2-title[^"]*"[^>]*>([^<]{8,120})</g,
            /class="[^"]*product-new-price[^"]*"[^>]*>([0-9 .,]+)<span/g,
            'eMAG BG', 'https://www.emag.bg/search/' + encodeURIComponent(kw));
        }).catch(function(e) { result.markets['eMAG'] = []; result.errors.push('eMAG: ' + e.message); })
    ];

    return Promise.all(tasks).then(function() { return result; });
  });
}

function formatForAI(r) {
  var lines = [];
  if (r.vision && r.vision.webEntities && r.vision.webEntities.length) lines.push('Product identified: ' + r.vision.webEntities.slice(0, 4).join(', '));
  if (r.vision && r.vision.objects && r.vision.objects.length) lines.push('Objects: ' + r.vision.objects.join(', '));
  if (r.vision && r.vision.text && r.vision.text.length > 3) lines.push('Text in image: ' + r.vision.text.slice(0, 200));
  if (r.queryUsed) lines.push('Search query: ' + r.queryUsed);
  lines.push('');
  var market;
  for (market in r.markets) {
    var items = r.markets[market];
    if (!items || !items.length) { lines.push(market + ': no results'); continue; }
    lines.push(market + ':');
    items.slice(0, 4).forEach(function(item) { lines.push('  - ' + item.title + (item.price ? ' [' + item.price + ']' : '')); });
  }
  if (r.errors && r.errors.length) lines.push('Notes: ' + r.errors.join('; '));
  return lines.join('\n');
}

module.exports = {
  searchProduct: searchProduct,
  callVisionAPI: callVisionAPI,
  extractSearchTerms: extractSearchTerms,
  formatForAI: formatForAI
};
