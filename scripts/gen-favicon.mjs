// gen-favicon.mjs — FINAL favicon set from the approved mark: the real wordmark
// "b" (bold) in white on the deep "void" world. Output paths match what Base.astro
// + site.webmanifest already reference.
//   public/favicon.svg, public/favicon.ico            (browser default + scalable)
//   public/assets/favicon-16.png, favicon-32.png      (rounded chip)
//   public/assets/apple-touch-icon.png (180)          (full square, opaque)
//   public/assets/icon-192.png, icon-512.png          (PWA, full square)
// Run:  npm run gen:favicon
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ASSETS = resolve(PUBLIC, 'assets');
const VOID = '#08091A';

// The exact "b" from the wordmark (ring bowl + left ascender), bold weight, white.
const B = `<g transform="translate(33.5 17) scale(0.125)">`
  + `<path d="M264 396C264 468.902 204.902 528 132 528C59.0984 528 0 468.902 0 396C0 323.098 59.0984 264 132 264C204.902 264 264 323.098 264 396ZM13.2 396C13.2 461.611 66.3886 514.8 132 514.8C197.611 514.8 250.8 461.611 250.8 396C250.8 330.389 197.611 277.2 132 277.2C66.3886 277.2 13.2 330.389 13.2 396Z" fill="#fff" stroke="#fff" stroke-width="13"/>`
  + `<line x1="6.5" x2="6.5" y2="396" stroke="#fff" stroke-width="30" stroke-linecap="round"/></g>`;

const svg = (rx, w) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}" viewBox="0 0 100 100"><rect width="100" height="100" rx="${rx}" fill="${VOID}"/>${B}</svg>`;
const png = (rx, w) => sharp(Buffer.from(svg(rx, w))).png().toBuffer();

function ico(pngBuf, size) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  const dir = Buffer.alloc(16);
  dir.writeUInt8(size, 0); dir.writeUInt8(size, 1);
  dir.writeUInt16LE(1, 4); dir.writeUInt16LE(32, 6);
  dir.writeUInt32LE(pngBuf.length, 8); dir.writeUInt32LE(22, 12);
  return Buffer.concat([head, dir, pngBuf]);
}

const run = async () => {
  await writeFile(resolve(PUBLIC, 'favicon.svg'), svg(24, 100));         // scalable, rounded
  await writeFile(resolve(PUBLIC, 'favicon.ico'), ico(await png(24, 48), 48));
  await writeFile(resolve(ASSETS, 'favicon-16.png'), await png(24, 16)); // rounded
  await writeFile(resolve(ASSETS, 'favicon-32.png'), await png(24, 32));
  await writeFile(resolve(ASSETS, 'apple-touch-icon.png'), await png(0, 180)); // full square
  await writeFile(resolve(ASSETS, 'icon-192.png'), await png(0, 192));
  await writeFile(resolve(ASSETS, 'icon-512.png'), await png(0, 512));
  console.log('✓ favicon "b" set → public/favicon.{svg,ico} + public/assets/{favicon-16,favicon-32,apple-touch-icon,icon-192,icon-512}.png');
};
run().catch((e) => { console.error(e); process.exit(1); });
