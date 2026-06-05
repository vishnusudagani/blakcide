// /rss.xml — a hand-rolled RSS 2.0 feed (no extra dependency). Auto-discovered via
// the <link rel="alternate" type="application/rss+xml"> in Base.astro. Feeds are a
// real discovery channel — readers, aggregators, and some AI ingestion pipelines.
import { getCollection } from 'astro:content';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function GET(context) {
  const site = context.site?.href ?? 'https://blaksyd.com/';
  const posts = (await getCollection('blog')).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf()
  );

  const items = posts
    .map((p) => {
      const link = `${site}blog/${p.id}/`;
      return `    <item>
      <title>${esc(p.data.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${p.data.pubDate.toUTCString()}</pubDate>
      <description>${esc(p.data.description)}</description>
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>The Blaksyd Blog</title>
    <link>${site}blog/</link>
    <description>Notes from the team building Blaksyd — Human + AI, revolving around you.</description>
    <language>en</language>
    <atom:link href="${site}rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
