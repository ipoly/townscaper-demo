// Roof pieces beyond the slopes themselves: overhanging eaves, dormers, roofs over walkways.

import { EAVE, EAVE_DROP, EAVE_RIM, RIDGE_R, WINDOW, GOLD, SLATE, LAMP, WOOD } from '../constants.js';
import { p3, lerp2 } from '../emitter.js';

// ctx: the build context (emitter tools, town, style kit, verts, units, infoOf) plus the parts made before
export function roofParts(ctx) {
  const { E, tri, quad, blob, box, prism, cone, bar, ridgeCap, kit, redLantern } = ctx;
  const ROOFS = kit.roofs;

  // Overhanging eaves where roof quadrant i meets an outer wall: a thick wedge carrying the
  // slope out past the wall. At the edge midpoint a strip ends where the neighbouring quad's
  // strip starts; at the quad center it meets the next wall's strip on their mitred line, or
  // follows a rounded corner (arc).
  // eaved[k]: quadrant k gets eaves too, otherwise the open end of the wedge is capped.
  // Flared eaves (the kit's eaves) reach further and droop less, and where two walls of the
  // quadrant meet at an outer corner their outer edge rises towards it, by lift at the tip.
  // shape: { out, drop } in place of the kit's reach and droop.
  const F = kit.eaves, EV = F ? F.out : EAVE, DROP = F ? F.drop : EAVE_DROP;
  const eaves = (i, C, M, Q, occ, eaved, arc, y, color, m, shape) => {
    const ev = shape ? shape.out : EV, drop = shape ? shape.drop : DROP;
    const unit = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
    const out = (p, d) => [p[0] + d[0] * ev, p[1] + d[1] * ev];
    const yo = y - drop, yb = yo - EAVE_RIM;
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
      return Math.hypot(x[0] - Q[0], x[1] - Q[1]) < ev * 3 ? x : null;
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

  // Pagoda floors: a steep skirt roof round the tower just above each floor, its corners turned
  // up with a ridge cap and a red lantern hanging from the tip
  const SKIRT = { out: 0.2, drop: 0.16 };
  const pagodaSkirt = (i, C, M, Q, occ, yt, m) => {
    const y = yt + 0.1, color = kit.tower.roof, p = (i + 3) % 4;
    eaves(i, C, M, Q, occ, occ, null, y, color, m, SKIRT);
    const dl = Math.hypot(Q[0] - C[i][0], Q[1] - C[i][1]) || 1, d = [(Q[0] - C[i][0]) / dl, (Q[1] - C[i][1]) / dl];
    const wl = Math.hypot(M[p][0] - Q[0], M[p][1] - Q[1]) || 1, wn = [(M[p][1] - Q[1]) / wl, -(M[p][0] - Q[0]) / wl];
    const t = Math.min(SKIRT.out * 1.6, SKIRT.out / Math.max(Math.abs(d[0] * wn[0] + d[1] * wn[1]), 0.3));
    const yTip = y - SKIRT.drop + (F ? F.lift : 0), at = (s) => [Q[0] + d[0] * s, Q[1] + d[1] * s];
    ridgeCap([p3(Q, y), p3(at(t), yTip), p3(at(t + 0.05), yTip + 0.07)], RIDGE_R, color.clone().multiplyScalar(1.06), m, true);
    const hook = at(t - 0.02);
    if (kit.lanterns === 'red') redLantern([hook[0], yTip, hook[1]], 0.035, m);
  };

  // Pagoda top: stacked gold rings on a mast, crowned by the finial
  const pagodaSpire = (c2, y, m) => {
    prism(c2, 0.07, y - 0.04, y + 0.04, 8, GOLD, m);
    prism(c2, 0.012, y + 0.04, y + 0.4, 4, GOLD, m);
    for (let k = 0; k < 5; k++) prism(c2, 0.055 - k * 0.007, y + 0.09 + k * 0.055, y + 0.11 + k * 0.055, 8, GOLD, m);
    finial(c2, y + 0.4, m);
  };

  // Horse-head wall between two row houses: a whitewashed wall standing up through the roof along
  // their shared wall, from the ridge at M out past the eave beyond Q, in steps that follow the
  // slope down, each under a dark tile cap whose outer end sweeps up like a horse's head. The houses on either side
  // of M each build their half. peak and low: roof heights at M and Q
  const FIRE_STEPS = 3, FIRE_ABOVE = 0.14, FIRE_HALF = 0.035;
  const firewall = (Mi, Q, peak, low, m) => {
    const { wall, cap } = kit.firewalls;
    const len = Math.hypot(Q[0] - Mi[0], Q[1] - Mi[1]) || 1, d = [(Q[0] - Mi[0]) / len, (Q[1] - Mi[1]) / len];
    const nrm = [-d[1], d[0]], total = len + EV;
    const roofAt = (s) => (s <= len ? peak + ((low - peak) * s) / len : low - (DROP * (s - len)) / EV);
    // Block along the wall from s0 to s1, half as thick as half, between heights y0 and y1
    const block = (s0, s1, half, y0, y1, color) => {
      const P = (s, w) => [Mi[0] + d[0] * s + nrm[0] * w, Mi[1] + d[1] * s + nrm[1] * w];
      const a0 = P(s0, -half), a1 = P(s1, -half), b0 = P(s0, half), b1 = P(s1, half);
      quad(p3(a0, y0), p3(a1, y0), p3(a1, y1), p3(a0, y1), [-nrm[0], 0, -nrm[1]], color, m);
      quad(p3(b0, y0), p3(b1, y0), p3(b1, y1), p3(b0, y1), [nrm[0], 0, nrm[1]], color, m);
      quad(p3(a0, y1), p3(a1, y1), p3(b1, y1), p3(b0, y1), [0, 1, 0], color, m);
      quad(p3(a1, y0), p3(b1, y0), p3(b1, y1), p3(a1, y1), [d[0], 0, d[1]], color, m);
    };
    // The head: the cap's end tilted up, from s back along the wall to s + 0.04 out past it
    const head = (s, y) => {
      const w = FIRE_HALF + 0.025, P = (t, k) => [Mi[0] + d[0] * t + nrm[0] * k, Mi[1] + d[1] * t + nrm[1] * k];
      const a0 = p3(P(s - 0.09, -w), y), b0 = p3(P(s - 0.09, w), y);
      const a1 = p3(P(s + 0.04, -w), y + 0.06), b1 = p3(P(s + 0.04, w), y + 0.06);
      const a2 = p3(P(s + 0.04, -w), y), b2 = p3(P(s + 0.04, w), y);
      quad(a0, a1, b1, b0, [0, 1, 0], cap, m);
      quad(a2, b2, b1, a1, [d[0], 0, d[1]], cap, m);
      tri(a0, a2, a1, [-nrm[0], 0, -nrm[1]], cap, m);
      tri(b0, b2, b1, [nrm[0], 0, nrm[1]], cap, m);
    };
    const yb = low - DROP - 0.08;
    for (let k = 0; k < FIRE_STEPS; k++) {
      const s0 = (total * k) / FIRE_STEPS, s1 = (total * (k + 1)) / FIRE_STEPS;
      const top = roofAt(s0) + FIRE_ABOVE;
      block(s0, s1, FIRE_HALF, yb, top, wall);
      block(s0, s1 - 0.09, FIRE_HALF + 0.025, top, top + 0.03, cap);
      head(s1, top);
    }
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

  return { eaves, finial, pagodaSkirt, pagodaSpire, firewall, dormer, canopy };
}
