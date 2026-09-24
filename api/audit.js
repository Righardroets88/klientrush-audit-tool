// /api/audit.js (Vercel serverless function)
// KlientRush free SEO audit: single-page checks with industry weighting.
// v2 (2026-09): every check below is measured, nothing is assumed.
//   - Title read from <head><title> only (inline SVG <title> tags were being counted).
//   - Word count and readability use visible content only (no scripts, styles, SVG, nav or footer).
//   - robots.txt, XML sitemap, compression, caching, mixed content and status are really checked.
//   - Schema detection understands @graph, arrays and Organization subtypes.
//   - Performance comes from PageSpeed Insights when GOOGLE_PAGESPEED_API_KEY is set.
//     Without it, performance is reported as null and left out of the overall score
//     (it used to be a fixed 70, and load time was a random number).

const fetch = require('node-fetch');
const cheerio = require('cheerio');

const GOOGLE_PAGESPEED_API_KEY = process.env.GOOGLE_PAGESPEED_API_KEY || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 KlientRushAudit/2.0';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const { url, industry = 'general' } = body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let normalizedUrl;
  try {
    normalizedUrl = normalizeUrl(url);
  } catch (e) {
    return res.status(400).json({ error: 'That doesn\'t look like a valid website address.' });
  }

  try {
    const [page, coreWebVitals] = await Promise.all([
      fetchPage(normalizedUrl),
      getCoreWebVitals(normalizedUrl)
    ]);

    if (page.error) return res.status(400).json({ error: page.error });

    const extras = await fetchSiteFiles(page.finalUrl);
    const analysis = analyzePageSEO(page, extras);
    const scores = calculateWeightedScores(analysis, coreWebVitals, industry);
    const issues = rankCriticalIssues(analysis, coreWebVitals);

    return res.status(200).json({
      score: scores.overall,
      scoreBreakdown: {
        technical: scores.technical,
        onPage: scores.onPage,
        content: scores.content,
        schema: scores.schema,
        performance: scores.performance
      },
      wordCount: analysis.wordCount,
      images: analysis.imageCount,
      headings: analysis.headingCount,
      loadTime: page.loadTime,
      finalUrl: page.finalUrl,
      readability: analysis.readability.valid ? analysis.readability.fleschScore : null,
      issues: issues.slice(0, 7),
      coreWebVitals,
      industry,
      version: 2
    });
  } catch (error) {
    console.error('Audit error:', error);
    return res.status(500).json({ error: 'Failed to analyze website: ' + error.message });
  }
};

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return {}; } }

function normalizeUrl(input) {
  let url = String(input).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const u = new URL(url); // throws on garbage
  u.hostname = u.hostname.toLowerCase(); // paths stay case-sensitive
  return u.toString();
}

async function timedFetch(url, opts = {}) {
  return fetch(url, { redirect: 'follow', timeout: 12000, headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*' }, ...opts });
}

async function fetchPage(url) {
  const started = Date.now();
  let response;
  try {
    response = await timedFetch(url);
  } catch (e) {
    return { error: `We couldn't reach ${url}. Check the address and try again.` };
  }
  const html = await response.text();
  const loadTime = Date.now() - started;

  if (!response.ok) {
    const blocked = response.status === 403 || response.status === 429 || response.status === 503;
    return {
      error: blocked
        ? `This site blocked our checker (HTTP ${response.status}). A firewall or bot protection may be in place. Email hello@klientrush.com and we'll run the audit manually.`
        : `The page returned HTTP ${response.status}, so it can't be audited.`
    };
  }
  if (!html || html.length < 50) return { error: 'The page came back empty, so it can\'t be audited.' };

  return {
    url,
    finalUrl: response.url || url,
    redirected: (response.url || url) !== url,
    status: response.status,
    headers: response.headers,
    html,
    loadTime
  };
}

async function fetchSiteFiles(finalUrl) {
  const origin = new URL(finalUrl).origin;
  const out = { robotsTxt: false, sitemap: false, sitemapUrl: null };
  try {
    const r = await timedFetch(origin + '/robots.txt', { timeout: 6000 });
    if (r.ok) {
      const txt = await r.text();
      out.robotsTxt = /user-agent\s*:/i.test(txt);
      const m = txt.match(/^\s*sitemap\s*:\s*(\S+)/im);
      if (m) out.sitemapUrl = m[1];
    }
  } catch (e) { /* unreachable robots.txt counts as missing */ }

  const candidates = [out.sitemapUrl, origin + '/sitemap.xml', origin + '/sitemap_index.xml', origin + '/sitemap-index.xml'].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = await timedFetch(c, { timeout: 6000 });
      if (r.ok) {
        const txt = (await r.text()).slice(0, 5000);
        if (/<(urlset|sitemapindex)\b/i.test(txt)) { out.sitemap = true; out.sitemapUrl = c; break; }
      }
    } catch (e) { /* try the next one */ }
  }
  return out;
}

function schemaTypes(node, acc) {
  if (!node) return acc;
  if (Array.isArray(node)) { node.forEach(n => schemaTypes(n, acc)); return acc; }
  if (typeof node !== 'object') return acc;
  const t = node['@type'];
  if (t) (Array.isArray(t) ? t : [t]).forEach(x => acc.add(String(x)));
  Object.keys(node).forEach(k => { if (k !== '@type' && node[k] && typeof node[k] === 'object') schemaTypes(node[k], acc); });
  return acc;
}

const ORG_TYPES = /^(Organization|Corporation|LocalBusiness|ProfessionalService|LegalService|Attorney|MedicalBusiness|MedicalClinic|Physician|Dentist|Store|OnlineStore|OnlineBusiness|HomeAndConstructionBusiness|FinancialService|AccountingService|RealEstateAgent|AutomotiveBusiness|FoodEstablishment|Restaurant|HealthAndBeautyBusiness|NGO|EducationalOrganization)$/;
const RICH_TYPES = /^(Article|BlogPosting|NewsArticle|Product|Offer|Service|FAQPage|HowTo|BreadcrumbList|Review|AggregateRating|Event|Recipe|Course|JobPosting|VideoObject|SoftwareApplication)$/;

function visibleText($, root) {
  const $c = cheerio.load($.html(root));
  $c('script, style, noscript, svg, template, iframe, [hidden], [aria-hidden="true"]').remove();
  return $c;
}

function analyzePageSEO(page, extras) {
  const $ = cheerio.load(page.html);
  const checks = {};
  const issues = [];
  const add = (checkpoint, severity, message, category) => issues.push({ checkpoint, severity, message, category });
  const final = new URL(page.finalUrl);
  const isHttps = final.protocol === 'https:';

  // ===== TECHNICAL =====
  checks.https = isHttps;
  if (!isHttps) add(1, 'critical', 'Site not using HTTPS - security risk', 'Technical');

  checks.robotsTxt = extras.robotsTxt;
  if (!checks.robotsTxt) add(2, 'medium', 'No robots.txt file found', 'Technical');

  checks.sitemap = extras.sitemap;
  if (!checks.sitemap) add(3, 'high', 'No XML sitemap found (checked robots.txt and common locations)', 'Technical');

  const viewport = $('meta[name="viewport"]').attr('content') || '';
  checks.mobileResponsive = !!viewport;
  checks.viewportCorrect = viewport.includes('width=device-width');
  if (!checks.mobileResponsive) add(4, 'critical', 'Missing viewport meta tag - not mobile responsive', 'Technical');

  const canonical = $('link[rel="canonical"]').attr('href');
  checks.canonical = !!canonical;
  if (!checks.canonical) add(6, 'medium', 'No canonical tag - search engines may index duplicate versions', 'Technical');

  let mixed = 0;
  if (isHttps) {
    $('img[src], script[src], iframe[src], link[rel="stylesheet"][href], source[src], video[src], audio[src]').each((i, el) => {
      const v = $(el).attr('src') || $(el).attr('href') || '';
      if (/^http:\/\//i.test(v)) mixed++;
    });
  }
  checks.noMixedContent = mixed === 0;
  if (!checks.noMixedContent) add(7, 'high', `${mixed} insecure (http://) resources loaded on an HTTPS page`, 'Technical');

  checks.urlLength = page.finalUrl.length <= 115;

  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  const xRobots = (page.headers.get('x-robots-tag') || '').toLowerCase();
  checks.noNoindex = !robotsMeta.includes('noindex') && !xRobots.includes('noindex');
  if (!checks.noNoindex) add(11, 'critical', 'Page marked noindex - it won\'t appear in search', 'Technical');

  const headScripts = $('head script[src]').filter((i, el) => {
    const s = $(el);
    return s.attr('async') === undefined && s.attr('defer') === undefined && s.attr('type') !== 'module';
  }).length;
  checks.renderBlockingJs = headScripts === 0;
  if (!checks.renderBlockingJs) add(12, 'medium', `${headScripts} render-blocking script${headScripts > 1 ? 's' : ''} in the <head>`, 'Technical');

  checks.renderBlockingCss = $('head link[rel="stylesheet"]').length <= 4;

  // Tracking pixels (1x1 or display:none) aren't content images, so they're ignored.
  const imgs = $('img').filter((i, el) => {
    const e = $(el);
    const w = parseInt(e.attr('width'), 10), h = parseInt(e.attr('height'), 10);
    if ((w && w <= 1) || (h && h <= 1)) return false;
    if (/display\s*:\s*none/i.test(e.attr('style') || '')) return false;
    return e.parents('noscript').length === 0;
  });
  checks.lazyLoading = imgs.length <= 2 || $('img[loading="lazy"]').length > 0;

  const enc = (page.headers.get('content-encoding') || '').toLowerCase();
  checks.gzip = /gzip|br|deflate|zstd/.test(enc);
  if (!checks.gzip) add(15, 'medium', 'HTML is not compressed (gzip or Brotli)', 'Technical');

  checks.caching = !!(page.headers.get('cache-control') || page.headers.get('etag') || page.headers.get('last-modified'));
  checks.http200 = page.status === 200;

  // ===== ON-PAGE =====
  const title = ($('head > title').first().text() || $('title').first().text() || '').trim();
  const description = ($('meta[name="description"]').attr('content') || '').trim();

  checks.titlePresent = !!title;
  checks.titleLength = title.length >= 30 && title.length <= 60;
  checks.descriptionPresent = !!description;
  checks.descriptionLength = description.length >= 120 && description.length <= 160;

  if (!checks.titlePresent) add(18, 'critical', 'Missing meta title', 'On-Page');
  else if (!checks.titleLength) add(19, 'high', `Meta title is ${title.length} characters (aim for 30-60)`, 'On-Page');
  if (!checks.descriptionPresent) add(20, 'critical', 'Missing meta description', 'On-Page');
  else if (!checks.descriptionLength) add(21, 'medium', `Meta description is ${description.length} characters (aim for 120-160)`, 'On-Page');

  const h1Count = $('h1').length;
  const h2Count = $('h2').length;
  const h3Count = $('h3').length;
  checks.singleH1 = h1Count === 1;
  checks.multipleH2 = h2Count >= 2;
  if (h1Count === 0) add(22, 'critical', 'Missing H1 tag - no main heading', 'On-Page');
  if (h1Count > 1) add(22, 'high', `Multiple H1 tags (${h1Count}) - use only one`, 'On-Page');
  if (!checks.multipleH2) add(23, 'medium', 'Add at least 2-3 H2 subheadings for structure', 'On-Page');

  const levels = $('h1, h2, h3, h4, h5, h6').map((i, el) => Number(el.tagName.slice(1))).get();
  let skipped = false;
  for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i - 1] > 1) { skipped = true; break; }
  checks.headingHierarchy = levels.length > 0 && levels[0] <= 2 && !skipped;

  const imageCount = imgs.length;
  let missingAlt = 0, descriptiveAlt = 0, withText = 0;
  imgs.each((i, img) => {
    const alt = $(img).attr('alt');
    if (alt === undefined) { missingAlt++; return; }
    const a = alt.trim();
    if (a.length > 0) {
      withText++;
      const generic = a.length < 3 || /^(image|img|photo|picture|pic|banner|icon|graphic|untitled)[\s_-]*\d*$/i.test(a) || /\.(jpe?g|png|webp|gif|svg|avif)$/i.test(a);
      if (!generic) descriptiveAlt++;
    }
  });
  checks.imageAltText = missingAlt === 0;
  checks.altTextQuality = withText === 0 ? imageCount === 0 : descriptiveAlt / withText >= 0.7;
  if (missingAlt > 0) add(24, 'high', `${missingAlt} image${missingAlt > 1 ? 's' : ''} missing alt text (accessibility + SEO)`, 'On-Page');

  // Visible content only
  const $v = visibleText($, $('body').length ? $('body') : $.root());
  const allText = $v('body').text() || $v.root().text() || '';
  const wordCount = allText.split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w)).length;
  checks.minimumWords = wordCount >= 300;
  if (!checks.minimumWords) add(27, 'high', `Only ${wordCount} words of visible text - aim for 300+`, 'On-Page');

  const host = final.hostname.replace(/^www\./, '');
  let internal = 0, external = 0;
  $('a[href]').each((i, a) => {
    const href = $(a).attr('href');
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    try {
      const u = new URL(href, page.finalUrl);
      const h = u.hostname.replace(/^www\./, '');
      if (h === host || h.endsWith('.' + host) || host.endsWith('.' + h)) internal++; else external++;
    } catch (e) { /* ignore bad hrefs */ }
  });
  checks.internalLinks = internal >= 3;
  checks.externalLinks = external > 0;
  if (internal < 3) add(31, 'medium', `Only ${internal} internal link${internal === 1 ? '' : 's'} - link to related pages`, 'On-Page');

  // ===== CONTENT =====
  // Readability is measured on the main content area, one block at a time,
  // so headings and nav items don't merge into one giant "sentence".
  const $main = $v('main').length ? $v('main').first() : $v('body');
  $main.find('nav, header, footer, form, aside').remove();
  const blocks = [];
  $main.find('p, li, td, blockquote, dd, figcaption').each((i, el) => {
    if ($v(el).find('p, li').length) return; // only leaf blocks
    const t = $v(el).text().replace(/\s+/g, ' ').trim();
    if (t.split(' ').length >= 4) blocks.push(t); // skip labels and one-word list items
  });
  const readability = calculateReadability(blocks);
  if (readability.valid && readability.fleschScore < 30) {
    add(34, 'medium', `Content readability is low (${readability.fleschScore}/100) - shorten sentences and use simpler words`, 'Content');
  }
  checks.paragraphStructure = readability.valid ? readability.avgParagraphWords <= 80 : false;

  const pubDate = $('meta[property="article:published_time"]').attr('content') || $('meta[property="article:modified_time"]').attr('content') || $('time[datetime]').attr('datetime');
  checks.freshness = !!pubDate;

  // ===== STRUCTURED DATA =====
  const types = new Set();
  let schemaCount = 0, schemaValid = true;
  $('script[type="application/ld+json"]').each((i, s) => {
    schemaCount++;
    try { schemaTypes(JSON.parse($(s).contents().text()), types); } catch (e) { schemaValid = false; }
  });
  checks.schemaPresent = schemaCount > 0;
  checks.schemaValid = schemaCount > 0 && schemaValid;
  checks.orgSchema = [...types].some(t => ORG_TYPES.test(t));
  checks.richSchema = [...types].some(t => RICH_TYPES.test(t));
  if (!checks.schemaPresent) add(36, 'high', 'No structured data (Schema.org) - add it for rich results', 'Schema');
  else {
    if (!schemaValid) add(37, 'high', 'Structured data has JSON errors', 'Schema');
    if (!checks.orgSchema) add(38, 'medium', 'No Organization or LocalBusiness schema', 'Schema');
  }

  return {
    checks,
    issues,
    wordCount,
    imageCount,
    headingCount: h1Count + h2Count + h3Count,
    readability,
    schemaTypes: [...types]
  };
}

function syllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = word.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

function calculateReadability(blocks) {
  let sentences = 0, words = 0, syl = 0;
  blocks.forEach(b => {
    const parts = b.split(/(?<=[.!?])\s+/).filter(p => /[A-Za-z]/.test(p));
    parts.forEach(p => {
      const w = p.split(/\s+/).filter(x => /[A-Za-z]/.test(x));
      if (!w.length) return;
      sentences++;
      words += w.length;
      w.forEach(x => { syl += syllables(x); });
    });
  });

  if (words < 100 || sentences === 0) {
    return { valid: false, fleschScore: null, avgParagraphWords: 0 };
  }
  const flesch = 206.835 - 1.015 * (words / sentences) - 84.6 * (syl / words);
  return {
    valid: true,
    fleschScore: Math.round(Math.max(0, Math.min(100, flesch))),
    avgParagraphWords: Math.round(words / Math.max(blocks.length, 1))
  };
}

function pct(items) {
  const got = items.reduce((a, [ok, pts]) => a + (ok ? pts : 0), 0);
  const max = items.reduce((a, [, pts]) => a + pts, 0);
  return Math.round((got / max) * 100);
}

function calculateWeightedScores(analysis, cwv, industry) {
  const c = analysis.checks;
  const technical = pct([
    [c.https, 3], [c.robotsTxt, 2], [c.sitemap, 2], [c.mobileResponsive, 3], [c.viewportCorrect, 1],
    [c.canonical, 2], [c.noMixedContent, 2], [c.urlLength, 1], [c.noNoindex, 3], [c.renderBlockingJs, 1],
    [c.renderBlockingCss, 1], [c.lazyLoading, 1], [c.gzip, 2], [c.caching, 1], [c.http200, 2]
  ]);
  const onPage = pct([
    [c.titlePresent, 3], [c.titleLength, 2], [c.descriptionPresent, 3], [c.descriptionLength, 2],
    [c.singleH1, 3], [c.multipleH2, 2], [c.headingHierarchy, 1], [c.imageAltText, 3], [c.altTextQuality, 1],
    [c.minimumWords, 3], [c.internalLinks, 2], [c.externalLinks, 1]
  ]);

  // Content: depth, readability (graded, since B2B copy rarely scores 60+), structure, freshness.
  const r = analysis.readability;
  const wc = analysis.wordCount;
  const depthPts = wc >= 800 ? 4 : wc >= 300 ? 3 : wc >= 150 ? 1 : 0;
  const readPts = !r.valid ? 0 : r.fleschScore >= 60 ? 4 : r.fleschScore >= 45 ? 3 : r.fleschScore >= 30 ? 2 : 1;
  const content = Math.round(((depthPts + readPts + (c.paragraphStructure ? 2 : 0) + (c.freshness ? 1 : 0)) / 11) * 100);

  const schema = pct([[c.schemaPresent, 3], [c.schemaValid, 2], [c.orgSchema, 2], [c.richSchema, 2]]);
  const performance = calculatePerformanceScore(cwv);

  const w = { ...getIndustryWeights(industry) };
  if (performance === null) w.performance = 0; // no data, so it doesn't count either way
  const totalW = w.technical + w.onPage + w.content + w.schema + w.performance;
  const overall = Math.round(
    (technical * w.technical + onPage * w.onPage + content * w.content + schema * w.schema + (performance || 0) * w.performance) / totalW
  );

  return { overall: Math.max(0, Math.min(100, overall)), technical, onPage, content, schema, performance };
}

async function getCoreWebVitals(url) {
  if (!GOOGLE_PAGESPEED_API_KEY) return null;
  try {
    const endpoint = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
    const r = await fetch(`${endpoint}?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${GOOGLE_PAGESPEED_API_KEY}`, { timeout: 45000 });
    const data = await r.json();
    const lr = data.lighthouseResult;
    if (!lr || !lr.audits) return null;
    const num = k => (lr.audits[k] && typeof lr.audits[k].numericValue === 'number') ? lr.audits[k].numericValue : null;
    const lcp = num('largest-contentful-paint');
    return {
      performanceScore: lr.categories && lr.categories.performance ? Math.round(lr.categories.performance.score * 100) : null,
      lcp: lcp !== null ? Math.round(lcp / 100) / 10 : null, // seconds
      cls: num('cumulative-layout-shift'),
      tbt: num('total-blocking-time'),
      fieldData: !!(data.loadingExperience && data.loadingExperience.metrics)
    };
  } catch (e) {
    console.error('PageSpeed API error:', e.message);
    return null;
  }
}

function calculatePerformanceScore(cwv) {
  if (!cwv || cwv.performanceScore === null || cwv.performanceScore === undefined) return null;
  return cwv.performanceScore; // Lighthouse mobile performance score
}

function getIndustryWeights(industry) {
  const weights = {
    general: { technical: 0.25, onPage: 0.35, content: 0.25, schema: 0.10, performance: 0.05 },
    ecommerce: { technical: 0.20, onPage: 0.35, content: 0.20, schema: 0.15, performance: 0.10 },
    saas: { technical: 0.30, onPage: 0.30, content: 0.20, schema: 0.05, performance: 0.15 },
    local: { technical: 0.20, onPage: 0.35, content: 0.15, schema: 0.20, performance: 0.10 },
    law: { technical: 0.20, onPage: 0.30, content: 0.35, schema: 0.10, performance: 0.05 },
    medical: { technical: 0.20, onPage: 0.30, content: 0.40, schema: 0.05, performance: 0.05 }
  };
  return weights[industry] || weights.general;
}

function rankCriticalIssues(analysis, cwv) {
  const ranked = [...analysis.issues];
  if (cwv) {
    if (cwv.lcp && cwv.lcp > 2.5) {
      ranked.push({ checkpoint: 40, severity: cwv.lcp > 4 ? 'critical' : 'high', message: `Largest Contentful Paint is ${cwv.lcp.toFixed(1)}s on mobile (target under 2.5s)`, category: 'Performance' });
    }
    if (cwv.cls && cwv.cls > 0.1) {
      ranked.push({ checkpoint: 42, severity: 'high', message: `Layout shift (CLS ${cwv.cls.toFixed(2)}) - improve visual stability`, category: 'Performance' });
    }
    if (cwv.tbt && cwv.tbt > 300) {
      ranked.push({ checkpoint: 43, severity: 'medium', message: `Total Blocking Time is ${Math.round(cwv.tbt)}ms - reduce heavy JavaScript`, category: 'Performance' });
    }
  }
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  ranked.sort((a, b) => order[a.severity] - order[b.severity]);
  const seen = new Set();
  return ranked.filter(i => (seen.has(i.checkpoint + i.message) ? false : seen.add(i.checkpoint + i.message)));
}

// Exposed for local testing
module.exports._test = { analyzePageSEO, fetchPage, fetchSiteFiles, calculateReadability, calculateWeightedScores, normalizeUrl };
