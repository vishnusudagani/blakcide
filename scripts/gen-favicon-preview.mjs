// gen-favicon-preview.mjs — favicon candidates from the REAL letterforms in the
// Blaksyd wordmark vector: a "b" mark and a "bd" monogram (first + last letters).
// APPROVAL ONLY → brand-exports/favicon-previews/. Does NOT touch the site.
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'brand-exports', 'favicon-previews');
const VOID = '#08091A';

// Exact glyph paths lifted from the wordmark (native coords, x 0–1887, y 0–528).
const B_RING = 'M264 396C264 468.902 204.902 528 132 528C59.0984 528 0 468.902 0 396C0 323.098 59.0984 264 132 264C204.902 264 264 323.098 264 396ZM13.2 396C13.2 461.611 66.3886 514.8 132 514.8C197.611 514.8 250.8 461.611 250.8 396C250.8 330.389 197.611 277.2 132 277.2C66.3886 277.2 13.2 330.389 13.2 396Z';
const D_RING = 'M1887 396C1887 468.902 1827.9 528 1755 528C1682.1 528 1623 468.902 1623 396C1623 323.098 1682.1 264 1755 264C1827.9 264 1887 323.098 1887 396ZM1636.2 396C1636.2 461.611 1689.39 514.8 1755 514.8C1820.61 514.8 1873.8 461.611 1873.8 396C1873.8 330.389 1820.61 277.2 1755 277.2C1689.39 277.2 1636.2 330.389 1636.2 396Z';

const bParts = (c, ring, stem) =>
  `<path d="${B_RING}" fill="${c}" stroke="${c}" stroke-width="${ring}"/>` +
  `<line x1="6.5" x2="6.5" y2="396" stroke="${c}" stroke-width="${stem}" stroke-linecap="round"/>`;
// "d" is the same ring + a right-side ascender; translated to sit beside the "b".
const dParts = (c, ring, stem) =>
  `<g transform="translate(-1319 0)"><path d="${D_RING}" fill="${c}" stroke="${c}" stroke-width="${ring}"/>` +
  `<line x1="1880.5" x2="1880.5" y2="396" stroke="${c}" stroke-width="${stem}" stroke-linecap="round"/></g>`;

const bGlyph = (c, ring, stem) => `<g transform="translate(33.5 17) scale(0.125)">${bParts(c, ring, stem)}</g>`;
const bdGlyph = (c, ring, stem) => `<g transform="translate(16.5 18.8) scale(0.118)">${bParts(c, ring, stem)}${dParts(c, ring, stem)}</g>`;

const GRAD = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FFD27A"/><stop offset="50%" stop-color="#FF6B9D"/><stop offset="100%" stop-color="#C9B8FF"/></linearGradient></defs>`;
const chip = (fill, defs, glyph) => `<svg xmlns="http://www.w3.org/2000/svg" width="S" height="S" viewBox="0 0 100 100">${defs}<rect width="100" height="100" rx="24" fill="${fill}"/>${glyph}</svg>`;

const candidates = {
  // bd monogram (first + last letters of blaksyd)
  'bd-bold-void': chip(VOID, '', bdGlyph('#fff', 13, 30)),
  'bd-bold-gradient': chip('url(#g)', GRAD, bdGlyph(VOID, 13, 30)),
  'bd-faithful-void': chip(VOID, '', bdGlyph('#fff', 0, 13)),
  // single b for comparison
  'b-bold-void': chip(VOID, '', bGlyph('#fff', 13, 30)),
};

async function run() {
  await mkdir(OUT, { recursive: true });
  for (const [name, svg] of Object.entries(candidates)) {
    for (const s of [256, 48, 32, 16]) {
      const buf = await sharp(Buffer.from(svg.replaceAll('width="S" height="S"', `width="${s}" height="${s}"`))).png().toBuffer();
      await writeFile(resolve(OUT, `${name}-${s}.png`), buf);
    }
    console.log('  ✓', name, '→ 256 / 48 / 32 / 16');
  }
  console.log('Done →', OUT);
}
run().catch((e) => { console.error(e); process.exit(1); });
