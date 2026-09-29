// Irregular quad grid, Townscaper style:
// hex lattice -> triangles -> random pair merge -> subdivide into quads -> relax

export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

// Rotations in the (x, z) plane; "positive" follows ascending atan2(z, x)
const rotPos = ([x, z]) => [-z, x];
const rotNeg = ([x, z]) => [z, -x];

function sortCCW(poly, verts) {
  let cx = 0, cz = 0;
  for (const v of poly) { cx += verts[v][0]; cz += verts[v][1]; }
  cx /= poly.length; cz /= poly.length;
  return poly
    .map((v) => ({ v, a: Math.atan2(verts[v][1] - cz, verts[v][0] - cx) }))
    .sort((p, q) => p.a - q.a)
    .map((p) => p.v);
}

export function generateGrid({ radius = 5, seed = 1, relaxIterations = 80, scale = 2 } = {}) {
  const rand = mulberry32(seed);
  const S3 = Math.sqrt(3) / 2;

  // 1. Hex-shaped triangular lattice
  const verts = [];
  const latticeIndex = new Map();
  const lk = (q, r) => `${q},${r}`;
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (Math.abs(q + r) > radius) continue;
      latticeIndex.set(lk(q, r), verts.length);
      verts.push([(q + r / 2) * scale, r * S3 * scale]);
    }
  }

  // 2. Triangles (up and down)
  const tris = [];
  const at = (q, r) => latticeIndex.get(lk(q, r));
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      const a = at(q, r), b = at(q + 1, r), c = at(q, r + 1), d = at(q + 1, r + 1);
      if (a !== undefined && b !== undefined && c !== undefined) tris.push([a, b, c]);
      if (b !== undefined && d !== undefined && c !== undefined) tris.push([b, d, c]);
    }
  }

  // 3. Randomly merge adjacent triangle pairs into quads
  const edgeTris = new Map();
  tris.forEach((t, ti) => {
    for (let i = 0; i < 3; i++) {
      const k = edgeKey(t[i], t[(i + 1) % 3]);
      if (!edgeTris.has(k)) edgeTris.set(k, []);
      edgeTris.get(k).push(ti);
    }
  });
  const order = tris.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const merged = new Array(tris.length).fill(false);
  const polys = [];
  for (const ti of order) {
    if (merged[ti]) continue;
    const t = tris[ti];
    const candidates = [];
    for (let i = 0; i < 3; i++) {
      for (const other of edgeTris.get(edgeKey(t[i], t[(i + 1) % 3]))) {
        if (other !== ti && !merged[other]) candidates.push(other);
      }
    }
    if (candidates.length === 0) continue;
    const other = candidates[Math.floor(rand() * candidates.length)];
    merged[ti] = merged[other] = true;
    polys.push([...new Set([...t, ...tris[other]])]);
  }
  tris.forEach((t, ti) => { if (!merged[ti]) polys.push(t); });

  // 4. Subdivide every polygon (tri or quad) into quads
  const midCache = new Map();
  const mid = (a, b) => {
    const k = edgeKey(a, b);
    if (!midCache.has(k)) {
      midCache.set(k, verts.length);
      verts.push([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2]);
    }
    return midCache.get(k);
  };
  const quads = [];
  for (const raw of polys) {
    const poly = sortCCW(raw, verts);
    const n = poly.length;
    let cx = 0, cz = 0;
    for (const v of poly) { cx += verts[v][0]; cz += verts[v][1]; }
    const c = verts.length;
    verts.push([cx / n, cz / n]);
    for (let i = 0; i < n; i++) {
      const prev = poly[(i - 1 + n) % n], cur = poly[i], next = poly[(i + 1) % n];
      quads.push([cur, mid(cur, next), c, mid(prev, cur)]);
    }
  }

  // Boundary vertices stay fixed during relaxation
  const edgeCount = new Map();
  for (const q of quads) {
    for (let i = 0; i < 4; i++) {
      const k = edgeKey(q[i], q[(i + 1) % 4]);
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    }
  }
  const fixed = new Array(verts.length).fill(false);
  for (const q of quads) {
    for (let i = 0; i < 4; i++) {
      if (edgeCount.get(edgeKey(q[i], q[(i + 1) % 4])) === 1) fixed[q[i]] = fixed[q[(i + 1) % 4]] = true;
    }
  }

  // 5. Relaxation: pull each quad toward its best-fit square
  const valence = new Array(verts.length).fill(0);
  for (const q of quads) for (const v of q) valence[v]++;
  for (let it = 0; it < relaxIterations; it++) {
    const force = verts.map(() => [0, 0]);
    for (const q of quads) {
      let cx = 0, cz = 0;
      for (const v of q) { cx += verts[v][0]; cz += verts[v][1]; }
      cx /= 4; cz /= 4;
      // Rotate each corner back into corner-0's frame and average
      let ax = 0, az = 0;
      for (let i = 0; i < 4; i++) {
        let d = [verts[q[i]][0] - cx, verts[q[i]][1] - cz];
        for (let k = 0; k < i; k++) d = rotNeg(d);
        ax += d[0]; az += d[1];
      }
      let t = [ax / 4, az / 4];
      for (let i = 0; i < 4; i++) {
        force[q[i]][0] += cx + t[0] - verts[q[i]][0];
        force[q[i]][1] += cz + t[1] - verts[q[i]][1];
        t = rotPos(t);
      }
    }
    for (let v = 0; v < verts.length; v++) {
      if (fixed[v]) continue;
      verts[v][0] += (force[v][0] / valence[v]) * 0.5;
      verts[v][1] += (force[v][1] / valence[v]) * 0.5;
    }
  }

  // Vertex -> adjacent vertices (for seeding clusters)
  const neighbors = verts.map(() => new Set());
  for (const q of quads) {
    for (let i = 0; i < 4; i++) {
      neighbors[q[i]].add(q[(i + 1) % 4]);
      neighbors[q[(i + 1) % 4]].add(q[i]);
    }
  }

  return { verts, quads, fixed, neighbors: neighbors.map((s) => [...s]) };
}
