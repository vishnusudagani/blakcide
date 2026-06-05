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
    }),
  ],
});
