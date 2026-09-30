// How floating blocks are carried: posts and stems, timber brackets, joists, tie rods, and the
// shaped undersides (arches, corbels, drops) with the seams between them.

import { ARCH_RISE, DECK, STONE, WINDOW, WHITE, SLATE, LAMP, WOOD, LEAVES, yBottom, yTop, hash, pickFrom } from '../constants.js';
import { p3, lerp2, ring, offset } from '../emitter.js';

// ctx: the build context (emitter tools, town, verts, units, infoOf) plus the parts made before
export function carryParts(ctx) {
  const { tri, quad, box, prism, bar, hanging, town, verts } = ctx;

  // Posts carrying a unit of blocks. They stand only on its outline: at each quad corner
  // where the unit meets anything but itself, never against a solid wall it rests on, and
  // only once per corner (from the unit cell with the highest floor, so the post is shortest).
  // A lone block over its own column may sit on a central stem instead.
  const posts = (v, L, I, q, i, C, M, Q, inf, yb, wallColor, firstQuad, m) => {
    const kind = I.pk;
    const n = (i + 1) % 4, p = (i + 3) % 4;
    const c = C[i];
    const toC = (() => { const d = [c[0] - Q[0], c[1] - Q[1]]; const dl = Math.hypot(d[0], d[1]) || 1; return [d[0] / dl, d[1] / dl]; })();
    if (kind === 'colonnade' && firstQuad) {
      // Lantern hanging from the vault
      const yv = yb + ARCH_RISE;
      bar([c[0], yv, c[1]], [c[0], yv - 0.22, c[1]], 0.008, SLATE, m);
      box(c, yv - 0.34, yv - 0.22, 0.045, [1, 0], LAMP, m);
      box(c, yv - 0.23, yv - 0.2, 0.06, [1, 0], SLATE, m);
    }
    if (kind === 'stem') {
      // Central stem that flares out with struts, like a dovecote
      const y0 = I.pb;
      if (firstQuad) {
        prism(c, 0.28, y0, yb, 8, wallColor.clone().multiplyScalar(0.85), m);
        box(offset(c, Math.atan2(toC[1], toC[0]) + Math.PI, 0.275), y0 + 0.5, y0 + 0.78, 0.035, toC, WINDOW, m);
      }
      const a = lerp2(c, Q, 0.3), b = lerp2(c, Q, 0.82);
      bar([a[0], y0 + (yb - y0) * 0.55, a[1]], [b[0], yb - 0.02, b[1]], 0.025, WOOD, m);
      return;
    }
    const mine = (j) => !!inf[j] && inf[j].pk === kind && inf[j].pu === I.pu;
    if (q.every((u, j) => mine(j)) || q.some((u, j) => inf[j] && town.has(u, L - 1))) return;
    let e = -1;
    for (let j = 0; j < 4; j++) if (mine(j) && (e < 0 || inf[j].pb > inf[e].pb)) e = j;
    if (e !== i) return;
    const post = lerp2(Q, c, 0.2);
    const y0 = I.pb, y1 = yb;
    // Knee braces on timber posts reach out along the unit's outer edges, or both ways at an outer corner
    let edges = [[n, M[i]], [p, M[p]]].filter(([j]) => !mine(j)).map(([, mid]) => mid);
    if (!edges.length) edges = [M[i], M[p]];
    const knees = (drop, r) => {
      for (const mid of edges) {
        const f = lerp2(lerp2(mid, c, 0.16), post, 0.45);
        bar([post[0], y1 - drop, post[1]], [f[0], y1 - 0.02, f[1]], r, WOOD, m);
      }
    };
    if (kind === 'colonnade') {
      prism(post, 0.08, y0, y1 - 0.08, 8, WHITE, m);
      box(post, y0, y0 + 0.06, 0.1, toC, WHITE, m);
      box(post, y1 - 0.09, y1, 0.105, toC, WHITE, m);
    } else if (kind === 'timber') {
      box(post, y0, y1, 0.055, toC, WOOD, m);
      knees(0.3, 0.026);
    } else if (kind === 'stilts') {
      box(post, y0, y1, 0.085, toC, STONE, m);
      box(post, y1 - 0.08, y1, 0.105, toC, STONE.clone().multiplyScalar(0.9), m);
    } else {
      // Tall pillar down to a far roof or the sea bed, thicker the longer it runs
      const r = Math.min(0.13, 0.085 + (y1 - y0) * 0.008);
      box(post, y0, y0 + 0.12, r + 0.035, toC, STONE.clone().multiplyScalar(0.85), m);
      prism(post, r, y0, y1 - 0.09, 8, STONE, m);
      box(post, y1 - 0.1, y1, r + 0.03, toC, STONE.clone().multiplyScalar(0.9), m);
    }
  };

  // Timber brackets under a block leaning out over a lower neighbour: on each half of the
  // shared edge a joist runs in under the floor and a strut rises to it from the wall below
  const brackets = (L, I, q, i, C, M, Q, yb, m) => {
    const n = (i + 1) % 4, p = (i + 3) % 4;
    for (const [j, a] of [[n, M[i]], [p, M[p]]]) {
      const hit = I.bu.find(([u]) => u === q[j]);
      if (!hit) continue;
      const e = lerp2(a, Q, 0.5);
      const d = [C[i][0] - e[0], C[i][1] - e[1]];
      const dl = Math.hypot(d[0], d[1]) || 1;
      const dir = [d[0] / dl, d[1] / dl];
      const foot = lerp2(e, C[i], 0.04), head = lerp2(e, C[i], hit[1] === L - 1 ? 0.7 : 0.9);
      const ys = yTop(hit[1]) - (hit[1] === L - 1 ? 0.45 : 0.15);
      const joist = lerp2(e, C[i], 0.85);
      bar([e[0], yb - 0.035, e[1]], [joist[0], yb - 0.035, joist[1]], 0.032, WOOD, m);
      bar([foot[0], ys, foot[1]], [head[0], yb - 0.06, head[1]], 0.024, WOOD, m);
      box(foot, ys - 0.07, ys + 0.05, 0.045, dir, WOOD.clone().multiplyScalar(0.8), m);
    }
  };
  // Joists under a block held by its neighbours: one runs in from each holder's edge, braced
  // by a strut from the holder's wall below when it has one; a beam trims the outer edges
  const joists = (v, L, I, q, i, C, M, Q, occ, yb, wallColor, firstQuad, m) => {
    const n = (i + 1) % 4, p = (i + 3) % 4;
    for (const [j, a] of [[n, M[i]], [p, M[p]]]) {
      const e = lerp2(a, Q, 0.5);
      if (!occ[j]) {
        // Edge beam along the open side
        const b0 = lerp2(a, C[i], 0.06), b1 = lerp2(Q, C[i], 0.06);
        bar([b0[0], yb - 0.04, b0[1]], [b1[0], yb - 0.04, b1[1]], 0.04, WOOD, m);
        continue;
      }
      if (!I.un.includes(q[j])) continue;
      const d = [C[i][0] - e[0], C[i][1] - e[1]];
      const dl = Math.hypot(d[0], d[1]) || 1;
      const dir = [d[0] / dl, d[1] / dl];
      const joist = lerp2(e, C[i], 0.9);
      bar([e[0], yb - 0.035, e[1]], [joist[0], yb - 0.035, joist[1]], 0.032, WOOD, m);
      if (!I.hw || !I.hw.includes(q[j])) continue;
      const foot = lerp2(e, C[i], 0.04), head = lerp2(e, C[i], 0.6);
      const ys = Math.max(yb - 0.5, 0.15);
      bar([foot[0], ys, foot[1]], [head[0], yb - 0.06, head[1]], 0.024, WOOD, m);
      box(foot, ys - 0.07, ys + 0.05, 0.045, dir, WOOD.clone().multiplyScalar(0.8), m);
    }
    if (firstQuad && hash(v, L, 88) < 0.35 && yb - 0.3 > 0.05) {
      // Lantern under the middle
      bar([C[i][0], yb, C[i][1]], [C[i][0], yb - 0.16, C[i][1]], 0.008, SLATE, m);
      box(C[i], yb - 0.27, yb - 0.16, 0.04, [1, 0], LAMP, m);
    }
  };
  // Iron tie rods from a taller building's wall down to both edges of a walkway deck, or
  // onto a gallery's roof, drawn once per cell; each anchor gets a wall plate
  const tieRods = (v, I, yd, m) => {
    const ye = I.bs === 'c' ? yd + 0.66 : yd + 0.02;
    const c = verts[v];
    for (const [ax, ay, az] of I.sy) {
      const d = [c[0] - ax, c[1] - az];
      const dl = Math.hypot(d[0], d[1]) || 1;
      const side = [-d[1] / dl * 0.3, d[0] / dl * 0.3];
      box([ax, az], ay - 0.06, ay + 0.06, 0.05, [d[0] / dl, d[1] / dl], SLATE, m);
      for (const s of [1, -1]) bar([ax, ay, az], [c[0] + side[0] * s, ye, c[1] + side[1] * s], 0.008, SLATE, m);
    }
  };

  // Underside of a block hanging free, shaped by what holds it: an arch between two opposite
  // neighbours, a corbel swelling out of the wall it leans on, an inverted pyramid when alone.
  // d(pt) is how far the underside hangs below the level bottom at a point.
  const undersideShape = (v, un, yb) => {
    const c = verts[v];
    const lowest = 0.1; // stay above the sea
    if (!un.length) return { kind: 'drop', apex: Math.max(lowest, yb - 0.55) };
    const unit = (d) => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };
    const dirs = un.map((u) => unit([verts[u][0] - c[0], verts[u][1] - c[1]]));
    const proj = (pt, ax) => (pt[0] - c[0]) * ax[0] + (pt[1] - c[1]) * ax[1];
    const mid = (u) => lerp2(c, verts[u], 0.5);
    let pair = null, most = 1;
    for (let a = 0; a < dirs.length; a++) {
      for (let b = a + 1; b < dirs.length; b++) {
        const dt = dirs[a][0] * dirs[b][0] + dirs[a][1] * dirs[b][1];
        if (dt < most) { most = dt; pair = [a, b]; }
      }
    }
    const sum = dirs.reduce((s, d) => [s[0] + d[0], s[1] + d[1]], [0, 0]);
    if (pair && (most < -0.45 || Math.hypot(sum[0], sum[1]) < 0.3)) {
      const [a, b] = pair;
      const ax = unit([dirs[b][0] - dirs[a][0], dirs[b][1] - dirs[a][1]]);
      const S = (Math.abs(proj(mid(un[a]), ax)) + Math.abs(proj(mid(un[b]), ax))) / 2;
      const D = Math.min(0.42, yb - lowest);
      // Round arch: springs from both neighbours, crown flush with the level bottom
      return { kind: 'arch', from: [un[a], un[b]], d: (pt) => { const t = Math.min(1, Math.abs(proj(pt, ax)) / S); return D * (1 - Math.sqrt(1 - t * t)); } };
    }
    const ax = unit(sum);
    const S = un.reduce((s, u) => s + proj(mid(u), ax), 0) / un.length;
    const D = Math.min(0.5, yb - lowest);
    const from = un.filter((u, k) => dirs[k][0] * ax[0] + dirs[k][1] * ax[1] > 0.5);
    return { kind: 'corbel', from, d: (pt) => { const t = Math.min(1, Math.max(0, (proj(pt, ax) + S) / (2 * S))); return D * t ** 1.5; } };
  };
  // Thin cornice band just above the underside along an outer wall
  const band = (a, b, towards, y0, y1, color, m) => {
    let nx = -(b[1] - a[1]), nz = b[0] - a[0];
    const len = Math.hypot(nx, nz) || 1;
    nx /= len; nz /= len;
    if (nx * towards[0] + nz * towards[2] < 0) { nx = -nx; nz = -nz; }
    const o = (pt) => [pt[0] + nx * 0.025, pt[1] + nz * 0.025];
    quad(p3(o(a), y0), p3(o(b), y0), p3(o(b), y1), p3(o(a), y1), towards, color, m);
    quad(p3(a, y0), p3(b, y0), p3(o(b), y0), p3(o(a), y0), [0, -1, 0], color, m);
    quad(p3(a, y1), p3(b, y1), p3(o(b), y1), p3(o(a), y1), [0, 1, 0], color, m);
  };
  const underside = (v, L, un, q, i, C, M, Q, occ, yb, wallColor, firstQuad, m) => {
    const n = (i + 1) % 4, p = (i + 3) % 4;
    const shape = undersideShape(v, un, yb);
    const shade = wallColor.clone().multiplyScalar(0.7);
    const outer = [[n, M[i], Q], [p, Q, M[p]]].filter(([j]) => !occ[j]);
    const outward = (j) => [C[j][0] - C[i][0], 0, C[j][1] - C[i][1]];
    for (const [j, a, b] of outer) band(a, b, outward(j), yb, yb + 0.07, wallColor.clone().multiplyScalar(0.82), m);

    if (shape.kind === 'drop') {
      const A = p3(C[i], shape.apex);
      for (const [j, a, b] of outer) {
        const o = outward(j);
        tri(p3(a, yb), p3(b, yb), A, [o[0], -0.6, o[2]], shade, m);
      }
      if (firstQuad && shape.apex - 0.2 > 0.05) {
        if (hash(v, L, 87) < 0.5) {
          // Lantern hanging from the tip
          bar(A, [C[i][0], shape.apex - 0.08, C[i][1]], 0.008, SLATE, m);
          box(C[i], shape.apex - 0.19, shape.apex - 0.08, 0.04, [1, 0], LAMP, m);
        } else {
          // Stone drop finial
          const pts = ring(C[i], 0.05, 6, 0), tip = p3(C[i], shape.apex - 0.14);
          for (let k = 0; k < 6; k++) {
            const a = pts[k], b = pts[(k + 1) % 6];
            tri(p3(a, shape.apex), p3(b, shape.apex), tip, [(a[0] + b[0]) / 2 - C[i][0], -0.02, (a[1] + b[1]) / 2 - C[i][1]], shade, m);
          }
        }
      }
      return shape;
    }

    // Curved underside, subdivided so the arch / corbel reads as a smooth curve
    const d = shape.d;
    const G = 4;
    const P = (u, w) => lerp2(lerp2(C[i], M[i], u), lerp2(M[p], Q, u), w);
    const Y = (pt) => p3(pt, yb - d(pt));
    for (let a = 0; a < G; a++) {
      for (let b = 0; b < G; b++) {
        quad(Y(P(a / G, b / G)), Y(P((a + 1) / G, b / G)), Y(P((a + 1) / G, (b + 1) / G)), Y(P(a / G, (b + 1) / G)), [0, -1, 0], shade, m);
      }
    }
    // Spandrels closing the outer walls down to the curve, sampled at the underside's own
    // vertices so their bottom edge meets it without a crack
    const S = G;
    for (const [j, a, b] of outer) {
      const o = outward(j);
      for (let k = 0; k < S; k++) {
        const e0 = lerp2(a, b, k / S), e1 = lerp2(a, b, (k + 1) / S);
        if (d(e0) + d(e1) < 1e-3) continue;
        quad(Y(e0), Y(e1), p3(e1, yb), p3(e0, yb), o, wallColor, m);
      }
      // Ivy trailing from some haunches
      if (hash(v, L, j + 7 * i, 89) < 0.22) {
        const g = pickFrom(LEAVES, hash(v, L, 90));
        for (let k = 0; k < 3; k++) {
          const t = 0.25 + k * 0.25;
          const e0 = lerp2(a, b, t - 0.04), e1 = lerp2(a, b, t + 0.04);
          const nudge = (pt) => [pt[0] + o[0] * 0.02, pt[1] + o[2] * 0.02];
          const y0 = yb - d(e0) + 0.02, y1 = yb - d(e1) + 0.02;
          // Keep the trailing ends clear of the sea
          const len = Math.min(0.1 + hash(v, L, 91 + k + j * 3) * 0.18, Math.min(y0, y1) - 0.12);
          if (len < 0.08) continue;
          hanging([p3(nudge(e0), y0), p3(nudge(e1), y1), p3(nudge(e1), y1 - len), p3(nudge(e0), y0 - len)], g, m);
        }
      }
    }
    if (shape.kind === 'arch' && firstQuad && hash(v, L, 88) < 0.5 && yb - 0.3 > 0.05) {
      // Lantern under the crown
      bar([C[i][0], yb, C[i][1]], [C[i][0], yb - 0.16, C[i][1]], 0.008, SLATE, m);
      box(C[i], yb - 0.27, yb - 0.16, 0.04, [1, 0], LAMP, m);
    }
    return shape;
  };
  // Height of a floating cell's underside at a point, or null when the column continues below
  const floorOf = (v, L, I) => {
    if (town.has(v, L - 1)) return null;
    const yb = I.br ? yBottom(L) - DECK : yBottom(L);
    const d = I.un && !I.un.length && !I.pk ? undersideShape(v, I.un, yb).d : null;
    return d ? (pt) => yb - d(pt) : () => yb;
  };
  // Where two floating neighbours hang to different depths (a vault next to a walkway deck, or
  // arches on crossing axes), the lower one closes the step on their shared edge
  const seams = (v, L, I, q, i, C, M, Q, occ, inf, color, m) => {
    const n = (i + 1) % 4, p = (i + 3) % 4;
    const own = floorOf(v, L, I);
    const S = 4; // the underside grid, so the wall meets both curves at their vertices
    for (const [j, a, b] of [[n, M[i], Q], [p, Q, M[p]]]) {
      if (!occ[j]) continue;
      const other = floorOf(q[j], L, inf[j]);
      if (!other) continue;
      const dir = [C[j][0] - C[i][0], 0, C[j][1] - C[i][1]];
      for (let k = 0; k < S; k++) {
        const e0 = lerp2(a, b, k / S), e1 = lerp2(a, b, (k + 1) / S);
        const y0 = own(e0), y1 = own(e1);
        const t0 = Math.max(y0, other(e0)), t1 = Math.max(y1, other(e1));
        if (t0 - y0 + t1 - y1 < 1e-3) continue;
        quad(p3(e0, y0), p3(e1, y1), p3(e1, t1), p3(e0, t0), dir, color, m);
      }
    }
  };

  return { posts, brackets, joists, tieRods, undersideShape, band, underside, floorOf, seams };
}
