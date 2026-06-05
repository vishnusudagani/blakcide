// indexnow.mjs — ping IndexNow so Bing & Yandex re-crawl Blaksyd within minutes
// instead of days. Bing's index also feeds ChatGPT Search and Microsoft Copilot,
// so fast Bing indexing is a direct generative-engine (GEO) lever, not just SEO.
//
// Prereq: the key file public/453cf1928da71298a881bc66a89e6f8c.txt must be live at
// https://blaksyd.com/453cf1928da71298a881bc66a89e6f8c.txt (it ships from public/).
// Run AFTER a deploy:  npm run indexnow
import { setTimeout as wait } from 'node:timers/promises';

const HOST = 'blaksyd.com';
const KEY = '453cf1928da71298a881bc66a89e6f8c';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;

// The pages we want answer engines and search to (re)crawl. Keep in sync with the
// sitemap's indexable routes.
const PATHS = [
  '/', '/blak/', '/persona/', '/minit/', '/nexus/',
  '/about/', '/manifesto/', '/blog/', '/privacy/', '/terms/',
];
const urlList = PATHS.map((p) => `https://${HOST}${p}`);

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
