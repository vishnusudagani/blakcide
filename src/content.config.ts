// Astro content collections — the blog. Drop a Markdown file in src/content/blog/
// and it becomes an indexable post at /blog/<filename>/ with BlogPosting schema and
// an RSS entry. The blog is the site's engine for ongoing topical authority: fresh,
// quotable, authored content is what gives search and AI answer engines reasons to
// cite Blaksyd for category queries, not just the brand name.
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: z.string().default('The Blaksyd team'),
    image: z.string().default('/assets/og-cover.png'),
    imageAlt: z.string().default('Blaksyd — Human + AI, revolving around you.'),
  }),
});

export const collections = { blog };
