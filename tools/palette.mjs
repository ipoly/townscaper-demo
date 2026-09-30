// Generates the wall and roof palettes for town.js in OKLCH. Each color choice is a wall + roof pair,
// and the pairs are searched together so that even the two most alike pairs stay easy to tell apart.
// Not used at runtime: run it, then paste the printed arrays.
//   cd tools && npm i --no-save colorjs.io@0.7 && node palette.mjs [--table]
import Color from 'colorjs.io';

// Wall slots [name, tier, hue range, roofs that suit it]: a designed spread of hue families, mostly pastel with a few
// bolder accents. The search only fine-tunes the hue inside each range
const TIERS = { pale: [0.92, 0.07], mid: [0.855, 0.095], bold: [0.78, 0.135] };
const SLOTS = [
  ['white', 'pale', null, ['navy', 'slate', 'teal', 'terracotta', 'charcoal']],
  ['butter', 'pale', [88, 105], ['terracotta', 'brick', 'slate', 'teal']],
  ['marigold', 'bold', [72, 88], ['brick', 'umber', 'navy', 'charcoal']],
  ['apricot', 'mid', [48, 65], ['brick', 'umber', 'petrol', 'slate']],
  ['coral', 'bold', [22, 38], ['charcoal', 'navy', 'plum', 'umber']],
  ['rose', 'pale', [0, 20], ['plum', 'aubergine', 'slate', 'charcoal']],
  ['sage', 'mid', [122, 145], ['moss', 'terracotta', 'umber', 'ochre']],
  ['mint', 'mid', [165, 190], ['teal', 'petrol', 'navy', 'terracotta']],
  ['sky', 'pale', [218, 245], ['slate', 'navy', 'petrol', 'brick']],
];
// Yellows only read as yellow when light
const wallL = (tier, h) => TIERS[tier][0] + (h >= 68 && h <= 115 ? { pale: 0.01, mid: 0.03, bold: 0.07 }[tier] : 0);
const NEUTRAL = -1; // the near-white wall

// Roof candidates [name, L, C, h]: earthy and muted, each used at most once (reuse is penalised)
const ROOFS = [
  ['terracotta', 0.6, 0.15, 38],
  ['brick', 0.52, 0.15, 27],
  ['plum', 0.48, 0.1, 350],
  ['aubergine', 0.44, 0.09, 310],
  ['navy', 0.44, 0.1, 262],
  ['slate', 0.56, 0.09, 250],
  ['petrol', 0.5, 0.08, 215],
  ['teal', 0.55, 0.095, 180],
  ['moss', 0.55, 0.11, 138],
  ['olive', 0.56, 0.1, 115],
  ['ochre', 0.62, 0.13, 72],
  ['umber', 0.48, 0.09, 50],
  ['charcoal', 0.42, 0.015, 250],
];
const MIN_CONTRAST = 0.25; // roof at least this much darker than its wall (OKLCH lightness)
const MIN_WALL_DE = 7; // every two walls differ by at least this much on their own (deltaE OK x100)
// A town reads as sunny with mostly warm roofs, so at least this many come from the warm group
const WARM = ['terracotta', 'brick', 'plum', 'ochre', 'umber'], MIN_WARM = 4;

// Into sRGB keeping lightness and hue exactly: only the chroma is lowered until the color fits
function toGamut(l, c, h) {
  const at = (x) => new Color('oklch', [l, x, h]).to('srgb');
  if (at(c).inGamut()) return at(c);
  let lo = 0, hi = c;
  for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (at(mid).inGamut()) lo = mid; else hi = mid; }
  return at(lo);
}
const wallColor = (tier, h) => (h === NEUTRAL ? toGamut(0.965, 0.01, 85) : toGamut(wallL(tier, h), TIERS[tier][1], h));
const roofColor = (r, lw) => toGamut(Math.min(ROOFS[r][1], lw - MIN_CONTRAST), ROOFS[r][2], ROOFS[r][3]);
const de = (a, b) => a.deltaE(b, 'OK') * 100;

// Pair distance: two pairs look alike only when both walls and both roofs are close
function evaluate(state) {
  const walls = state.map(([h], i) => wallColor(SLOTS[i][1], h));
  const roofs = state.map(([, r], i) => roofColor(r, walls[i].to('oklch').coords[0]));
  let pair = Infinity, wall = Infinity;
  for (let i = 0; i < 9; i++) for (let j = i + 1; j < 9; j++) {
    const dw = de(walls[i], walls[j]), dr = de(roofs[i], roofs[j]);
    pair = Math.min(pair, Math.hypot(dw, dr));
    wall = Math.min(wall, dw);
  }
  const reused = state.length - new Set(state.map(([, r]) => r)).size;
  const warm = state.filter(([, r]) => WARM.includes(ROOFS[r][0])).length;
  return { score: pair + 0.5 * Math.min(wall, MIN_WALL_DE) - (wall < MIN_WALL_DE ? 20 : 0) - 50 * reused - 10 * Math.max(0, MIN_WARM - warm), pair, wall, walls, roofs };
}

// Simulated annealing with a fixed seed, so the output is reproducible
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const hueChoices = (i) => {
  const r = SLOTS[i][2];
  return r ? Array.from({ length: r[1] - r[0] + 1 }, (_, k) => r[0] + k) : [NEUTRAL];
};
const roofChoices = SLOTS.map(([, , , names]) => names.map((n) => ROOFS.findIndex(([m]) => m === n)));
const randomState = () => SLOTS.map((_, i) => [pick(hueChoices(i)), pick(roofChoices[i])]);
let best = null;
for (let run = 0; run < 12; run++) {
  let s = randomState(), cur = evaluate(s);
  for (let it = 0, N = 6000; it < N; it++) {
    const t = 4 * (1 - it / N) + 0.01, n = s.map((x) => [...x]), i = Math.floor(rnd() * 9);
    if (rnd() < 0.5) n[i][0] = pick(hueChoices(i));
    else n[i][1] = pick(roofChoices[i]);
    const e = evaluate(n);
    if (e.score >= cur.score || rnd() < Math.exp((e.score - cur.score) / t)) { s = n; cur = e; }
    if (!best || cur.score > best.score) best = { ...cur, state: s };
  }
}

// Swatches keep the slot order
const order = best.state.map((_, i) => i);
const hex = (c) => c.toString({ format: 'hex' });
const walls = order.map((i) => hex(best.walls[i])), roofs = order.map((i) => hex(best.roofs[i]));
const q = (a) => `[${a.map((x) => `'${x}'`).join(', ')}]`;
console.log(`export const PALETTE = ${q(walls)};`);
console.log(`export const ROOF_OF = ${q(roofs)};`);
if (process.argv.includes('--table')) {
  console.log(`closest pair ${best.pair.toFixed(1)}, closest walls ${best.wall.toFixed(1)}`);
  const ok = (x) => new Color(x).to('oklch').coords.map((v, k) => (+v || 0).toFixed(k === 2 ? 0 : 3)).join(' ');
  order.forEach((i, n) => console.log(n + 1, SLOTS[i][0].padEnd(8), walls[n], ok(walls[n]), '|', ROOFS[best.state[i][1]][0].padEnd(10), roofs[n], ok(roofs[n])));
}
