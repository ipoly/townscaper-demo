// Roof pieces beyond the slopes themselves: overhanging eaves, dormers, roofs over walkways.

import { EAVE, EAVE_DROP, EAVE_RIM, WINDOW, GOLD, SLATE, LAMP, WOOD } from '../constants.js';
import { p3, lerp2 } from '../emitter.js';

// ctx: the build context (emitter tools, town, style kit, verts, units, infoOf) plus the parts made before
export function roofParts(ctx) {
  const { E, tri, quad, blob, box, prism, cone, bar, kit, redLantern } = ctx;
  const ROOFS = kit.roofs;

  // Overhanging eaves where roof quadrant i meets an outer wall: a thick wedge carrying the
  // slope out past the wall. At the edge midpoint a strip ends where the neighbouring quad's
  // strip starts; at the quad center it meets the next wall's strip on their mitred line, or
  // follows a rounded corner (arc).
  // eaved[k]: quadrant k gets eaves too, otherwise the open end of the wedge is capped.
  // Flared eaves (the kit's eaves) reach further and droop less, and where two walls of the
  // quadrant meet at an outer corner their outer edge rises towards it, by lift at the tip.
  const F = kit.eaves, EV = F ? F.out : EAVE, DROP = F ? F.drop : EAVE_DROP;
  const eaves = (i, C, M, Q, occ, eaved, arc, y, color, m) => {
    const unit = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
    const out = (p, d) => [p[0] + d[0] * EV, p[1] + d[1] * EV];
    const yo = y - DROP, yb = yo - EAVE_RIM;
    const shade = color.clone().multiplyScalar(0.55);
    // Wedge from wall top A->B out to Ao->Bo, its outer edge raised by la and lb at the two ends
    const strip = (A, B, Ao, Bo, la = 0, lb = 0) => {
      const d = unit(A, B), mid = lerp2(Ao, Bo, 0.5), base = lerp2(A, B, 0.5);
      quad(p3(A, y), p3(B, y), p3(Bo, yo + lb), p3(Ao, yo + la), [0, 1, 0], color, m);
      quad(p3(Ao, yo + la), p3(Bo, yo + lb), p3(Bo, yb + lb), p3(Ao, yb + la), [mid[0] - base[0], 0, mid[1] - base[1]], color, m);
      E.noOutline = true;
      quad(p3(A, y), p3(B, y), p3(Bo, yb + lb), p3(Ao, yb + la), [0, -1, 0], shade, m);
      E.noOutline = false;
      return d;
    };
    // A strip whose lift grows with the square of the distance from the plain end, in pieces
    const curved = (A, B, Ao, Bo, la, lb) => {
      const N = 4, lift = (t) => la * (1 - t) ** 2 + lb * t ** 2;
      let d;
      for (let k = 0; k < N; k++) {
        const t0 = k / N, t1 = (k + 1) / N;
        d = strip(lerp2(A, B, t0), lerp2(A, B, t1), lerp2(Ao, Bo, t0), lerp2(Ao, Bo, t1), lift(t0), lift(t1));
      }
      return d;
    };
    // Wall segment k (between quadrants k and k+1) offset by EAVE towards its empty side
    const line = (k) => {
      const d = unit(Q, M[k]), c = C[occ[k] ? (k + 1) % 4 : k];
      let nrm = [-d[1], d[0]];
      if ((c[0] - Q[0]) * nrm[0] + (c[1] - Q[1]) * nrm[1] < 0) nrm = [-nrm[0], -nrm[1]];
      return { p: out(Q, nrm), d, nrm };
    };
    const meet = (l1, l2) => {
      const det = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
      if (Math.abs(det) < 0.15) return null;
      const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / det;
      const x = [l1.p[0] + l1.d[0] * t, l1.p[1] + l1.d[1] * t];
      return Math.hypot(x[0] - Q[0], x[1] - Q[1]) < EV * 3 ? x : null;
    };
    const n = (i + 1) % 4, p = (i + 3) % 4;
    const mOut = (k, j) => out(M[k], unit(C[i], C[j]));
    if (arc) {
      const { pts, nrm } = arc, last = pts.length - 1;
      strip(M[i], pts[0], mOut(i, n), out(pts[0], nrm[0]));
      for (let k = 0; k < last; k++) strip(pts[k], pts[k + 1], out(pts[k], nrm[k]), out(pts[k + 1], nrm[k + 1]));
      strip(pts[last], M[p], out(pts[last], nrm[last]), mOut(p, p));
      return;
    }
    const segs = [0, 1, 2, 3].filter((k) => occ[k] !== occ[(k + 1) % 4]);
    const tip = F && segs.length === 2 && !occ[n] && !occ[p] ? F.lift : 0;
    for (const [k, j] of [[i, n], [p, p]]) {
      if (occ[j]) continue;
      const own = line(k);
      // Checkerboard corners have four walls at the center: no single partner to mitre with
      const other = segs.length === 2 ? segs.find((s) => s !== k) : null;
      const qo = (other != null && meet(own, line(other))) || own.p;
      const along = tip ? (k === i ? curved(M[k], Q, mOut(k, j), qo, 0, tip) : curved(Q, M[k], qo, mOut(k, j), tip, 0))
        : k === i ? strip(M[k], Q, mOut(k, j), qo) : strip(Q, M[k], qo, mOut(k, j));
      const partner = other == null ? -1 : occ[other] ? other : (other + 1) % 4;
      if (partner < 0 || !eaved[partner]) {
        const toQ = k === i ? along : [-along[0], -along[1]];
        tri(p3(Q, y), p3(qo, yo), p3(qo, yb), [toQ[0], 0, toQ[1]], color, m);
      }
    }
  };

  // Crowning a lone pointed roof: a gold ball on a stem, or a gourd
  const finial = (c2, y, m) => {
    box(c2, y - 0.02, y + 0.07, 0.012, [1, 0], SLATE, m);
    if (kit.finial === 'gourd') {
      blob([c2[0], y + 0.1, c2[1]], 0.045, 0.9, GOLD, m);
      blob([c2[0], y + 0.165, c2[1]], 0.03, 1, GOLD, m);
      prism(c2, 0.008, y + 0.19, y + 0.23, 4, GOLD, m);
      return;
    }
    blob([c2[0], y + 0.1, c2[1]], 0.04, 1, GOLD, m);
  };

  // Dormer on a roof slope at c2 whose roof height is y, facing dir
  const dormer = (c2, y, dir, color, m) => {
    box(c2, y - 0.12, y + 0.16, 0.09, dir, color, m);
    const f = [c2[0] + dir[0] * 0.095, c2[1] + dir[1] * 0.095];
    const side = [-dir[1] * 0.05, dir[0] * 0.05];
    quad([f[0] - side[0], y, f[1] - side[1]], [f[0] + side[0], y, f[1] + side[1]],
      [f[0] + side[0], y + 0.12, f[1] + side[1]], [f[0] - side[0], y + 0.12, f[1] - side[1]], [dir[0], 0, dir[1]], WINDOW, m);
    cone(c2, 0.15, y + 0.16, y + 0.3, 4, color.clone().multiplyScalar(0.6), m, Math.atan2(dir[1], dir[0]) + Math.PI / 4);
  };

  // Roof over a walkway: a gallery hips like a house roof along covered neighbours and leans
  // against the houses it docks onto; a lone gazebo tip gets a steep pyramid
  const canopy = (v, L, I, q, i, C, M, Q, occ, br, roofed, yd, firstQuad, m) => {
    const n = (i + 1) % 4, p = (i + 3) % 4;
    const ye = yd + 0.55, rise = I.bs === 'c' ? 0.25 : 0.5;
    const high = occ.map((o, j) => roofed[j] || (o && !br[j]));
    const h = (hi) => (hi ? ye + rise : ye);
    const roof = ROOFS[I.bc].clone().multiplyScalar(I.gz ? 1 : 0.85);
    if (F && I.gz) {
      // Pavilion: the pyramid reaches out past the posts and its corners turn up
      const reach = (pt, s, lift) => [C[i][0] + (pt[0] - C[i][0]) * s, ye + lift, C[i][1] + (pt[1] - C[i][1]) * s];
      const rim = [reach(M[i], 1.15, 0), reach(Q, 1.25, F.lift), reach(M[p], 1.15, 0)];
      quad(p3(C[i], ye + rise), ...rim, [0, 1, 0], roof, m);
      quad(p3(C[i], ye), ...rim, [0, -1, 0], WOOD.clone().multiplyScalar(0.8), m);
    } else {
      quad(p3(C[i], ye + rise), p3(M[i], h(high[n])), p3(Q, h(high.every(Boolean))), p3(M[p], h(high[p])), [0, 1, 0], roof, m);
      quad(p3(C[i], ye), p3(M[i], ye), p3(Q, ye), p3(M[p], ye), [0, -1, 0], WOOD.clone().multiplyScalar(0.8), m);
    }
    if (!occ[n] || !occ[p]) {
      const post = lerp2(Q, C[i], 0.12);
      box(post, yd, ye, 0.03, [1, 0], WOOD, m);
    }
    if (I.gz && firstQuad) {
      // Lantern hanging in the middle of the gazebo
      if (kit.lanterns === 'red') redLantern([C[i][0], ye, C[i][1]], 0.05, m);
      else {
        bar([C[i][0], ye, C[i][1]], [C[i][0], ye - 0.14, C[i][1]], 0.008, SLATE, m);
        box(C[i], ye - 0.24, ye - 0.14, 0.04, [1, 0], LAMP, m);
      }
      if (F) finial(C[i], ye + rise, m);
      else prism(C[i], 0.02, ye + rise, ye + rise + 0.14, 4, GOLD, m);
    }
  };

  return { eaves, finial, dormer, canopy };
}
