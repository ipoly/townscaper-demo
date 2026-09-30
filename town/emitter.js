// Low-level drawing into a quad's record: triangles and simple solids with per-vertex color,
// pivot, birth time, glow and sway, plus the outline flag. Knows nothing about what it draws.

import { WINDOW, CURTAINS, LAMP, LAMP_ORDER, ICO } from './constants.js';

export const p3 = (p, y) => [p[0], y, p[1]];
export const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const ring = (c2, r, sides, yaw = 0) =>
  Array.from({ length: sides }, (_, s) => {
    const ang = yaw + (s / sides) * Math.PI * 2;
    return [c2[0] + Math.cos(ang) * r, c2[1] + Math.sin(ang) * r];
  });

export const offset = (c2, ang, r) => [c2[0] + Math.cos(ang) * r, c2[1] + Math.sin(ang) * r];

export class Emitter {
  // pivotOf(m) and cellOf(m) give the pop pivot and cell info ({ b, lit }) for a triangle's meta
  constructor(pivotOf, cellOf) {
    this.pivotOf = pivotOf;
    this.cellOf = cellOf;
    this.R = null;
    this.noOutline = false;
    this.waveFn = null; // per-vertex sway weight for hanging cloth
    this.shadeFn = null; // per-vertex color multiplier, for baked occlusion
  }

  // Start a fresh record for the next quad
  begin() {
    this.R = { position: [], normal: [], color: [], aPivot: [], aBorn: [], aGlow: [], aWave: [], normals: [], edgeless: [], meta: [], fx: { smoke: [], lamps: [], boats: [], halos: [], glows: [], flies: [] } };
    return this.R;
  }

  tri = (a, b, c, hint, color, m) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0;
    if (flip) [b, c] = [c, b];
    const len = (Math.hypot(nx, ny, nz) || 1) * (flip ? -1 : 1);
    const n = [nx / len, ny / len, nz / len];
    const pv = this.pivotOf(m);
    const cell = this.cellOf(m);
    const glow = color === LAMP ? LAMP_ORDER : color === WINDOW || CURTAINS.includes(color) ? cell.lit : 0;
    for (const p of [a, b, c]) {
      this.R.position.push(p[0], p[1], p[2]);
      this.R.normal.push(n[0], n[1], n[2]);
      const k = this.shadeFn ? this.shadeFn(p) : 1;
      this.R.color.push(color.r * k, color.g * k, color.b * k);
      this.R.aPivot.push(pv[0], pv[1], pv[2]);
      this.R.aBorn.push(cell.b);
      this.R.aGlow.push(glow);
      this.R.aWave.push(this.waveFn ? this.waveFn(p) : 0);
    }
    this.R.normals.push(n);
    this.R.edgeless.push(this.noOutline);
    this.R.meta.push(m);
  };
  quad = (a, b, c, d, hint, color, m) => {
    this.tri(a, b, c, hint, color, m);
    this.tri(a, c, d, hint, color, m);
  };

  // Low-poly blob (tree canopy, bush)
  blob = (c, r, sy, color, m) => {
    for (let i = 0; i < ICO.length; i += 9) {
      const pt = (j) => [c[0] + ICO[i + j] * r, c[1] + ICO[i + j + 1] * r * sy, c[2] + ICO[i + j + 2] * r];
      const a = pt(0), b = pt(3), d = pt(6);
      const hint = [(a[0] + b[0] + d[0]) / 3 - c[0], (a[1] + b[1] + d[1]) / 3 - c[1], (a[2] + b[2] + d[2]) / 3 - c[2]];
      this.tri(a, b, d, hint, color, m);
    }
  };

  // Box aligned to a horizontal direction dir (unit, 2D)
  box = (c2, y0, y1, half, dir, color, m) => {
    // Lamps get a round halo at night
    if (color === LAMP) this.R.fx.glows.push({ x: c2[0], y: (y0 + y1) / 2, z: c2[1], born: this.cellOf(m).b });
    const [dx, dz] = dir;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => [
      c2[0] + (dx * s - dz * t) * half,
      c2[1] + (dz * s + dx * t) * half,
    ]);
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      const out = [(a[0] + b[0]) / 2 - c2[0], 0, (a[1] + b[1]) / 2 - c2[1]];
      this.quad(p3(a, y0), p3(b, y0), p3(b, y1), p3(a, y1), out, color, m);
    }
    this.quad(...corners.map((p) => p3(p, y1)), [0, 1, 0], color, m);
  };

  prism = (c2, r, y0, y1, sides, color, m, topColor = color) => {
    const pts = ring(c2, r, sides);
    for (let s = 0; s < sides; s++) {
      const a = pts[s], b = pts[(s + 1) % sides];
      this.quad(p3(a, y0), p3(b, y0), p3(b, y1), p3(a, y1), [(a[0] + b[0]) / 2 - c2[0], 0, (a[1] + b[1]) / 2 - c2[1]], color, m);
      this.tri(p3(c2, y1), p3(a, y1), p3(b, y1), [0, 1, 0], topColor, m);
    }
  };
  cone = (c2, r, y0, apex, sides, color, m, yaw = 0) => {
    const pts = ring(c2, r, sides, yaw);
    for (let s = 0; s < sides; s++) {
      const a = pts[s], b = pts[(s + 1) % sides];
      this.tri(p3(a, y0), p3(b, y0), p3(c2, apex), [(a[0] + b[0]) / 2 - c2[0], r, (a[1] + b[1]) / 2 - c2[1]], color, m);
    }
  };

  // Square bar between two 3D points (beams, braces, strings)
  bar = (a, b, h, color, m) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    const dn = [d[0] / dl, d[1] / dl, d[2] / dl];
    let u = [-dn[2], 0, dn[0]];
    const ul = Math.hypot(u[0], u[2]);
    u = ul < 1e-4 ? [1, 0, 0] : [u[0] / ul, 0, u[2] / ul];
    const w = [u[1] * dn[2] - u[2] * dn[1], u[2] * dn[0] - u[0] * dn[2], u[0] * dn[1] - u[1] * dn[0]];
    const o = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([s1, s2]) => [0, 1, 2].map((k) => (u[k] * s1 + w[k] * s2) * h));
    for (let k = 0; k < 4; k++) {
      const o0 = o[k], o1 = o[(k + 1) % 4];
      const add = (pt, off) => [pt[0] + off[0], pt[1] + off[1], pt[2] + off[2]];
      this.quad(add(a, o0), add(b, o0), add(b, o1), add(a, o1), [o0[0] + o1[0], o0[1] + o1[1], o0[2] + o1[2]], color, m);
    }
  };
  // Half-round cap along a roof crease through the 3D points pts, half sunk into the roof;
  // the last end is closed when capEnd is set
  ridgeCap = (pts, r, color, m, capEnd) => {
    this.noOutline = true;
    const norm = (d) => {
      const l = Math.hypot(...d) || 1;
      return [d[0] / l, d[1] / l, d[2] / l];
    };
    const dirs = [];
    for (let s = 0; s + 1 < pts.length; s++) dirs.push(norm([0, 1, 2].map((j) => pts[s + 1][j] - pts[s][j])));
    // One profile per point; interior points use the averaged direction and are stretched
    // along the bend so both segments meet on the mitre plane without a kink.
    const profs = pts.map((pt, s) => {
      const din = dirs[Math.max(0, s - 1)], dout = dirs[Math.min(dirs.length - 1, s)];
      const dn = norm([0, 1, 2].map((j) => din[j] + dout[j]));
      const hl = Math.hypot(dn[0], dn[2]) || 1, u = [-dn[2] / hl, 0, dn[0] / hl];
      let w = [u[1] * dn[2] - u[2] * dn[1], u[2] * dn[0] - u[0] * dn[2], u[0] * dn[1] - u[1] * dn[0]];
      if (w[1] < 0) w = w.map((x) => -x);
      const bd = [0, 1, 2].map((j) => dout[j] - din[j]), bl = Math.hypot(...bd);
      const b = bl > 1e-6 ? bd.map((x) => x / bl) : null;
      const c = Math.max(0.5, din[0] * dn[0] + din[1] * dn[1] + din[2] * dn[2]);
      return [0, 1, 2, 3, 4].map((k) => {
        const cs = Math.cos((k / 4) * Math.PI) * r, sn = (Math.sin((k / 4) * Math.PI) - 0.3) * r;
        let o = [0, 1, 2].map((j) => u[j] * cs + w[j] * sn);
        if (b) {
          const ob = (o[0] * b[0] + o[1] * b[1] + o[2] * b[2]) * (1 / c - 1);
          o = o.map((x, j) => x + b[j] * ob);
        }
        return { p: [pt[0] + o[0], pt[1] + o[1], pt[2] + o[2]], o };
      });
    });
    for (let s = 0; s + 1 < pts.length; s++) {
      const A = profs[s], B = profs[s + 1];
      for (let k = 0; k < 4; k++) {
        const hint = [0, 1, 2].map((j) => A[k].o[j] + A[k + 1].o[j]);
        this.quad(A[k].p, B[k].p, B[k + 1].p, A[k + 1].p, hint, color, m);
      }
    }
    const last = profs[profs.length - 1];
    if (capEnd) for (let k = 1; k < 4; k++) this.tri(last[0].p, last[k].p, last[k + 1].p, dirs[dirs.length - 1], color, m);
    this.noOutline = false;
  };
  // Sagging string from a to b (3D); returns the point at t along it
  sagString = (a, b, sag, color, m) => {
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
    for (let k = 0; k < 4; k++) this.bar(at(k / 4), at((k + 1) / 4), 0.006, color, m);
    return at;
  };
  // Flat piece of cloth hanging from a string, visible from both sides and swaying
  hanging = (pts, color, m) => {
    const y = Math.max(...pts.map((pt) => pt[1]));
    this.noOutline = true;
    this.waveFn = (pt) => (y - pt[1]) * 3;
    const d = [pts[1][0] - pts[0][0], pts[1][2] - pts[0][2]];
    for (const sd of [1, -1]) {
      const hint = [-d[1] * sd, 0, d[0] * sd];
      if (pts.length === 4) this.quad(...pts, hint, color, m);
      else this.tri(...pts, hint, color, m);
    }
    this.waveFn = null;
    this.noOutline = false;
  };
}
