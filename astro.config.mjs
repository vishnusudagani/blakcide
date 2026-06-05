import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Blaksyd landing — static-first Astro build.
//
// `astro build` emits the landing + /privacy + /terms + everything in public/
// (_headers, /assets, /fonts) into dist/. The static sub-apps (app/, team-os/,
// symp-core/) live outside the Astro project and are copied into dist/ by
// scripts/copy-subapps.mjs, which runs right after the build (see package.json).
// Netlify functions (netlify/functions) stay where they are — separate from the
// publish dir. netlify.toml publishes dist/ and runs `npm run build`.
export default defineConfig({
  // blaksyd.com is the canonical/primary domain. blakcide.com is the old domain
  // and 301-redirects here (see the domain-level redirect at the top of
  // netlify.toml). This value feeds canonical + OG/Twitter URLs via Astro.site in
  // Base.astro, so it must be the destination domain — never the one redirecting away.
  site: 'https://blaksyd.com',

  // @astrojs/sitemap emits sitemap-index.xml + sitemap-0.xml into dist/ at build,
  // covering the Astro routes only (/, /privacy/, /terms/) — exactly the public
  // marketing pages we want indexed. The copied sub-apps (app/, team-os/,
  // symp-core/) are added after the build and are intentionally NOT listed.
  // robots.txt points crawlers at /sitemap-index.xml.
  integrations: [
    sitemap({
      // Match Astro's directory output (trailing slash) so sitemap URLs equal the
      // 200-OK canonical URLs and never point at a 301 redirect.
      changefreq: 'weekly',
      lastmod: new Date(),
      // serialize runs per URL: (1) set priorities so the homepage + pillars
      // outrank the legal pages, and (2) attach <image:image> entries so Google
      // Images can discover each page's brand card (the site is otherwise CSS art
      // with no crawlable raster imagery). Image namespace is added automatically.
      serialize(item) {
        const path = item.url.replace('https://blaksyd.com', '');

        // /inspect is a noindex dev-only scaffold ("delete before deploy") — keep it
        // out of the sitemap too, so we never advertise a page we tell Google to skip.
        if (path.startsWith('/inspect')) return undefined;

        const IMG = {
          '/': { file: 'og-cover.png', caption: 'Blaksyd — Human + AI, revolving around you.' },
          '/blak/': { file: 'blaksyd-blak.png', caption: 'Blak — Blaksyd’s proactive AI friend.' },
          '/persona/': { file: 'blaksyd-persona.png', caption: 'Persona — your digital self on Blaksyd.' },
          '/minit/': { file: 'blaksyd-minit.png', caption: 'Minit — real human listeners, 24/7.' },
          '/nexus/': { file: 'blaksyd-nexus.png', caption: 'Nexus — your community on Blaksyd.' },
          '/about/': { file: 'blaksyd-four-pillars.png', caption: 'The four pillars of Blaksyd.' },
          '/manifesto/': { file: 'blaksyd-manifesto.png', caption: 'Most apps want your attention. Blaksyd wants your life to be better.' },
        };
        const hit = IMG[path];
        if (hit) {
          item.img = [{ url: `https://blaksyd.com/assets/${hit.file}`, title: 'Blaksyd', caption: hit.caption }];
        }

        if (path === '/') item.priority = 1.0;
        else if (['/blak/', '/persona/', '/minit/', '/nexus/', '/about/'].includes(path)) item.priority = 0.9;
        else if (path === '/manifesto/' || path.startsWith('/blog')) item.priority = 0.7;
        else item.priority = 0.5; // privacy / terms

        return item;
      },
    }),
  ],
});
