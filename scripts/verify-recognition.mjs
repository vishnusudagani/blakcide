// verify-recognition.mjs — live checks for Blaksyd SEO/GEO/AiEO/AEO discovery.
//
// Usage:
//   npm run verify:recognition
//   BASE_URL=https://deploy-preview.example.netlify.app npm run verify:recognition
//
// This intentionally checks the public URL, not just local files. It catches
// missing headers, wrong content-types, stale deploys, and broken crawler hints.

const BASE_URL = (process.env.BASE_URL || 'https://blaksyd.com').replace(/\/$/, '');

const machineUrls = [
  '/llms.txt',
  '/.well-known/llms.txt',
  '/llms.json',
  '/.well-known/llms.json',
  '/llms-full.txt',
  '/.well-known/llms-full.txt',
  '/ai.txt',
  '/.well-known/ai.txt',
  '/humans.txt',
  '/.well-known/humans.txt',
  '/humans.json',
  '/.well-known/humans.json',
  '/answers.md',
  '/.well-known/answers.md',
  '/answers.jsonld',
  '/.well-known/answers.jsonld',
  '/blaksyd-answers.json',
  '/.well-known/blaksyd-answers.json',
  '/blaksyd-citations.json',
  '/.well-known/blaksyd-citations.json',
  '/blaksyd-entity-index.json',
  '/.well-known/blaksyd-entity-index.json',
  '/blaksyd-knowledge-graph.jsonld',
  '/organization.jsonld',
  '/.well-known/organization.jsonld',
  '/founders/vishnu-sudagani.json',
  '/founders/sindhuu-devarakonda.json',
  '/.well-known/webfinger',
  '/.well-known/host-meta',
  '/.well-known/host-meta.json',
  '/.well-known/ai-plugin.json',
  '/blaksyd-openapi.yaml',
  '/.well-known/openapi.yaml',
  '/machine-readable-sitemap.xml',
  '/robots.txt',
  '/opensearch.xml',
  '/opensearch-suggestions.json',
  '/rss.xml',
  '/feed.json',
  '/site.webmanifest',
  '/manifest.json',
  '/browserconfig.xml',
  '/security.txt',
  '/.well-known/security.txt',
];

const sitemapUrls = [
  '/',
  '/answers/',
  '/search/',
  '/what-is-blaksyd/',
  '/founders/',
  '/founders/vishnu-sudagani/',
  '/founders/sindhuu-devarakonda/',
  '/press/',
  '/safety/',
  '/minit/not-therapy/',
  '/trust/context-not-content/',
];

const checks = [
  { path: '/', type: 'text/html', has: ['Blaksyd', 'blaksyd-entity-index.json', 'Search Blaksyd', 'href="/search/"', 'msapplication-config', '/browserconfig.xml', '/organization.jsonld', '/humans.json', '/blaksyd-citations.json', '/blaksyd-openapi.yaml', '/.well-known/security.txt', 'Vishnu Sudagani, co-founder and CEO', 'Dr. Sindhuu Devarakonda, co-founder and CPO'], linkHeader: true },
  { path: '/answers/', type: 'text/html', has: ['Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda', 'blaksyd-answers.json'] },
  { path: '/search/?q=who%20founded%20Blaksyd', type: 'text/html', has: ['Search Blaksyd', 'Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda', 'llms.json'] },
  { path: '/llms.txt', type: 'text/plain', has: ['Human + AI life platform', 'Vishnu Sudagani', 'Sindhuu Devarakonda', 'organization.jsonld', 'humans.json', 'blaksyd-citations.json', 'blaksyd-openapi.yaml', 'opensearch.xml', 'security.txt'] },
  { path: '/.well-known/llms.txt', type: 'text/plain', has: ['Human + AI life platform', 'Founders', 'organization.jsonld', 'humans.json', 'blaksyd-citations.json', 'blaksyd-openapi.yaml'] },
  { path: '/llms.json', type: 'application/json', json: true, has: ['Blaksyd LLM manifest', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda', 'retrievalPriority', 'discoveryEndpoints', 'security.txt', 'browserconfig.xml', 'organization.jsonld', 'blaksyd-citations.json'] },
  { path: '/.well-known/llms.json', type: 'application/json', json: true, has: ['Well-known pointer', 'Vishnu Sudagani', 'Sindhuu Devarakonda', 'blaksyd-entity-index.json', 'discoveryEndpoints', 'browserconfig.xml', 'security.txt', 'organization.jsonld', 'blaksyd-citations.json'] },
  { path: '/llms-full.txt', type: 'text/plain', has: ['# Blaksyd', 'Full Reference', 'Human + AI'] },
  { path: '/.well-known/llms-full.txt', type: 'text/plain', has: ['# Blaksyd', 'Full Reference', 'Human + AI'] },
  { path: '/ai.txt', type: 'text/plain', has: ['Human + AI life platform', 'blaksyd-entity-index.json', 'organization.jsonld', 'humans.json', 'blaksyd-citations.json', 'blaksyd-openapi.yaml'] },
  { path: '/.well-known/ai.txt', type: 'text/plain', has: ['Human + AI life platform', 'Founder entity files', 'organization.jsonld', 'humans.json', 'blaksyd-citations.json', 'blaksyd-openapi.yaml'] },
  { path: '/humans.txt', type: 'text/plain', has: ['Vishnu Sudagani', 'Dr. Sindhuu Devarakonda'] },
  { path: '/.well-known/humans.txt', type: 'text/plain', has: ['Vishnu Sudagani', 'Sindhuu Devarakonda'] },
  { path: '/humans.json', type: 'application/json', json: true, has: ['Blaksyd team', 'Blaksyd LLP', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda', 'organization.jsonld'] },
  { path: '/.well-known/humans.json', type: 'application/json', json: true, has: ['Well-known structured team', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda', 'organization.jsonld'] },
  { path: '/answers.md', type: 'text/markdown', has: ['# Blaksyd Answers', 'Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda', 'https://blaksyd.com/blaksyd-answers.json'] },
  { path: '/.well-known/answers.md', type: 'text/markdown', has: ['# Blaksyd Answers', 'Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda', 'https://blaksyd.com/answers.md'] },
  { path: '/answers.jsonld', type: 'application/ld+json', json: true, has: ['FAQPage', 'Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda'] },
  { path: '/.well-known/answers.jsonld', type: 'application/ld+json', json: true, has: ['FAQPage', 'Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda'] },
  { path: '/blaksyd-answers.json', type: 'application/json', json: true, has: ['Who founded Blaksyd?', 'Vishnu Sudagani', 'organization.jsonld', 'humans.json'] },
  { path: '/.well-known/blaksyd-answers.json', type: 'application/json', json: true, has: ['Who founded Blaksyd?', 'Vishnu Sudagani', 'organization.jsonld', 'humans.json'] },
  { path: '/blaksyd-citations.json', type: 'application/json', json: true, has: ['Blaksyd citation map', 'claim-to-source citation map', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda, also known as Sindhuu Devarakonda, is the co-founder and CPO of Blaksyd.', 'Do not describe Minit as therapy.'] },
  { path: '/.well-known/blaksyd-citations.json', type: 'application/json', json: true, has: ['Well-known claim-to-source citation map', 'Blaksyd was founded by Vishnu Sudagani', 'Minit is not therapy', 'blaksyd-citations.json'] },
  { path: '/blaksyd-entity-index.json', type: 'application/json', json: true, has: ['vishnu-sudagani', 'sindhuu-devarakonda', 'Vishnu Sudagani Blaksyd', 'organizationJsonLdUrl', 'humans.json'] },
  { path: '/.well-known/blaksyd-entity-index.json', type: 'application/json', json: true, has: ['vishnu-sudagani', 'sindhuu-devarakonda', 'organization.jsonld', 'humans.json'] },
  { path: '/blaksyd-knowledge-graph.jsonld', type: 'application/ld+json', json: true, has: ['Blaksyd', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda'] },
  { path: '/organization.jsonld', type: 'application/ld+json', json: true, has: ['Blaksyd LLP', 'Human + AI life platform', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda', 'https://blaksyd.com/#organization'] },
  { path: '/.well-known/organization.jsonld', type: 'application/ld+json', json: true, has: ['Blaksyd LLP', 'Blaksyd founder Vishnu Sudagani', 'Blaksyd founder Dr. Sindhuu Devarakonda', 'blaksyd-entity-index.json'] },
  { path: '/founders/vishnu-sudagani.json', type: 'application/json', json: true, has: ['Vishnu Sudagani', 'Co-founder and CEO', 'Blaksyd founder Vishnu Sudagani'] },
  { path: '/founders/sindhuu-devarakonda.json', type: 'application/json', json: true, has: ['Dr. Sindhuu Devarakonda', 'Co-founder and CPO', 'Sindhuu Devarakonda'] },
  { path: '/.well-known/webfinger?resource=acct:blaksyd@blaksyd.com', type: 'application/jrd+json', json: true, has: ['blaksyd-entity-index.json', 'organization.jsonld', 'founders/vishnu-sudagani', 'founders/sindhuu-devarakonda'] },
  { path: '/.well-known/host-meta', type: 'application/xrd+xml', has: ['lrdd', 'blaksyd-entity-index.json', 'organization.jsonld', 'founders/vishnu-sudagani'] },
  { path: '/.well-known/host-meta.json', type: 'application/jrd+json', json: true, has: ['blaksyd-entity-index.json', 'organization.jsonld', 'founders/sindhuu-devarakonda'] },
  { path: '/.well-known/ai-plugin.json', type: 'application/json', json: true, has: ['name_for_model', 'blaksyd-openapi.yaml'] },
  { path: '/blaksyd-openapi.yaml', type: 'application/yaml', has: ['getBlaksydEntityIndex', 'getBlaksydCitationMap', 'getBlaksydWellKnownCitationMap', 'getBlaksydMarkdownAnswers', 'getBlaksydWellKnownMarkdownAnswers', 'getBlaksydWebFinger', 'getBlaksydWellKnownFullLlmsBrief', 'getBlaksydOrganizationGraph', 'getBlaksydHumansJson'] },
  { path: '/.well-known/openapi.yaml', type: 'application/yaml', has: ['getBlaksydCanonicalAnswers', 'getBlaksydCitationMap', 'getBlaksydWellKnownCitationMap', 'getBlaksydMarkdownAnswers', 'getBlaksydWellKnownMarkdownAnswers', 'getBlaksydWellKnownOrganizationGraph', 'getBlaksydWellKnownHumansJson', 'Blaksyd Public Facts'] },
  { path: '/opensearch.xml', type: 'application/opensearchdescription+xml', has: ['opensearch-suggestions.json', 'https://blaksyd.com/search/?q={searchTerms}', 'Blaksyd'] },
  { path: '/opensearch-suggestions.json', type: 'application/x-suggestions+json', json: true, has: ['Search Blaksyd', 'https://blaksyd.com/search/', 'Blaksyd Answers', 'https://blaksyd.com/answers/', 'Vishnu Sudagani Blaksyd', 'Sindhuu Devarakonda Blaksyd'] },
  { path: '/sitemap.xml', type: 'application/xml', has: ['https://blaksyd.com/sitemap-0.xml'] },
  { path: '/sitemap-index.xml', type: 'application/xml', has: ['https://blaksyd.com/sitemap-0.xml'] },
  { path: '/sitemap-0.xml', type: 'application/xml', has: ['https://blaksyd.com/', 'https://blaksyd.com/search/', 'https://blaksyd.com/founders/vishnu-sudagani/', 'https://blaksyd.com/founders/sindhuu-devarakonda/'] },
  { path: '/rss.xml', type: 'application/xml', has: ['Blaksyd Answers', 'https://blaksyd.com/answers/', 'Blaksyd Answer Graph JSON-LD', 'Vishnu Sudagani'] },
  { path: '/feed.json', type: 'application/feed+json', json: true, has: ['Blaksyd Answers', 'https://blaksyd.com/answers.jsonld', 'Dr. Sindhuu Devarakonda'] },
  { path: '/site.webmanifest', type: 'application/manifest+json', json: true, has: ['Blaksyd Answers', 'What is Blaksyd?', 'Dr. Sindhuu Devarakonda'] },
  { path: '/manifest.json', type: 'application/manifest+json', json: true, has: ['Search Blaksyd', 'Blaksyd Founders', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda'] },
  { path: '/browserconfig.xml', type: 'application/xml', has: ['<browserconfig>', '<msapplication>', '/assets/icon-192.png', '/assets/og-cover.png'] },
  { path: '/security.txt', type: 'text/plain', has: ['Contact: mailto:ceo@blaksyd.com', 'Canonical: https://blaksyd.com/.well-known/security.txt', 'Policy: https://blaksyd.com/safety/'] },
  { path: '/.well-known/security.txt', type: 'text/plain', has: ['Contact: mailto:ceo@blaksyd.com', 'Expires: 2027-06-14T00:00:00Z', 'Canonical: https://blaksyd.com/.well-known/security.txt'] },
];

const structuredPages = [
  {
    path: '/',
    types: ['Organization', 'WebSite', 'Person'],
    ids: [
      'https://blaksyd.com/#organization',
      'https://blaksyd.com/founders/vishnu-sudagani/#person',
      'https://blaksyd.com/founders/sindhuu-devarakonda/#person',
    ],
  },
  {
    path: '/search/',
    types: ['SearchResultsPage', 'SearchAction', 'ItemList'],
    ids: ['https://blaksyd.com/search/#webpage', 'https://blaksyd.com/search/#results'],
  },
  {
    path: '/answers/',
    types: ['FAQPage', 'WebPage', 'Organization', 'Person'],
    ids: [
      'https://blaksyd.com/answers/#faq',
      'https://blaksyd.com/answers/#webpage',
      'https://blaksyd.com/founders/vishnu-sudagani/#person',
      'https://blaksyd.com/founders/sindhuu-devarakonda/#person',
    ],
    faqQuestions: ['Who founded Blaksyd?', 'Who is Vishnu Sudagani?', 'Who is Dr. Sindhuu Devarakonda?'],
  },
  {
    path: '/founders/vishnu-sudagani/',
    types: ['Person', 'ProfilePage', 'FAQPage'],
    ids: ['https://blaksyd.com/founders/vishnu-sudagani/#person'],
    faqQuestions: ['Who is Vishnu Sudagani?', "What is Vishnu Sudagani's role at Blaksyd?"],
  },
  {
    path: '/founders/sindhuu-devarakonda/',
    types: ['Person', 'ProfilePage', 'FAQPage'],
    ids: ['https://blaksyd.com/founders/sindhuu-devarakonda/#person'],
    faqQuestions: ['Who is Dr. Sindhuu Devarakonda?', 'Who is Sindhuu Devarakonda?'],
  },
  {
    path: '/what-is-blaksyd/',
    types: ['AboutPage', 'FAQPage'],
    ids: ['https://blaksyd.com/what-is-blaksyd/#webpage', 'https://blaksyd.com/what-is-blaksyd/#faq'],
    faqQuestions: ['What is Blaksyd?', 'Is Blaksyd just an AI chatbot?', 'Is Blaksyd a therapy app?'],
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

function normalizeText(value) {
  return String(value).replace(/[\u2018\u2019]/g, "'");
}

function collectGraphNodes(value, nodes = []) {
  if (!value || typeof value !== 'object') return nodes;
  if (Array.isArray(value)) {
    for (const item of value) collectGraphNodes(item, nodes);
    return nodes;
  }

  nodes.push(value);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') collectGraphNodes(nested, nodes);
  }
  return nodes;
}

function parseJsonLd(url, html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  assert(scripts.length > 0, `${url} missing application/ld+json script`);

  const parsed = scripts.map((match) => {
    try {
      return JSON.parse(match[1]);
    } catch (error) {
      throw new Error(`${url} has invalid JSON-LD: ${error.message}`);
    }
  });

  return parsed.flatMap((entry) => collectGraphNodes(entry, []));
}

async function fetchText(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url);
  const text = await res.text();
  return { url, res, text };
}

async function runCheck(check) {
  const { url, res, text } = await fetchText(check.path);
  assert(res.status === 200, `${url} returned ${res.status}`);

  const contentType = res.headers.get('content-type') || '';
  assert(contentType.includes(check.type), `${url} content-type ${contentType} does not include ${check.type}`);

  if (check.linkHeader) {
    const link = res.headers.get('link') || '';
    for (const needle of ['llms.txt', 'llms-full.txt', 'llms.json', 'answers.md', 'answers.jsonld', 'blaksyd-answers.json', 'blaksyd-citations.json', 'blaksyd-entity-index.json', 'blaksyd-knowledge-graph.jsonld', 'organization.jsonld', 'humans.json', 'blaksyd-openapi.yaml', '.well-known/security.txt']) {
      assert(link.includes(needle), `${url} Link header missing ${needle}`);
    }
  }

  for (const needle of check.has || []) {
    assert(text.includes(needle), `${url} missing expected text: ${needle}`);
  }

  if (check.json) {
    JSON.parse(text);
  }

  console.log(`ok ${check.path}`);
}

async function runStructuredDataCheck(page) {
  const { url, res, text } = await fetchText(page.path);
  assert(res.status === 200, `${url} returned ${res.status}`);

  assert(text.includes(`rel="canonical" href="${BASE_URL}${page.path}"`), `${url} missing canonical URL`);

  const nodes = parseJsonLd(url, text);
  const types = new Set(nodes.flatMap((node) => asArray(node['@type'] || [])));
  const ids = new Set(nodes.map((node) => node['@id']).filter(Boolean));
  const questions = new Set(nodes.filter((node) => node['@type'] === 'Question').map((node) => normalizeText(node.name)));

  for (const type of page.types) {
    assert(types.has(type), `${url} missing JSON-LD @type ${type}`);
  }

  for (const id of page.ids || []) {
    assert(ids.has(id), `${url} missing JSON-LD @id ${id}`);
  }

  for (const question of page.faqQuestions || []) {
    assert(questions.has(normalizeText(question)), `${url} missing FAQ question ${question}`);
  }

  console.log(`ok structured-data ${page.path}`);
}

async function runSearchSitemapChecks() {
  const { text: sitemapIndex } = await fetchText('/sitemap-index.xml');
  const { text: defaultSitemap } = await fetchText('/sitemap.xml');
  assert(defaultSitemap.includes(`${BASE_URL}/sitemap-0.xml`), 'default /sitemap.xml did not expose sitemap-0.xml');

  const sitemapMatches = [...sitemapIndex.matchAll(/<loc>(https:\/\/[^<]+)<\/loc>/g)].map((match) => match[1]);
  assert(sitemapMatches.length > 0, 'sitemap-index.xml did not list any child sitemaps');

  const sitemapBodies = await Promise.all(sitemapMatches.map(async (url) => {
    const res = await fetch(url);
    const text = await res.text();
    assert(res.status === 200, `${url} returned ${res.status}`);
    return text;
  }));

  const combined = sitemapBodies.join('\n');
  for (const path of sitemapUrls) {
    assert(combined.includes(`${BASE_URL}${path}`), `search sitemap missing ${path}`);
  }
  assert(combined.includes('<loc>https://blaksyd.com/answers/</loc>'), 'search sitemap missing /answers/ loc');
  assert(combined.includes('<loc>https://blaksyd.com/search/</loc>'), 'search sitemap missing /search/ loc');
  assert(combined.includes('<priority>0.9</priority>'), 'search sitemap did not preserve /answers/ elevated priority');
  assert(combined.includes('<image:caption>Canonical Blaksyd answers for AI search, browsers, and answer engines.</image:caption>'), 'search sitemap missing /answers/ image caption');
  assert(combined.includes('<image:caption>Search Blaksyd official answers for browsers and answer engines.</image:caption>'), 'search sitemap missing /search/ image caption');

  const searchBlock = combined.match(/<url><loc>https:\/\/blaksyd\.com\/search\/<\/loc>[\s\S]*?<\/url>/)?.[0] || '';
  assert(searchBlock.includes('<changefreq>daily</changefreq>'), 'search sitemap did not preserve /search/ daily changefreq');
  assert(searchBlock.includes('<priority>0.9</priority>'), 'search sitemap did not preserve /search/ elevated priority');

  console.log('ok search-sitemap');
}

async function runCrossLinkChecks() {
  const [{ text: robots }, { text: sitemap }, { text: openapi }] = await Promise.all([
    fetchText('/robots.txt'),
    fetchText('/machine-readable-sitemap.xml'),
    fetchText('/blaksyd-openapi.yaml'),
  ]);

  for (const path of machineUrls) {
    assert(robots.includes(path) || path === '/site.webmanifest' || path === '/manifest.json', `robots.txt missing ${path}`);
    assert(sitemap.includes(`${BASE_URL}${path}`), `machine-readable-sitemap.xml missing ${path}`);
  }

  for (const op of [
    'getBlaksydCanonicalAnswers',
    'getBlaksydLlmsJsonManifest',
    'getBlaksydWellKnownLlmsJsonManifest',
    'getBlaksydMarkdownAnswers',
    'getBlaksydWellKnownMarkdownAnswers',
    'getBlaksydAnswerGraph',
    'getBlaksydWellKnownAnswerGraph',
    'getBlaksydCitationMap',
    'getBlaksydWellKnownCitationMap',
    'getBlaksydEntityIndex',
    'getBlaksydWebFinger',
    'getBlaksydHostMeta',
    'getBlaksydWellKnownFullLlmsBrief',
    'getBlaksydAiSummary',
    'getBlaksydWellKnownAiSummary',
    'getBlaksydOrganizationGraph',
    'getBlaksydWellKnownOrganizationGraph',
    'getBlaksydHumans',
    'getBlaksydWellKnownHumans',
    'getBlaksydHumansJson',
    'getBlaksydWellKnownHumansJson',
    'getVishnuSudaganiFacts',
    'getSindhuuDevarakondaFacts',
  ]) {
    assert(openapi.includes(op), `OpenAPI missing ${op}`);
  }

  console.log('ok cross-links');
}

try {
  console.log(`Verifying Blaksyd recognition surface at ${BASE_URL}`);
  for (const check of checks) await runCheck(check);
  for (const page of structuredPages) await runStructuredDataCheck(page);
  await runSearchSitemapChecks();
  await runCrossLinkChecks();
  console.log(`Done. ${checks.length} endpoint checks, ${structuredPages.length} structured-data checks, search sitemap, and cross-links passed.`);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
