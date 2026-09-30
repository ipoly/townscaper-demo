// Wall surfaces and everything on them: the face with its soft occlusion bands, windows, doors,
// shutters, balconies, railings and the foundation's waterline.

import { AO_BAND, AO_FOOT, AO_EAVES, DECK, STONE, WINDOW, CURTAINS, IVY, WHITE, FOAM, GOLD, SLATE, LAMP, WOOD, SHADOW, TERRACOTTA, UMBRELLAS, BLOOMS, LEAVES, SHUTTERS, DOORS, yBottom, yTop, hash, pickFrom } from '../constants.js';
import { p3, lerp2 } from '../emitter.js';

// ctx: the build context (emitter tools, town, verts, units, infoOf) plus the parts made before
export function wallParts(ctx) {
  const { E, tri, quad, blob, box, prism, cone, bar, town, verts, units, infoOf, fence } = ctx;

  // Wall face a->b between heights y0 and y1, darkened in soft bands where it stands on the
  // ground (foot) or tucks under the eaves, in place of ambient occlusion
  const face = (a, b, y0, y1, towards, color, m, foot, under) => {
    const yA = foot ? y0 + AO_BAND : y0, yB = under ? y1 - AO_BAND : y1;
    E.shadeFn = (pt) => (foot && pt[1] < y0 + 1e-4 ? AO_FOOT : under && pt[1] > y1 - 1e-4 ? AO_EAVES : 1);
    if (foot) quad(p3(a, y0), p3(b, y0), p3(b, yA), p3(a, yA), towards, color, m);
    quad(p3(a, yA), p3(b, yA), p3(b, yB), p3(a, yB), towards, color, m);
    if (under) quad(p3(a, yB), p3(b, yB), p3(b, y1), p3(a, y1), towards, color, m);
    E.shadeFn = null;
  };
  // Which bands a house wall of cell (v, L) gets
  const aoBands = (v, L) => {
    const I = infoOf(v, L).info;
    return [L === 1 && town.has(v, 0), I.t && I.r > 0 && !I.lt];
  };

  // Everything that decorates one wall segment a->b of cell (v, L).
  // Each wall between two cells is emitted in two halves that meet at the edge midpoint;
  // aIsM tells which end of this half is that midpoint.
  // qEnd: where the face stops short of the quad center, at a rounded corner
  const wall = (a, b, aIsM, towards, v, L, target, color, m, style, bridge, terrace, qEnd = null) => {
    // A walkway is a deck at the floor of its level, flush with the neighbours' floors
    const y1 = bridge ? yBottom(L) : yTop(L);
    const y0 = bridge ? y1 - DECK : yBottom(L);
    const fa = qEnd && !aIsM ? qEnd : a, fb = qEnd && aIsM ? qEnd : b;
    if (bridge || L === 0) quad(p3(fa, y0), p3(fb, y0), p3(fb, y1), p3(fa, y1), towards, color, m);
    else face(fa, fb, y0, y1, towards, color, m, ...aoBands(v, L));

    let nx = -(b[1] - a[1]), nz = b[0] - a[0];
    const len = Math.hypot(nx, nz) || 1;
    nx /= len; nz /= len;
    if (nx * towards[0] + nz * towards[2] < 0) { nx = -nx; nz = -nz; }
    const at = (t, off) => { const p = lerp2(a, b, t); return [p[0] + nx * off, p[1] + nz * off]; };
    let tm = (u) => (aIsM ? u : 1 - u); // u = 0 at the edge midpoint, 1 at the quad center
    const rect = (t0, t1, h0, h1, c, off = 0.01) =>
      quad(p3(at(t0, off), y0 + h0), p3(at(t1, off), y0 + h0), p3(at(t1, off), y0 + h1), p3(at(t0, off), y0 + h1), towards, c, m);
    // Solid block against the wall: footprint u0..u1 along it, reaching out to depth d
    const slab = (u0, u1, d, yA, yB, c) => {
      const s0 = at(tm(u0), 0), s1 = at(tm(u1), 0), e0 = at(tm(u0), d), e1 = at(tm(u1), d);
      const along = [s1[0] - s0[0], 0, s1[1] - s0[1]];
      quad(p3(s0, yB), p3(s1, yB), p3(e1, yB), p3(e0, yB), [0, 1, 0], c, m);
      quad(p3(e0, yA), p3(e1, yA), p3(e1, yB), p3(e0, yB), towards, c, m);
      quad(p3(s0, yA), p3(e0, yA), p3(e0, yB), p3(s0, yB), [-along[0], 0, -along[2]], c, m);
      quad(p3(s1, yA), p3(e1, yA), p3(e1, yB), p3(s1, yB), along, c, m);
    };
    const dirAlong = () => { const d = [b[0] - a[0], b[1] - a[1]]; const dl = Math.hypot(d[0], d[1]) || 1; return [d[0] / dl, d[1] / dl]; };
    // Where the face bends sharply at the edge midpoint a window centered there would fold,
    // so each half gets its own, sized to fit the shorter half. Returns its max half width.
    const splitWidth = () => {
      const mid = aIsM ? a : b, qc = aIsM ? b : a;
      const centers = town.vertexQuads[v].filter((qq) => qq.includes(target)).map((qq) =>
        [qq.reduce((s, u) => s + verts[u][0], 0) / 4, qq.reduce((s, u) => s + verts[u][1], 0) / 4]);
      const other = centers.find((c) => Math.hypot(c[0] - qc[0], c[1] - qc[1]) > 1e-6);
      if (!other) return 0;
      const d1 = [mid[0] - qc[0], mid[1] - qc[1]], d2 = [other[0] - mid[0], other[1] - mid[1]];
      const l2 = Math.hypot(d2[0], d2[1]);
      if ((d1[0] * d2[0] + d1[1] * d2[1]) / (len * l2) > Math.cos(0.35)) return 0;
      return Math.max(0.08, Math.min(len, l2) / 2 - 0.06);
    };

    if (L === 0) {
      // Foam ring where the foundation meets the water, posts under docks
      if (!units.ponds.has(target)) {
        E.noOutline = true;
        // Stops where a rounded corner takes over (fa/fb lie on a-b)
        const tOf = (pt) => ((pt[0] - a[0]) * (b[0] - a[0]) + (pt[1] - a[1]) * (b[1] - a[1])) / (len * len);
        const t0 = tOf(fa), t1 = tOf(fb);
        quad(p3(at(t0, 0.005), 0.02), p3(at(t1, 0.005), 0.02), p3(at(t1, 0.14), 0.02), p3(at(t0, 0.14), 0.02), [0, 1, 0], FOAM, m);
        E.noOutline = false;
      }
      if (style === 'dock') box(at(0.5, 0.06), -0.3, y1 + 0.12, 0.05, dirAlong(), WOOD, m);
      return;
    }
    if (bridge) {
      // Railing along the open side of a walkway
      for (const t of [0.15, 0.85]) box(at(t, -0.04), y1, y1 + 0.22, 0.025, dirAlong(), WHITE, m);
      const r0 = at(0, -0.04), r1 = at(1, -0.04);
      for (const side of [1, -1]) {
        quad(p3(r0, y1 + 0.17), p3(r1, y1 + 0.17), p3(r1, y1 + 0.22), p3(r0, y1 + 0.22),
          [towards[0] * side, 0, towards[2] * side], WHITE, m);
      }
      return;
    }

    if (terrace) fence(at(0, -0.04), at(1, -0.04), y1, WHITE, m);
    const h = hash(v, L, target);
    const facesPlaza = L === 1 && !town.has(target, 1) && town.has(target, 0);
    if (style === 'lighthouse') {
      if (h < 0.5) rect(0.42, 0.58, 0.32, 0.5, WINDOW);
      return;
    }
    // Windows are centered on the whole face: this half draws u = 0..w and the neighbouring
    // half-wall the mirror image. Sizes are in world units so both halves match.
    const U = (x) => Math.min(0.7, x / len);
    const FRAME = 0.045;
    // Fan around the face center at height yc, angles a0..a1 (u = cos * r, y = sin * r)
    const fan = (yc, r, a0, a1, off, c) => {
      const pt = (a) => p3(at(tm(Math.max(0, Math.cos(a) * r) / len), off), yc + Math.sin(a) * r);
      const c0 = p3(at(tm(0), off), yc);
      for (let k = 0; k < 6; k++) tri(c0, pt(a0 + ((a1 - a0) * k) / 6), pt(a0 + ((a1 - a0) * (k + 1)) / 6), towards, c, m);
    };
    // Glass reflects the sky: panes brighten towards the top
    const skyGlass = (yA, yB) => { E.shadeFn = (pt) => 1 + 0.6 * Math.max(0, Math.min(1, (pt[1] - yA) / (yB - yA))); };
    // Curtain gathered at the outer edge of a pane, tied back halfway down
    const curtain = (hw, yA, yT, c) => {
      const w = U(hw), yM = yA + (yT - yA) * 0.45;
      const pt = (u, y) => p3(at(tm(u), 0.015), y);
      quad(pt(w - U(0.06), yT), pt(w, yT), pt(w, yM), pt(w - U(0.02), yM), towards, c, m);
      quad(pt(w - U(0.02), yM), pt(w, yM), pt(w, yA + 0.02), pt(w - U(0.035), yA + 0.02), towards, c, m);
    };
    // Lit windows spill a soft halo onto the wall at night: center, outward normal, half size and the
    // corner radius below and above (round windows and arches). Both halves of a face push the same halo;
    // the renderer keeps one
    const halo = (yc, hw, hh, rb = 0, rt = 0) => {
      const I = infoOf(v, L).info;
      if (!I.lit) return;
      const c = at(tm(0), 0);
      E.R.fx.halos.push({ x: c[0], y: yc, z: c[1], nx, nz, hw, hh, rb, rt, order: I.lit, born: I.b });
    };
    // Big window with a chunky frame, optionally round-arched; hw is its half width
    const window1 = (hw, h0, h1, round = false, drape = null) => {
      const w = U(hw), f = U(FRAME), yA = y0 + h0, yB = y0 + h1;
      halo((yA + yB) / 2, hw, (yB - yA) / 2, 0, round ? hw : 0);
      const ys = round ? yB - hw : yB; // springline of the arch
      skyGlass(yA, yB);
      rect(tm(0), tm(w), h0, ys - y0, WINDOW, 0.004);
      if (round) fan(ys, hw, 0, Math.PI / 2, 0.012, WINDOW);
      E.shadeFn = null;
      if (drape) curtain(hw, yA, ys, drape);
      slab(w, w + f, 0.035, yA, ys, WHITE);
      slab(0, w + f + U(0.02), 0.06, yA - FRAME, yA, WHITE); // sill
      if (!round) {
        slab(0, w + f, 0.04, yB, yB + FRAME, WHITE);
        return;
      }
      fan(ys, hw + FRAME, 0, Math.PI / 2, 0.008, WHITE);
    };
    // Round window: this half draws its half disc
    const porthole = (r, hc) => {
      halo(y0 + hc, r, r, r, r);
      fan(y0 + hc, r + FRAME, -Math.PI / 2, Math.PI / 2, 0.008, WHITE);
      skyGlass(y0 + hc - r, y0 + hc + r);
      fan(y0 + hc, r, -Math.PI / 2, Math.PI / 2, 0.012, WINDOW);
      E.shadeFn = null;
    };
    // Flower box hanging under a window's sill: this half fills u = 0..uw
    const flowerBox = (uw, yS, seed) => {
      slab(0, uw, 0.1, yS - 0.08, yS + 0.005, seed < 0.5 ? TERRACOTTA : WHITE);
      const leaf = pickFrom(LEAVES, seed * 7 % 1);
      for (const [x, r] of [[0.05, 0.045], [0.15, 0.04]]) {
        if (U(x) > uw) continue;
        const pos = at(tm(U(x)), 0.06);
        blob([pos[0], yS + 0.025, pos[1]], r, 0.8, leaf, m);
        const bloom = at(tm(U(x + 0.03)), 0.085);
        blob([bloom[0], yS + 0.05, bloom[1]], 0.025, 1, pickFrom(BLOOMS, (seed * 13 + x * 3) % 1), m);
      }
    };
    // Striped awning over a door, sloping out from the wall; stripes are laid out in world
    // units from the face center so the two halves line up. This half covers u = 0..uw.
    const awning = (uw, yW, yO, d, color) => {
      const sw = 0.06, n = Math.ceil((uw * len) / sw), yV = yO - 0.05;
      for (let k = 0; k < n; k++) {
        const u0 = (k * sw) / len, u1 = Math.min(uw, ((k + 1) * sw) / len);
        const c = k % 2 ? WHITE : color;
        const w0 = at(tm(u0), 0), w1 = at(tm(u1), 0), o0 = at(tm(u0), d), o1 = at(tm(u1), d);
        quad(p3(w0, yW), p3(w1, yW), p3(o1, yO), p3(o0, yO), [towards[0], 1, towards[2]], c, m);
        quad(p3(o0, yO), p3(o1, yO), p3(o1, yV), p3(o0, yV), towards, c, m);
        E.noOutline = true;
        quad(p3(w0, yW), p3(w1, yW), p3(o1, yV), p3(o0, yV), [0, -1, 0], c.clone().multiplyScalar(0.6), m);
        E.noOutline = false;
      }
      const e = at(tm(uw), 0), eo = at(tm(uw), d), side = [e[0] - at(tm(0), 0)[0], 0, e[1] - at(tm(0), 0)[1]];
      tri(p3(e, yW), p3(eo, yO), p3(eo, yV), side, color, m);
    };
    // Door leaf u0..u1 (u = 0 at the edge midpoint); starting at 0 it is one wing of a double
    // door centered on the face, whose other wing comes from the neighbouring half-wall
    // An arched double door gets a half-round fanlight spanning both wings instead.
    const door = (u0, u1, color, arched = false) => {
      const hd = 0.42, f = 0.05;
      if (arched && u0 === 0) {
        const r = u1 * len, fw = f * len;
        rect(tm(0), tm(u1), 0.03, hd, color, 0.006);
        slab(u1, u1 + f, 0.03, y0, y0 + hd + 0.03, WHITE);
        slab(0, u1, 0.03, y0 + hd, y0 + hd + 0.03, WHITE);
        fan(y0 + hd + 0.03, r + fw, 0, Math.PI / 2, 0.008, WHITE);
        fan(y0 + hd + 0.03, r, 0, Math.PI / 2, 0.012, WINDOW);
        slab(0, u1 + f + 0.03, 0.08, y0, y0 + 0.03, STONE); // doorstep
        rect(tm(u1 - 0.042), tm(u1 - 0.018), hd * 0.5, hd * 0.5 + 0.024, GOLD, 0.01);
        return;
      }
      rect(tm(u0), tm(u1), 0.03, hd, color, 0.006);
      rect(tm(u0), tm(u1), hd + 0.03, hd + 0.12, WINDOW, 0.006); // fanlight
      if (u0 > 0) slab(u0 - f, u0, 0.03, y0, y0 + hd + 0.12, WHITE);
      slab(u1, u1 + f, 0.03, y0, y0 + hd + 0.12, WHITE);
      slab(u0, u1, 0.03, y0 + hd, y0 + hd + 0.03, WHITE);
      slab(Math.max(0, u0 - f - 0.02), u1 + f + 0.02, 0.045, y0 + hd + 0.12, y0 + hd + 0.16, WHITE);
      slab(Math.max(0, u0 - f - 0.03), u1 + f + 0.03, 0.08, y0, y0 + 0.03, STONE); // doorstep
      const knob = u0 > 0 ? u0 + 0.03 : u1 - 0.03;
      rect(tm(knob - 0.012), tm(knob + 0.012), hd * 0.5, hd * 0.5 + 0.024, GOLD, 0.01);
    };
    if (facesPlaza && town.has(v, 2)) {
      const s = hash(v, target, 7);
      if (s < 0.3) {
        // One straight flight along the whole face: it starts at the far corner of one half,
        // passes the edge midpoint halfway up and ends on a landing before the door above.
        // x runs 0..2 along the face; this half covers 0..1 or 1..2.
        const lower = aIsM;
        const toU = (x) => (lower ? 1 - x : x - 1);
        const N = 9, xl = 1.55, sw = xl / N, H = y1 - y0, d = 0.22;
        for (let k = 0; k < N; k++) {
          const xa = Math.max(k * sw, lower ? 0 : 1), xb = Math.min((k + 1) * sw, lower ? 1 : 2);
          if (xa >= xb) continue;
          const ua = toU(xa), ub = toU(xb);
          slab(Math.min(ua, ub), Math.max(ua, ub), d, y0, y0 + (H * (k + 1)) / (N + 1), WHITE);
        }
        if (!lower) slab(toU(xl), 1, d + 0.04, y0, y1, WHITE);
        // Railing following the flight
        const rail = (x) => (x < xl ? y0 + (H * x) / xl : y1) + 0.2;
        const pt = (x) => p3(at(tm(toU(x)), d - 0.02), rail(x));
        const [xa, xb] = lower ? [0.05, 1] : [1, 1.98];
        bar(pt(xa), pt(Math.min(xb, Math.max(xa, xl))), 0.014, WHITE, m);
        if (!lower) bar(pt(xl), pt(xb), 0.014, WHITE, m);
        for (const x of lower ? [0.05, 0.55] : [1.1, xl, 1.98]) {
          const b0 = at(tm(toU(x)), d - 0.02);
          box(b0, rail(x) - 0.2 - (x < xl ? 0.05 : 0), rail(x), 0.015, dirAlong(), WHITE, m);
        }
        return;
      }
      if (s < 0.55) {
        // Arcade: an arched opening between pillars
        const u0 = 0.14, u1 = 0.84, top = 0.46;
        rect(tm(u0), tm(u1), 0, top, SHADOW);
        const mid = (u0 + u1) / 2, r = (u1 - u0) / 2;
        for (let k = 0; k < 6; k++) {
          const a0 = (k / 6) * Math.PI, a1 = ((k + 1) / 6) * Math.PI;
          const pt = (ang) => p3(at(tm(mid + Math.cos(ang) * r), 0.01), y0 + top + Math.sin(ang) * 0.22);
          tri(p3(at(tm(mid), 0.01), y0 + top), pt(a0), pt(a1), towards, SHADOW, m);
        }
        return;
      }
    }
    if (L >= 2 && town.has(target, L - 1) && !town.has(target, L) && infoOf(target, L - 1).info.tr) {
      // French door out onto the neighbour's roof terrace
      window1(0.14, 0.03, 0.57);
      return;
    }
    // A lower neighbour's pitched roof rises against this wall and would bury the window
    if (L >= 2 && town.has(target, L - 1) && !town.has(target, L)) {
      const T = infoOf(target, L - 1).info;
      if (T.t && !T.br && !T.cv && T.r > 0) return;
    }
    if (L === 2 && town.hasStair(v, target) && !aIsM) {
      // Door on the landing at the top of the staircase
      door(0.6, 0.9, pickFrom(DOORS, hash(v, target, 3)));
      return;
    }
    // Ground floor facing a plaza, or any floor a walkway docks onto, gets a double door
    // Wall lantern on a bracket beside a door; this half draws the one on its side
    const lantern = (u, yl) => {
      const w0 = at(tm(u), 0), w1 = at(tm(u), 0.07);
      slab(u - U(0.012), u + U(0.012), 0.07, yl + 0.1, yl + 0.12, SLATE);
      box(w1, yl, yl + 0.09, 0.03, dirAlong(), LAMP, m);
      cone(w1, 0.05, yl + 0.09, yl + 0.14, 4, SLATE, m, Math.PI / 4);
      box(w0, yl - 0.02, yl + 0.14, 0.018, dirAlong(), SLATE, m);
    };
    if ((facesPlaza && h < 0.6) || (units.bridge.has(town.key(target, L)) && h < 0.75)) {
      if (hash(v, target, 11) < 0.5) lantern(Math.min(0.9, 0.2 + 0.05 + U(0.08)), y0 + 0.36);
      const shaded = facesPlaza && hash(v, target, 8) < 0.55;
      door(0, 0.2, pickFrom(DOORS, hash(v, target, 3)), !shaded && hash(v, target, 10) < 0.6);
      if (shaded) awning(0.29, y0 + 0.66, y0 + 0.54, 0.2, pickFrom(UMBRELLAS.slice(0, 3), hash(v, target, 9)));
      // Potted shrub on the ground beside some plaza doors, past the doorstep
      if (facesPlaza && L === 1 && hash(v, target, 25) < 0.45) {
        const pos = at(tm(Math.min(0.9, 0.28 + U(0.07))), 0.1), fl = hash(v, target, 26) < 0.5;
        prism(pos, 0.045, y0, y0 + 0.08, 6, TERRACOTTA, m);
        prism(pos, 0.055, y0 + 0.08, y0 + 0.105, 6, TERRACOTTA, m);
        blob([pos[0], y0 + 0.16, pos[1]], 0.07, 1, pickFrom(LEAVES, hash(v, target, 27)), m);
        if (fl) {
          const bloom = pickFrom(BLOOMS, hash(v, target, 28));
          for (let k = 0; k < 3; k++) {
            const a = (k / 3) * Math.PI * 2 + hash(v, target, 29) * 6;
            blob([pos[0] + Math.cos(a) * 0.045, y0 + 0.19, pos[1] + Math.sin(a) * 0.045], 0.025, 1, bloom, m);
          }
        }
      }
      return;
    }
    // Bushes at the foot of walls that face a lawn or a square
    if (facesPlaza && infoOf(target, 0).info.gt !== 'dock' && hash(v, target, 12) < 0.45) {
      const leaf = pickFrom(LEAVES, hash(v, target, 13));
      for (const [x, r] of [[0.28, 0.085], [0.4, 0.06]]) {
        const pos = at(tm(Math.min(0.9, U(x))), 0.08);
        blob([pos[0], y0 + r * 0.7, pos[1]], r, 0.9, leaf, m);
      }
    }
    const sw = h < 0.1 ? 0 : splitWidth();
    // Ivy climbing from the foot of some ground-floor walls, away from the window
    if (L === 1 && aIsM && !sw && hash(v, target, 19) < 0.22) {
      const leaf = pickFrom(IVY, hash(v, target, 20)), top = town.has(v, 2) ? 0.95 : 0.6;
      for (let k = 0; k < 30; k++) {
        const t = Math.pow(hash(v, target, 21 + k), 1.5), spread = 0.03 + 0.12 * (1 - t);
        const u = Math.min(0.95, 0.72 + U((hash(v, target, 61 + k) - 0.5) * 2 * spread));
        const pos = at(tm(u), 0.025);
        blob([pos[0], y0 + 0.035 + t * top, pos[1]], 0.05 - 0.02 * t, 0.85, leaf, m);
      }
    }
    if (h < 0.1) return; // blank wall
    const drape = (k) => (hash(v, L, target, 23) < k ? pickFrom(CURTAINS, hash(v, L, target, 24)) : null);
    if (sw) {
      // A window per half, drawn from its center outwards to both sides; shutters and
      // balconies need the whole face, so those become plain windows
      const base = tm, fit = (x) => Math.min(x, sw - FRAME), fb = hash(v, L, target, 17);
      for (const s of [1, -1]) {
        tm = (u) => base(0.5 + s * u);
        if (h < 0.42) {
          window1(fit(0.15), 0.21, 0.57, false, drape(0.4));
          if (fb < 0.45) flowerBox(U(fit(0.15)) + U(FRAME) + U(0.02), y0 + 0.21 - FRAME, fb / 0.45);
        } else if (h < 0.62) window1(fit(0.14), 0.19, 0.59, true, drape(0.3));
        else if (h < 0.86 && (h < 0.76 || L >= 2)) window1(fit(0.14), 0.21, 0.57);
        else porthole(fit(0.12), 0.4);
      }
      tm = base;
      return;
    }
    if (h < 0.42) {
      window1(0.15, 0.21, 0.57, false, drape(0.4));
      const fb = hash(v, L, target, 17);
      if (fb < 0.45) flowerBox(U(0.15) + U(FRAME) + U(0.02), y0 + 0.21 - FRAME, fb / 0.45);
    } else if (h < 0.62) {
      window1(0.14, 0.19, 0.59, true, drape(0.3));
    } else if (h < 0.76) {
      const sc = pickFrom(SHUTTERS, hash(v, L, 11)), w = U(0.13) + U(0.045);
      window1(0.13, 0.23, 0.55);
      slab(w + U(0.015), w + U(0.12), 0.02, y0 + 0.22, y0 + 0.56, sc);
    } else if (h < 0.86 && L >= 2) {
      // Balcony: French window, thick slab on brackets, balustrade, sometimes a pot
      const iron = hash(v, L, target, 13) < 0.45;
      const rc = iron ? SLATE : WHITE, d = 0.2, w = U(0.3);
      window1(0.13, 0.04, 0.57);
      slab(0, w, d, y0 - 0.02, y0 + 0.035, WHITE);
      slab(U(0.17), U(0.22), d * 0.6, y0 - 0.14, y0 - 0.02, WHITE);
      const yr = y0 + 0.24, dir = dirAlong();
      const front = (u) => at(tm(u), d - 0.02);
      const wr = w - U(0.015);
      bar(p3(front(0), yr), p3(front(wr), yr), 0.016, rc, m);
      bar(p3(at(tm(wr), 0), yr), p3(front(wr), yr), 0.016, rc, m);
      for (let k = 1; k <= 3; k++) box(front((wr * k) / 3), y0 + 0.035, yr, iron ? 0.008 : 0.016, dir, rc, m);
      box(at(tm(wr), d * 0.5), y0 + 0.035, yr, iron ? 0.008 : 0.016, dir, rc, m);
      if (aIsM && hash(v, L, target, 14) < 0.5) {
        const pos = at(tm(w * 0.6), 0.1);
        prism(pos, 0.04, y0 + 0.035, y0 + 0.11, 6, TERRACOTTA, m);
        blob([pos[0], y0 + 0.16, pos[1]], 0.06, 1, pickFrom(BLOOMS, hash(v, L, target, 16)), m);
      }
    } else {
      porthole(0.12, 0.4);
    }
  };

  return { face, aoBands, wall };
}
