// Small things around the houses: fountains, trees, fences, potted plants, strings of bunting
// and washing across streets, street lamps and benches, terrace parasols, ducks and lily pads.

import { WHITE, TRUNK, WATER, GOLD, SLATE, LAMP, LANTERN, LACQUER, WOOD, LILY, BLOSSOM, TERRACOTTA, UMBRELLAS, LEAVES, yBottom, hash, pickFrom, SHUTTERS } from '../constants.js';
import { p3, lerp2, offset } from '../emitter.js';

// ctx: the build context (emitter tools, town, style kit, verts, units, infoOf) plus the parts made before
export function propParts(ctx) {
  const { E, quad, blob, box, prism, cone, bar, sagString, hanging, town, verts, kit } = ctx;
  const WALLS = kit.walls;

  const fountain = (c2, y, scale, m) => {
    prism(c2, 0.34 * scale, y, y + 0.12, 8, WHITE, m, WATER);
    prism(c2, 0.05 * scale, y + 0.12, y + 0.34 * scale + 0.1, 6, WHITE, m);
    prism(c2, 0.14 * scale, y + 0.34 * scale + 0.1, y + 0.34 * scale + 0.15, 8, WHITE, m, WATER);
  };

  const tree = (c2, y, r, m, seed) => {
    box(c2, y, y + 0.35, 0.04, [1, 0], TRUNK, m);
    blob([c2[0], y + 0.55, c2[1]], r, 1.3, pickFrom(LEAVES, seed), m);
  };

  // Two posts and a rail from a to b
  const fence = (a, b, y, color, m, h = 0.2) => {
    const d = [b[0] - a[0], b[1] - a[1]];
    const dl = Math.hypot(d[0], d[1]) || 1;
    const dir = [d[0] / dl, d[1] / dl];
    for (const pt of [a, b]) box(pt, y, y + h, 0.022, dir, color, m);
    for (const side of [1, -1]) {
      quad(p3(a, y + h - 0.05), p3(b, y + h - 0.05), p3(b, y + h), p3(a, y + h), [-dir[1] * side, 0, dir[0] * side], color, m);
    }
  };
  const plants = (c2, y, seed, m) => {
    for (let k = 0; k < 2; k++) {
      const pos = offset(c2, seed * 6.28 + k * 2.4, 0.22);
      prism(pos, 0.055, y, y + 0.09, 6, TERRACOTTA, m);
      blob([pos[0], y + 0.15, pos[1]], 0.08, 1.1, pickFrom(LEAVES, hash(seed * 997, k)), m);
    }
  };
  // Red paper lantern hanging from the point top: lacquered caps, a round body of radius r, a
  // tassel below. Lit like a lamp at dusk, with a round halo
  const redLantern = (top, r, m) => {
    const [x, y, z] = top, c2 = [x, z], yc = y - 0.02 - r;
    bar(top, [x, y - 0.03, z], 0.006, LACQUER, m);
    prism(c2, r * 0.5, y - 0.035, y - 0.015, 6, LACQUER, m);
    blob([x, yc, z], r, 1.1, LANTERN, m);
    prism(c2, r * 0.45, yc - r * 1.1, yc - r * 0.95, 6, LACQUER, m);
    box(c2, yc - r * 1.1 - 0.05, yc - r * 1.1, 0.008, [1, 0], LANTERN, m);
    E.R.fx.glows.push({ x, y: yc, z, born: E.cellOf(m).b });
  };
  // n lanterns spread along a sagging string at(t), t0..t1
  const lanternString = (at, n, t0, t1, r, m) => {
    for (let f = 0; f < n; f++) redLantern(at(t0 + ((t1 - t0) * (f + 0.5)) / n), r, m);
  };
  // Bunting or a washing line across the street over ground cell v, between the second-floor
  // walls of the two facing houses (walls pass through the edge midpoints)
  const streetString = (v, [a, b], m) => {
    const y = yBottom(2) + 0.67;
    const pa = p3(lerp2(verts[v], verts[a], 0.5), y), pb = p3(lerp2(verts[v], verts[b], 0.5), y);
    const len = Math.hypot(pb[0] - pa[0], pb[2] - pa[2]);
    if (hash(v, 131) < 0.55 && kit.lanterns === 'red') {
      lanternString(sagString(pa, pb, 0.09, LACQUER, m), Math.max(2, Math.round(len / 0.3)), 0.08, 0.92, 0.045, m);
    } else if (hash(v, 131) < 0.55) {
      const at = sagString(pa, pb, 0.09, WHITE, m);
      const n = Math.max(3, Math.round(len / 0.17)), step = 0.84 / n;
      for (let f = 0; f < n; f++) {
        const t0 = 0.08 + f * step, a0 = at(t0), a1 = at(t0 + step * 0.7), c = at(t0 + step * 0.35);
        hanging([a0, a1, [c[0], c[1] - 0.1, c[2]]], pickFrom(UMBRELLAS, hash(v, 132 + f)), m);
      }
    } else {
      const at = sagString(pa, pb, 0.07, WHITE, m);
      for (let f = 0; f < 3; f++) {
        const t0 = 0.2 + f * 0.22, a0 = at(t0), a1 = at(t0 + 0.12);
        const hgt = 0.1 + hash(v, 150 + f) * 0.07;
        const col = pickFrom([WHITE, ...WALLS, ...SHUTTERS], hash(v, 160 + f));
        hanging([a0, a1, [a1[0], a1[1] - hgt, a1[2]], [a0[0], a0[1] - hgt, a0[2]]], col, m);
      }
    }
  };
  // Street lamp or a bench standing on a square; chance scales how often
  const plazaProp = (c2, y, v, m, chance = 1) => {
    const s = hash(v, 140) / chance;
    if (s < 0.16) {
      prism(c2, 0.035, y, y + 0.04, 6, SLATE, m);
      box(c2, y + 0.04, y + 0.5, 0.013, [1, 0], SLATE, m);
      box(c2, y + 0.5, y + 0.59, 0.035, [1, 0], LAMP, m);
      cone(c2, 0.06, y + 0.59, y + 0.65, 4, SLATE, m, Math.PI / 4);
    } else if (s < 0.34) {
      // Slatted wooden bench on slate legs, along a grid edge
      const u = verts[town.grid.neighbors[v][0]];
      const dl = Math.hypot(u[0] - c2[0], u[1] - c2[1]) || 1, d = [(u[0] - c2[0]) / dl, (u[1] - c2[1]) / dl];
      const nr = [-d[1], d[0]];
      const pt = (t, o) => [c2[0] + d[0] * t + nr[0] * o, c2[1] + d[1] * t + nr[1] * o];
      for (const t of [-0.12, 0.12]) {
        box(pt(t, 0.01), y, y + 0.1, 0.014, d, SLATE, m);
        box(pt(t, -0.045), y, y + 0.22, 0.012, d, SLATE, m);
      }
      for (const o of [-0.02, 0.025]) bar(p3(pt(-0.16, o), y + 0.1), p3(pt(0.16, o), y + 0.1), 0.02, WOOD, m);
      for (const yy of [0.16, 0.21]) bar(p3(pt(-0.16, -0.05), y + yy), p3(pt(0.16, -0.05), y + yy), 0.017, WOOD, m);
    }
  };
  const terraceProps = (c2, y, v, L, m) => {
    const s = hash(v, L, 61);
    if (s < 0.45) {
      // Parasol over a little table
      prism(c2, 0.1, y + 0.15, y + 0.18, 8, WHITE, m);
      prism(c2, 0.012, y, y + 0.42, 4, WHITE, m);
      cone(c2, 0.28, y + 0.36, y + 0.5, 8, pickFrom(UMBRELLAS, hash(v, L, 62)), m);
    } else if (s < 0.85) {
      for (let k = 0; k < 2; k++) {
        const pos = offset(c2, hash(v, L, 63) * 6.28 + k * 2.4, 0.22);
        prism(pos, 0.055, y, y + 0.09, 6, TERRACOTTA, m);
        blob([pos[0], y + 0.15, pos[1]], 0.08, 1.1, pickFrom(LEAVES, hash(v, L, 64 + k)), m);
      }
    }
  };
  const duck = (c2, y, ang, m) => {
    const f = [Math.cos(ang), Math.sin(ang)];
    blob([c2[0], y + 0.04, c2[1]], 0.065, 0.6, WHITE, m);
    const h = [c2[0] + f[0] * 0.05, c2[1] + f[1] * 0.05];
    blob([h[0], y + 0.1, h[1]], 0.035, 1, WHITE, m);
    box([h[0] + f[0] * 0.04, h[1] + f[1] * 0.04], y + 0.085, y + 0.1, 0.014, f, GOLD, m);
  };
  const lilyPad = (c2, y, flower, m) => {
    prism(c2, 0.07, y, y + 0.012, 7, LILY, m);
    if (flower) blob([c2[0], y + 0.03, c2[1]], 0.03, 0.8, BLOSSOM, m);
  };

  return { fountain, tree, fence, plants, redLantern, lanternString, streetString, plazaProp, terraceProps, duck, lilyPad };
}
