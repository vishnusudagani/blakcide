// verify-recognition-dist.mjs — local predeploy checks for the Blaksyd
// SEO/GEO/AiEO/AEO discovery surface.
//
// Usage:
//   npm run build
//   npm run verify:recognition:dist
//
// This intentionally reads dist/ directly. It complements verify-recognition.mjs,
// which checks a live URL after deployment.

import { readFile } from 'node:fs/promises';

const DIST = new URL('../dist/', import.meta.url);
const BASE_URL = 'https://blaksyd.com';

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

const endpointChecks = [
  { path: '/', html: true, has: ['Blaksyd', 'Search Blaksyd', 'msapplication-config', '/browserconfig.xml', '/organization.jsonld', '/humans.json', '/blaksyd-citations.json', '/blaksyd-openapi.yaml', '/.well-known/security.txt', 'Vishnu Sudagani, co-founder and CEO', 'Dr. Sindhuu Devarakonda, co-founder and CPO'] },
  { path: '/answers/', html: true, has: ['Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda', 'blaksyd-answers.json'] },
  { path: '/search/?q=who%20founded%20Blaksyd', html: true, has: ['Search Blaksyd', 'Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda', 'llms.json'] },
  { path: '/llms.txt', has: ['Human + AI life platform', 'Vishnu Sudagani', 'organization.jsonld', 'humans.json', 'blaksyd-citations.json', 'blaksyd-openapi.yaml', 'opensearch.xml', 'security.txt'] },
  { path: '/.well-known/llms.txt', has: ['Human + AI life platform', 'Founders', 'organization.jsonld', 'humans.json', 'blaksyd-citations.json', 'blaksyd-openapi.yaml'] },
  { path: '/llms.json', json: true, has: ['Blaksyd LLM manifest', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda', 'discoveryEndpoints', 'security.txt', 'browserconfig.xml', 'organization.jsonld', 'humans.json', 'blaksyd-citations.json'] },
  { path: '/.well-known/llms.json', json: true, has: ['Well-known pointer', 'Vishnu Sudagani', 'Sindhuu Devarakonda', 'discoveryEndpoints', 'browserconfig.xml', 'security.txt', 'organization.jsonld', 'humans.json', 'blaksyd-citations.json'] },
  { path: '/llms-full.txt', has: ['# Blaksyd', 'Full Reference', 'Human + AI'] },
  { path: '/.well-known/llms-full.txt', has: ['# Blaksyd', 'Full Reference', 'Human + AI'] },
  { path: '/ai.txt', has: ['Human + AI life platform', 'blaksyd-entity-index.json', 'organization.jsonld', 'humans.json', 'blaksyd-citations.json', 'blaksyd-openapi.yaml'] },
  { path: '/.well-known/ai.txt', has: ['Human + AI life platform', 'Founder entity files', 'organization.jsonld', 'humans.json', 'blaksyd-citations.json', 'blaksyd-openapi.yaml'] },
  { path: '/humans.txt', has: ['Vishnu Sudagani', 'Dr. Sindhuu Devarakonda'] },
  { path: '/.well-known/humans.txt', has: ['Vishnu Sudagani', 'Sindhuu Devarakonda'] },
  { path: '/humans.json', json: true, has: ['Blaksyd team', 'Blaksyd LLP', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda', 'organization.jsonld'] },
  { path: '/.well-known/humans.json', json: true, has: ['Well-known structured team', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda', 'organization.jsonld'] },
  { path: '/answers.md', has: ['# Blaksyd Answers', 'Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda'] },
  { path: '/.well-known/answers.md', has: ['# Blaksyd Answers', 'Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda'] },
  { path: '/answers.jsonld', json: true, has: ['FAQPage', 'Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda'] },
  { path: '/.well-known/answers.jsonld', json: true, has: ['FAQPage', 'Who founded Blaksyd?', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda'] },
  { path: '/blaksyd-answers.json', json: true, has: ['Who founded Blaksyd?', 'Vishnu Sudagani', 'organization.jsonld', 'humans.json'] },
  { path: '/.well-known/blaksyd-answers.json', json: true, has: ['Who founded Blaksyd?', 'Vishnu Sudagani', 'organization.jsonld', 'humans.json'] },
  { path: '/blaksyd-citations.json', json: true, has: ['Blaksyd citation map', 'claim-to-source citation map', 'Vishnu Sudagani is the co-founder and CEO of Blaksyd.', 'Dr. Sindhuu Devarakonda, also known as Sindhuu Devarakonda, is the co-founder and CPO of Blaksyd.', 'Do not describe Minit as therapy.'] },
  { path: '/.well-known/blaksyd-citations.json', json: true, has: ['Well-known claim-to-source citation map', 'Blaksyd was founded by Vishnu Sudagani', 'Minit is not therapy', 'blaksyd-citations.json'] },
  { path: '/blaksyd-entity-index.json', json: true, has: ['vishnu-sudagani', 'sindhuu-devarakonda', 'Vishnu Sudagani Blaksyd', 'organizationJsonLdUrl', 'humans.json'] },
  { path: '/.well-known/blaksyd-entity-index.json', json: true, has: ['vishnu-sudagani', 'sindhuu-devarakonda', 'organization.jsonld', 'humans.json'] },
  { path: '/blaksyd-knowledge-graph.jsonld', json: true, has: ['Blaksyd', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda'] },
  { path: '/organization.jsonld', json: true, has: ['Blaksyd LLP', 'Human + AI life platform', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda', 'https://blaksyd.com/#organization'] },
  { path: '/.well-known/organization.jsonld', json: true, has: ['Blaksyd LLP', 'Blaksyd founder Vishnu Sudagani', 'Blaksyd founder Dr. Sindhuu Devarakonda', 'blaksyd-entity-index.json'] },
  { path: '/founders/vishnu-sudagani.json', json: true, has: ['Vishnu Sudagani', 'Co-founder and CEO', 'Blaksyd founder Vishnu Sudagani'] },
  { path: '/founders/sindhuu-devarakonda.json', json: true, has: ['Dr. Sindhuu Devarakonda', 'Co-founder and CPO', 'Sindhuu Devarakonda'] },
  { path: '/.well-known/webfinger', json: true, has: ['blaksyd-entity-index.json', 'organization.jsonld', 'founders/vishnu-sudagani', 'founders/sindhuu-devarakonda'] },
  { path: '/.well-known/host-meta', has: ['lrdd', 'blaksyd-entity-index.json', 'organization.jsonld', 'founders/vishnu-sudagani'] },
  { path: '/.well-known/host-meta.json', json: true, has: ['blaksyd-entity-index.json', 'organization.jsonld', 'founders/sindhuu-devarakonda'] },
  { path: '/.well-known/ai-plugin.json', json: true, has: ['name_for_model', 'blaksyd-openapi.yaml'] },
  { path: '/blaksyd-openapi.yaml', has: ['getBlaksydEntityIndex', 'getBlaksydCitationMap', 'getBlaksydWellKnownCitationMap', 'getBlaksydWebFinger', 'getBlaksydOrganizationGraph', 'getBlaksydHumansJson'] },
  { path: '/.well-known/openapi.yaml', has: ['getBlaksydCanonicalAnswers', 'getBlaksydCitationMap', 'getBlaksydWellKnownCitationMap', 'getBlaksydWellKnownOrganizationGraph', 'getBlaksydWellKnownHumansJson'] },
  { path: '/opensearch.xml', has: ['opensearch-suggestions.json', 'https://blaksyd.com/search/?q={searchTerms}', 'Blaksyd'] },
  { path: '/opensearch-suggestions.json', json: true, has: ['Search Blaksyd', 'https://blaksyd.com/search/', 'Vishnu Sudagani Blaksyd', 'Sindhuu Devarakonda Blaksyd'] },
  { path: '/rss.xml', has: ['Blaksyd Answers', 'https://blaksyd.com/answers/', 'Blaksyd Answer Graph JSON-LD', 'Vishnu Sudagani'] },
  { path: '/feed.json', json: true, has: ['Blaksyd Answers', 'https://blaksyd.com/answers.jsonld', 'Dr. Sindhuu Devarakonda'] },
  { path: '/site.webmanifest', json: true, has: ['Blaksyd Answers', 'What is Blaksyd?', 'Dr. Sindhuu Devarakonda'] },
  { path: '/manifest.json', json: true, has: ['Search Blaksyd', 'Blaksyd Founders', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda'] },
  { path: '/browserconfig.xml', has: ['<browserconfig>', '<msapplication>', '/assets/icon-192.png', '/assets/og-cover.png'] },
  { path: '/security.txt', has: ['Contact: mailto:ceo@blaksyd.com', 'Canonical: https://blaksyd.com/.well-known/security.txt', 'Policy: https://blaksyd.com/safety/'] },
  { path: '/.well-known/security.txt', has: ['Contact: mailto:ceo@blaksyd.com', 'Expires: 2027-06-14T00:00:00Z', 'Canonical: https://blaksyd.com/.well-known/security.txt'] },
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

function fileForPath(path) {
  const cleanPath = path.split('?')[0].split('#')[0];
  if (cleanPath === '/') return new URL('index.html', DIST);
  if (cleanPath.endsWith('/')) return new URL(`${cleanPath.slice(1)}index.html`, DIST);
  return new URL(cleanPath.slice(1), DIST);
}

async function readDist(path) {
  try {
    return await readFile(fileForPath(path), 'utf8');
  } catch (error) {
    throw new Error(`${path} missing from dist (${error.message})`);
  }
}

function parseJsonLd(path, html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  assert(scripts.length > 0, `${path} missing application/ld+json script`);

  return scripts.flatMap((match) => {
    try {
      return collectGraphNodes(JSON.parse(match[1]), []);
    } catch (error) {
      throw new Error(`${path} has invalid JSON-LD: ${error.message}`);
    }
  });
}

async function runEndpointCheck(check) {
  const text = await readDist(check.path);

  for (const needle of check.has || []) {
    assert(text.includes(needle), `${check.path} missing expected text: ${needle}`);
  }

  if (check.json) JSON.parse(text);
  console.log(`ok dist ${check.path}`);
}

async function runStructuredDataCheck(page) {
  const text = await readDist(page.path);
  assert(text.includes(`rel="canonical" href="${BASE_URL}${page.path}"`), `${page.path} missing canonical URL`);

  const nodes = parseJsonLd(page.path, text);
  const types = new Set(nodes.flatMap((node) => asArray(node['@type'] || [])));
  const ids = new Set(nodes.map((node) => node['@id']).filter(Boolean));
  const questions = new Set(nodes.filter((node) => node['@type'] === 'Question').map((node) => normalizeText(node.name)));

  for (const type of page.types) assert(types.has(type), `${page.path} missing JSON-LD @type ${type}`);
  for (const id of page.ids || []) assert(ids.has(id), `${page.path} missing JSON-LD @id ${id}`);
  for (const question of page.faqQuestions || []) {
    assert(questions.has(normalizeText(question)), `${page.path} missing FAQ question ${question}`);
  }

  console.log(`ok dist structured-data ${page.path}`);
}

async function runCrossLinkChecks() {
  const [robots, sitemap, openapi, headers, sitemapIndex, childSitemap] = await Promise.all([
    readDist('/robots.txt'),
    readDist('/machine-readable-sitemap.xml'),
    readDist('/blaksyd-openapi.yaml'),
    readDist('/_headers'),
    readDist('/sitemap-index.xml'),
    readDist('/sitemap-0.xml'),
  ]);

  for (const path of machineUrls) {
    assert(robots.includes(path) || path === '/site.webmanifest' || path === '/manifest.json', `robots.txt missing ${path}`);
    assert(sitemap.includes(`${BASE_URL}${path}`), `machine-readable-sitemap.xml missing ${path}`);
  }

  for (const path of ['/', '/answers/', '/search/', '/what-is-blaksyd/', '/founders/', '/founders/vishnu-sudagani/', '/founders/sindhuu-devarakonda/']) {
    assert(childSitemap.includes(`${BASE_URL}${path}`), `sitemap-0.xml missing ${path}`);
  }

  assert(sitemapIndex.includes(`${BASE_URL}/sitemap-0.xml`), 'sitemap-index.xml missing sitemap-0.xml');
  assert(childSitemap.includes('<image:caption>Canonical Blaksyd answers for AI search, browsers, and answer engines.</image:caption>'), 'sitemap-0.xml missing /answers/ image caption');
  assert(childSitemap.includes('<image:caption>Search Blaksyd official answers for browsers and answer engines.</image:caption>'), 'sitemap-0.xml missing /search/ image caption');

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

  for (const headerPath of [
    '/llms.json',
    '/blaksyd-citations.json',
    '/.well-known/blaksyd-citations.json',
    '/humans.json',
    '/.well-known/humans.json',
    '/organization.jsonld',
    '/.well-known/organization.jsonld',
    '/blaksyd-openapi.yaml',
    '/.well-known/webfinger',
    '/.well-known/host-meta',
    '/humans.txt',
    '/manifest.json',
    '/browserconfig.xml',
    '/security.txt',
    '/.well-known/security.txt',
  ]) {
    assert(headers.includes(headerPath), `_headers missing ${headerPath}`);
  }

  console.log('ok dist cross-links');
}

try {
  console.log('Verifying Blaksyd recognition surface in dist/');
  for (const check of endpointChecks) await runEndpointCheck(check);
  for (const page of structuredPages) await runStructuredDataCheck(page);
  await runCrossLinkChecks();
  console.log(`Done. ${endpointChecks.length} dist endpoint checks, ${structuredPages.length} structured-data checks, and cross-links passed.`);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
