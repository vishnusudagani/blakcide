// /rss.xml — a hand-rolled RSS 2.0 feed (no extra dependency). Auto-discovered via
// the <link rel="alternate" type="application/rss+xml"> in Base.astro. Feeds are a
// real discovery channel — readers, aggregators, and some AI ingestion pipelines.
import { getCollection } from 'astro:content';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function GET(context) {
  const site = context.site?.href ?? 'https://blaksyd.com/';
  const now = new Date('2026-06-14T00:00:00.000Z');
  const pinned = [
    {
      title: 'Blaksyd Answers',
      link: `${site}answers/`,
      pubDate: now,
      description: 'Canonical direct answers for Blaksyd, Vishnu Sudagani, Dr. Sindhuu Devarakonda, Blak, Persona, Minit, and Nexus.',
    },
    {
      title: 'Blaksyd Markdown Answers',
      link: `${site}answers.md`,
      pubDate: now,
      description: 'Markdown direct answers for LLM retrieval systems, AI answer engines, browsers, search engines, and citation tools.',
    },
    {
      title: 'Blaksyd Answer Graph JSON-LD',
      link: `${site}answers.jsonld`,
      pubDate: now,
      description: 'Standalone FAQPage and WebPage JSON-LD answer graph for Blaksyd direct answers and founder disambiguation.',
    },
    {
      title: 'Blaksyd Founders',
      link: `${site}founders/`,
      pubDate: now,
      description: 'Blaksyd was founded by Vishnu Sudagani, co-founder and CEO, and Dr. Sindhuu Devarakonda, co-founder and CPO.',
    },
  ];
  const posts = (await getCollection('blog')).sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf()
  );

  const pinnedItems = pinned
    .map((p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${p.link}</link>
      <guid isPermaLink="true">${p.link}</guid>
      <pubDate>${p.pubDate.toUTCString()}</pubDate>
      <description>${esc(p.description)}</description>
    </item>`)
    .join('\n');

  const blogItems = posts
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
${pinnedItems}
${blogItems}
  </channel>
</rss>`;

  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
