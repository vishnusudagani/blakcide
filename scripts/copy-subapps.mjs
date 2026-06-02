// Assembles the deployable dist/ for Netlify.
//
// `astro build` emits the landing (index.html, /privacy, /terms) plus everything
// in public/ (_headers, /assets, /fonts). The three sub-apps — app, team-os,
// symp-core — are static and self-contained but live OUTSIDE the Astro project,
// so Astro never sees them. This step copies them verbatim into dist/ after the
// build, so a single publish dir (dist/) serves the whole site:
//   /               -> Astro landing
//   /privacy /terms -> Astro pages
//   /app/*          -> app/        (static)
//   /team-os/*      -> team-os/    (static PWA; SPA fallback handled in netlify.toml)
//   /symp-core/*    -> symp-core/  (static)
// Netlify functions (netlify/functions) are separate from the publish dir and
// are untouched by this step.
import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const subapps = ['app', 'team-os', 'symp-core'];

if (!existsSync(dist)) mkdirSync(dist, { recursive: true });

let copied = 0;
for (const name of subapps) {
  const src = join(root, name);
  if (!existsSync(src)) {
    console.warn(`[copy-subapps] skip: ${name}/ not found`);
    continue;
  }
  cpSync(src, join(dist, name), {
    recursive: true,
    // never let macOS cruft reach the deploy
    filter: (s) => !s.endsWith('/.DS_Store') && !s.endsWith('\\.DS_Store'),
  });
  copied += 1;
  console.log(`[copy-subapps] ${name}/ -> dist/${name}/`);
}
console.log(`[copy-subapps] done (${copied}/${subapps.length} sub-apps copied).`);
