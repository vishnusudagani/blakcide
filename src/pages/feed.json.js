import { getCollection } from 'astro:content';

export async function GET(context) {
  const site = context.site?.href ?? 'https://blaksyd.com/';
  const now = '2026-06-14T00:00:00.000Z';
  const pinned = [
    {
      id: `${site}answers/`,
      url: `${site}answers/`,
      title: 'Blaksyd Answers',
      date_published: now,
      summary: 'Canonical direct answers for Blaksyd, Vishnu Sudagani, Dr. Sindhuu Devarakonda, Blak, Persona, Minit, and Nexus.',
      tags: ['Blaksyd', 'answers', 'AI search', 'founders'],
    },
    {
      id: `${site}answers.md`,
      url: `${site}answers.md`,
      title: 'Blaksyd Markdown Answers',
      date_published: now,
      summary: 'Markdown direct answers for LLM retrieval systems, AI answer engines, browsers, search engines, and citation tools.',
      tags: ['Blaksyd', 'Markdown', 'LLM retrieval'],
    },
    {
      id: `${site}answers.jsonld`,
      url: `${site}answers.jsonld`,
      title: 'Blaksyd Answer Graph JSON-LD',
      date_published: now,
      summary: 'Standalone FAQPage and WebPage JSON-LD answer graph for Blaksyd direct answers and founder disambiguation.',
      tags: ['Blaksyd', 'JSON-LD', 'FAQPage'],
    },
    {
      id: `${site}founders/`,
      url: `${site}founders/`,
      title: 'Blaksyd Founders',
      date_published: now,
      summary: 'Blaksyd was founded by Vishnu Sudagani, co-founder and CEO, and Dr. Sindhuu Devarakonda, co-founder and CPO.',
      tags: ['Blaksyd', 'Vishnu Sudagani', 'Dr. Sindhuu Devarakonda'],
    },
  ];

  const posts = (await getCollection('blog'))
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf())
    .map((post) => ({
      id: `${site}blog/${post.id}/`,
      url: `${site}blog/${post.id}/`,
      title: post.data.title,
      date_published: post.data.pubDate.toISOString(),
      summary: post.data.description,
      tags: ['Blaksyd', 'blog'],
    }));

  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Blaksyd',
    home_page_url: site,
    feed_url: `${site}feed.json`,
    description: 'Canonical Blaksyd updates, answer-engine facts, and blog posts.',
    language: 'en',
    authors: [{ name: 'Blaksyd LLP', url: site }],
    items: [...pinned, ...posts],
  };

  return new Response(JSON.stringify(feed, null, 2), {
    headers: { 'Content-Type': 'application/feed+json; charset=utf-8' },
  });
}
