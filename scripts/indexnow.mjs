// indexnow.mjs — ping IndexNow so Bing & Yandex re-crawl Blaksyd within minutes
// instead of days. Bing's index also feeds ChatGPT Search and Microsoft Copilot,
// so fast Bing indexing is a direct generative-engine (GEO) lever, not just SEO.
//
// Prereq: the key file public/453cf1928da71298a881bc66a89e6f8c.txt must be live at
// https://blaksyd.com/453cf1928da71298a881bc66a89e6f8c.txt (it ships from public/).
// Run AFTER a deploy:  npm run indexnow
import { setTimeout as wait } from 'node:timers/promises';
import { readdir } from 'node:fs/promises';

const HOST = 'blaksyd.com';
const KEY = '453cf1928da71298a881bc66a89e6f8c';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;

// The pages we want answer engines and search to (re)crawl: static section routes
// plus every blog post, derived from the content collection so the list never goes
// stale as new posts ship (the previous hardcoded list pinged sections only).
const PATHS = [
  '/', '/blak/', '/persona/', '/minit/', '/nexus/',
  '/about/', '/manifesto/', '/blog/', '/privacy/', '/terms/',
  '/answers/', '/search/', '/what-is-blaksyd/', '/press/', '/safety/',
  '/minit/not-therapy/', '/trust/context-not-content/',
  '/founders/', '/founders/vishnu-sudagani/', '/founders/sindhuu-devarakonda/',
  '/founders/vishnu-sudagani.json', '/founders/sindhuu-devarakonda.json',
  '/llms.txt', '/llms.json', '/.well-known/llms.json', '/llms-full.txt', '/.well-known/llms-full.txt', '/answers.md', '/.well-known/answers.md', '/answers.jsonld', '/.well-known/answers.jsonld', '/blaksyd-answers.json', '/blaksyd-citations.json', '/.well-known/blaksyd-citations.json', '/blaksyd-entity-index.json', '/blaksyd-knowledge-graph.jsonld', '/organization.jsonld', '/.well-known/organization.jsonld',
  '/.well-known/llms.txt', '/.well-known/blaksyd-answers.json', '/.well-known/blaksyd-entity-index.json', '/ai.txt', '/.well-known/ai.txt',
  '/.well-known/webfinger', '/.well-known/host-meta', '/.well-known/host-meta.json',
  '/humans.txt', '/.well-known/humans.txt', '/humans.json', '/.well-known/humans.json',
  '/.well-known/ai-plugin.json', '/blaksyd-openapi.yaml', '/.well-known/openapi.yaml',
  '/sitemap.xml', '/sitemap-index.xml', '/sitemap-0.xml', '/machine-readable-sitemap.xml', '/robots.txt', '/opensearch.xml', '/opensearch-suggestions.json', '/rss.xml', '/feed.json', '/site.webmanifest', '/manifest.json', '/browserconfig.xml', '/security.txt', '/.well-known/security.txt',
];
const blogDir = new URL('../src/content/blog/', import.meta.url);
const blogPaths = (await readdir(blogDir))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `/blog/${f.replace(/\.md$/, '')}/`);
const urlList = [...PATHS, ...blogPaths].map((p) => `https://${HOST}${p}`);

async function submit(endpoint) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList }),
  });
  console.log(`  ${endpoint} → ${res.status} ${res.statusText}`);
  return res.status;
}

const run = async () => {
  console.log(`IndexNow: submitting ${urlList.length} URLs for ${HOST}`);
  // api.indexnow.org fans out to all participating engines, but pinging Bing and
  // Yandex directly too is belt-and-suspenders and costs nothing.
  for (const ep of [
    'https://api.indexnow.org/IndexNow',
    'https://www.bing.com/IndexNow',
    'https://yandex.com/indexnow',
  ]) {
    try { await submit(ep); } catch (e) { console.error(`  ${ep} → ERROR`, e.message); }
    await wait(400);
  }
  console.log('Done. (200/202 = accepted; 422 = key not yet reachable — deploy first.)');
};

run();
