// gen-images.mjs — generate real, indexable raster brand images for Google Images
// and per-page OG cards. The site is otherwise CSS/SVG art (background-images),
// which Google Images can't index — so these PNGs are the only brand imagery a
// crawler can actually rank. On-brand: the exact design tokens, the real wordmark
// composited in for fidelity, warm (AI) vs cool (Human) accents per pillar.
//
// Run:  npm run gen:images   (or: node scripts/gen-images.mjs)
// Output: public/assets/blaksyd-*.png (1200×630 OG cards + a 4-pillar diagram + logo)
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = resolve(root, 'public/assets');

// ── brand tokens (mirror src/styles/tokens.css) ──
const C = {
  void: '#08091A', midnight: '#11132E',
  cream: '#FAF4EC', ink: '#F8F4EA', inkSoft: 'rgba(248,244,234,0.74)',
  peach: '#FFD4B8', gold: '#FFD27A', coral: '#FF6B9D', lavender: '#C9B8FF',
  mint: '#B4F0DE', mintDeep: '#6AD3B8', aqua: '#5BC0FF',
};
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, Helvetica Neue, Helvetica, Arial, sans-serif';
const W = 1200, H = 630;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Shared backdrop: deep void + two soft accent glows + a hairline gradient rule
// and the four-pillar dot row with the domain — the brand signature on every card.
function backdrop(a = C.gold, b = C.coral) {
  return `
    <defs>
      <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${C.gold}"/><stop offset="48%" stop-color="${C.coral}"/><stop offset="100%" stop-color="${C.lavender}"/>
      </linearGradient>
      <radialGradient id="g1" cx="18%" cy="22%" r="60%">
        <stop offset="0%" stop-color="${a}" stop-opacity="0.30"/><stop offset="100%" stop-color="${a}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="g2" cx="86%" cy="80%" r="60%">
        <stop offset="0%" stop-color="${b}" stop-opacity="0.26"/><stop offset="100%" stop-color="${b}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="${C.void}"/>
    <rect width="${W}" height="${H}" fill="url(#g1)"/>
    <rect width="${W}" height="${H}" fill="url(#g2)"/>
    <rect x="90" y="556" width="120" height="3" rx="1.5" fill="url(#brand)"/>
    <g>
      <circle cx="${W - 250}" cy="558" r="7" fill="${C.coral}"/>
      <circle cx="${W - 226}" cy="558" r="7" fill="${C.lavender}"/>
      <circle cx="${W - 202}" cy="558" r="7" fill="${C.mint}"/>
      <circle cx="${W - 178}" cy="558" r="7" fill="${C.aqua}"/>
      <text x="${W - 158}" y="564" font-family="${FONT}" font-size="22" fill="${C.inkSoft}" letter-spacing="1">blaksyd.com</text>
    </g>`;
}

// A standard pillar / message OG card.
function card({ name, sub, accent = C.gold, accent2 = C.coral, nameFill = '#fff', sizeName = 132 }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${backdrop(accent, accent2)}
    <text x="90" y="330" font-family="${FONT}" font-weight="800" font-size="${sizeName}" fill="${nameFill}" letter-spacing="-3">${esc(name)}</text>
    <text x="92" y="392" font-family="${FONT}" font-weight="500" font-size="40" fill="${C.inkSoft}" letter-spacing="-0.5">${esc(sub)}</text>
  </svg>`;
  return Buffer.from(svg);
}

// The four-pillar diagram: YOU at the centre, two AI nodes (warm) up top, two human
// nodes (cool) at the bottom, connective lines — the canonical explainer image.
function fourPillars() {
  const cx = 600, cy = 330;
  const node = (x, y, label, desc, col) => `
    <line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${col}" stroke-opacity="0.45" stroke-width="2"/>
    <circle cx="${x}" cy="${y}" r="58" fill="${C.midnight}" stroke="${col}" stroke-width="2"/>
    <circle cx="${x}" cy="${y}" r="58" fill="${col}" fill-opacity="0.10"/>
    <text x="${x}" y="${y + 2}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="26" fill="#fff">${esc(label)}</text>
    <text x="${x}" y="${y + 90}" text-anchor="middle" font-family="${FONT}" font-size="20" fill="${C.inkSoft}">${esc(desc)}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${backdrop(C.gold, C.aqua)}
    <text x="90" y="86" font-family="${FONT}" font-weight="700" font-size="34" fill="#fff" letter-spacing="-1">The four pillars of Blaksyd</text>
    <text x="92" y="120" font-family="${FONT}" font-size="20" fill="${C.inkSoft}" letter-spacing="2">HUMAN + AI · REVOLVING AROUND YOU</text>
    ${node(330, 250, 'Blak', 'AI friend', C.coral)}
    ${node(870, 250, 'Persona', 'digital self', C.lavender)}
    ${node(330, 430, 'Minit', 'human listeners', C.mint)}
    ${node(870, 430, 'Nexus', 'your community', C.aqua)}
    <circle cx="${cx}" cy="${cy}" r="72" fill="url(#brand)"/>
    <circle cx="${cx}" cy="${cy}" r="72" fill="#08091A" fill-opacity="0.12"/>
    <text x="${cx}" y="${cy + 9}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="34" fill="#1a0e1e">YOU</text>
  </svg>`;
  return Buffer.from(svg);
}

// Logo lockup: the wordmark on a rounded void chip — a clean, theme-independent
// <img> + Organization logo (readable on any page background).
function logoChip() {
  const w = 640, h = 220;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${C.gold}"/><stop offset="50%" stop-color="${C.coral}"/><stop offset="100%" stop-color="${C.lavender}"/>
    </linearGradient></defs>
    <rect x="2" y="2" width="${w - 4}" height="${h - 4}" rx="34" fill="${C.void}" stroke="url(#b)" stroke-opacity="0.5" stroke-width="2"/>
  </svg>`;
  return Buffer.from(svg);
}

async function wordmark(height) {
  // Real wordmark (white), resized — composited onto cards for brand fidelity.
  const src = resolve(ASSETS, 'blaksyd-white.webp');
  return sharp(await readFile(src)).resize({ height }).png().toBuffer();
}

async function render(svgBuf, out, marks = []) {
  let img = sharp(svgBuf);
  if (marks.length) img = img.composite(marks);
  const png = await img.png().toBuffer();
  await writeFile(resolve(ASSETS, out), png);
  console.log('  ✓', out, `(${png.length.toLocaleString()} bytes)`);
}

const run = async () => {
  console.log('Generating brand images →', ASSETS);
  const wm = await wordmark(46);            // top-left wordmark for OG cards
  const wmBig = await wordmark(64);         // centred wordmark for the logo chip
  const topLeft = [{ input: wm, top: 64, left: 90 }];

  await render(card({ name: 'Blak', sub: 'Your proactive AI friend.', accent: C.coral, accent2: C.gold }), 'blaksyd-blak.png', topLeft);
  await render(card({ name: 'Persona', sub: 'Your digital self.', accent: C.lavender, accent2: C.coral }), 'blaksyd-persona.png', topLeft);
  await render(card({ name: 'Minit', sub: 'Real human listeners, 24/7.', accent: C.mint, accent2: C.aqua }), 'blaksyd-minit.png', topLeft);
  await render(card({ name: 'Nexus', sub: 'Your community, alive around you.', accent: C.aqua, accent2: C.mint }), 'blaksyd-nexus.png', topLeft);
  await render(card({ name: 'Manifesto', sub: 'Apps want your attention. We want your life better.', accent: C.gold, accent2: C.coral, sizeName: 104 }), 'blaksyd-manifesto.png', topLeft);
  await render(fourPillars(), 'blaksyd-four-pillars.png'); // self-titled — no wordmark overlay
  await render(logoChip(), 'blaksyd-logo.png', [{ input: wmBig, gravity: 'center' }]);

  // Refresh the homepage OG cover with the on-brand card too (keeps the set unified).
  await render(card({ name: 'Blaksyd', sub: 'Human + AI, revolving around you.', accent: C.gold, accent2: C.aqua, sizeName: 116 }), 'og-cover.png', topLeft);

  console.log('Done.');
};

run().catch((e) => { console.error(e); process.exit(1); });
