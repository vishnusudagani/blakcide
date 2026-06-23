// Generates Capacitor app-icon + splash source images from the brand "b" mark.
// Full-bleed (no rounded corners — the OS applies its own mask) on the brand void.
// Run: node scripts/gen-mobile-assets.mjs   then:  npx @capacitor/assets generate
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

mkdirSync('assets', { recursive: true });

const VOID = '#08091A'; // brand void (matches favicon bg)
// The white "b" mark, in a 0..100 viewBox (lifted from public/favicon.svg, sans rounded rect).
const B =
  '<g transform="translate(33.5 17) scale(0.125)">' +
  '<path d="M264 396C264 468.902 204.902 528 132 528C59.0984 528 0 468.902 0 396C0 323.098 59.0984 264 132 264C204.902 264 264 323.098 264 396ZM13.2 396C13.2 461.611 66.3886 514.8 132 514.8C197.611 514.8 250.8 461.611 250.8 396C250.8 330.389 197.611 277.2 132 277.2C66.3886 277.2 13.2 330.389 13.2 396Z" fill="#fff" stroke="#fff" stroke-width="13"/>' +
  '<line x1="6.5" x2="6.5" y2="396" stroke="#fff" stroke-width="30" stroke-linecap="round"/>' +
  '</g>';
// scale the mark about the centre (for splash + adaptive-icon safe zone)
const scaled = (s) => `<g transform="translate(50 50) scale(${s}) translate(-50 -50)">${B}</g>`;
const doc = (inner, bg, size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">` +
  (bg ? `<rect width="100" height="100" fill="${bg}"/>` : '') + inner + '</svg>';
const render = (inner, bg, size, file) =>
  sharp(Buffer.from(doc(inner, bg, size))).resize(size, size).png().toFile('assets/' + file);

await render(B, VOID, 1024, 'icon-only.png');             // full-bleed icon (iOS + legacy Android)
await render(scaled(0.78), null, 1024, 'icon-foreground.png'); // adaptive-icon foreground (padded), transparent
await render('', VOID, 1024, 'icon-background.png');       // adaptive-icon background (solid void)
await render(scaled(0.46), VOID, 2732, 'splash.png');     // splash (light/default)
await render(scaled(0.46), VOID, 2732, 'splash-dark.png');// splash (dark)
console.log('OK: icon-only / icon-foreground / icon-background / splash / splash-dark in assets/');
