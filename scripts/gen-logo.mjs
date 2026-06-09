// gen-logo.mjs — export clean, upload-ready logo files from the official Blaksyd
// wordmark VECTOR (brand-exports/blaksyd-logo.svg). Produces a white SVG variant +
// razor-sharp transparent PNGs (rendered from vector, no upscaling) + square avatars.
// For Wikimedia Commons / Wikidata P154 (Knowledge Panel) and profile pictures
// (Crunchbase, LinkedIn, Product Hunt, social).
//
// Run:  npm run gen:logo   →   ../brand-exports/*.{svg,png}
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'brand-exports');
const VOID = { r: 8, g: 9, b: 26, alpha: 1 };       // #08091A
const CREAM = { r: 250, g: 244, b: 236, alpha: 1 };  // #FAF4EC
const ASPECT = 792 / 1887;

// Set the root SVG render size (viewBox stays, so content scales crisply).
const sized = (svg, w) => svg.replace(/width="1887"\s+height="792"/, `width="${w}" height="${Math.round(w * ASPECT)}"`);
const render = (svg, w) => sharp(Buffer.from(sized(svg, w))).png().toBuffer();

async function run() {
  await mkdir(OUT, { recursive: true });
  const black = await readFile(resolve(OUT, 'blaksyd-logo.svg'), 'utf8');
  // White variant — swap only the visible black fills/strokes; the mask's
  // fill="white" is structural and already white, so it's untouched.
  const white = black.replace(/="black"/g, '="white"');
  await writeFile(resolve(OUT, 'blaksyd-logo-white.svg'), white);
  console.log('  ✓ blaksyd-logo.svg + blaksyd-logo-white.svg (true vectors)');

  // Crisp transparent PNGs from the vector @ 2400px wide, with ~14% margin so the
  // wordmark isn't edge-to-edge (the vector's ascenders/descenders touch the viewBox).
  for (const [svg, name] of [[black, 'blaksyd-logo-black-transparent.png'], [white, 'blaksyd-logo-white-transparent.png']]) {
    const base = await render(svg, 2400);
    const pad = Math.round(2400 * ASPECT * 0.14);
    const buf = await sharp(base)
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();
    await writeFile(resolve(OUT, name), buf);
    const m = await sharp(buf).metadata();
    console.log(`  ✓ ${name} (${m.width}×${m.height}, crisp + padded)`);
  }

  // Square profile avatars — wordmark ~72% width, centered on brand background.
  for (const [svg, bg, name] of [[white, VOID, 'blaksyd-avatar-dark-1024.png'], [black, CREAM, 'blaksyd-avatar-light-1024.png']]) {
    const wm = await render(svg, 740);
    const out = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: bg } })
      .composite([{ input: wm, gravity: 'center' }]).png().toBuffer();
    await writeFile(resolve(OUT, name), out);
    console.log(`  ✓ ${name} (1024×1024 square)`);
  }
  console.log('Done →', OUT);
}
run().catch((e) => { console.error(e); process.exit(1); });
