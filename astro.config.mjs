import { defineConfig } from 'astro/config';

// Blaksyd landing — static-first Astro build.
//
// `astro build` emits the landing + /privacy + /terms + everything in public/
// (_headers, /assets, /fonts) into dist/. The static sub-apps (app/, team-os/,
// symp-core/) live outside the Astro project and are copied into dist/ by
// scripts/copy-subapps.mjs, which runs right after the build (see package.json).
// Netlify functions (netlify/functions) stay where they are — separate from the
// publish dir. netlify.toml publishes dist/ and runs `npm run build`.
export default defineConfig({
  site: 'https://blakcide.com',
});
