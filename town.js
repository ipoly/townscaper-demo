// Voxel town on the irregular grid.
// Voxels live on grid vertices; geometry is emitted per (quad, level) by looking at
// the 4 corner voxels, like marching squares on the dual grid. Each quad is split into
// 4 quadrants (corner, edge mid, center, edge mid), one per corner voxel.
// Decorations (windows, doors, chimneys, trees...) are picked with a deterministic hash
// so rebuilding the mesh never reshuffles them.
// Geometry is cached per quad and keyed by a signature of everything that feeds it, so
// an edit only re-emits the quads whose inputs actually changed.

import * as THREE from 'three';

export const MAX_LEVEL = 10;
const BASE_BOTTOM = -0.4;
const BASE_TOP = 0.3;
const LEVEL_H = 0.75;
const ROOF_RISE = 0.6;
const EAVE = 0.09; // how far roofs overhang the walls
const EAVE_DROP = 0.07;
const EAVE_RIM = 0.04;
const RIDGE_R = 0.03; // radius of the rounded caps along roof ridges and hips
const CORNER = 0.12; // how far a rounded outer corner reaches along each wall
const AO_BAND = 0.2; // height of the darker band at a wall's foot or under its eaves
const AO_FOOT = 0.8;
const AO_EAVES = 0.84;
const SPIRE_RISE = 1.3;
const ARCH_RISE = 0.4;
const DECK = 0.24;
const POND_Y = 0.12;

export const PALETTE = ['#f6f3ec', '#fbe6b3', '#f2c85b', '#fcc28d', '#ff9592', '#ffd9e2', '#b0dfa3', '#83e4d5', '#cce9ff'];
export const ROOF_OF = ['#c95a37', '#158374', '#474e55', '#af3d36', '#874465', '#624377', '#b17300', '#335189', '#4978a7'];
const WALLS = PALETTE.map((c) => new THREE.Color(c));
const ROOFS = ROOF_OF.map((c) => new THREE.Color(c));
const STONE = new THREE.Color('#b8a58a');
const PLAZA = new THREE.Color('#dccfb4');
const GRASS = new THREE.Color('#9cc27a');
const ROOF_FLAT = new THREE.Color('#a39a92');
const GARDEN = new THREE.Color('#86b36a');
const WINDOW = new THREE.Color('#3b4a5a');
const CURTAINS = ['#f4eee2', '#f6d9d2', '#e3eef0'].map((c) => new THREE.Color(c));
const IVY = ['#4f8a45', '#5f9a4c', '#467d3e'].map((c) => new THREE.Color(c));
const WHITE = new THREE.Color('#f7f4ee');
const BRICK = new THREE.Color('#8a5a4a');
const TRUNK = new THREE.Color('#7a5a40');
const FOAM = new THREE.Color('#d9eff4');
const WATER = new THREE.Color('#7cc4dc');
const COPPER = new THREE.Color('#6fae9a');
const GOLD = new THREE.Color('#e0b84a');
const SLATE = new THREE.Color('#4e5f78');
const LH_RED = new THREE.Color('#c9473a');
const LAMP = new THREE.Color('#fff3b8');
const LAMP_ORDER = 0.08; // street lamps come on before any window
const WOOD = new THREE.Color('#7d5f43');
const PLANKS = ['#b8925f', '#a98556'].map((c) => new THREE.Color(c));
const DECK_TOP = new THREE.Color('#d8cbb0');
const SHADOW = new THREE.Color('#4a423c');
const POND = { lily: '#5c9f86', lagoon: '#62aecb', basin: '#74c0d6', well: '#2f4d5c' };
const POND_COLORS = Object.fromEntries(Object.entries(POND).map(([k, c]) => [k, new THREE.Color(c)]));
const BANK = new THREE.Color('#7f8f5a');
const REED = new THREE.Color('#6b8f4a');
const LILY = new THREE.Color('#5f9a48');
const BLOSSOM = new THREE.Color('#f2a7c3');
const TERRACE = new THREE.Color('#d8b48f');
const TERRACOTTA = new THREE.Color('#b8643f');
const UMBRELLAS = ['#e2574c', '#3f7fb5', '#f2c14e', '#f7f4ee'].map((c) => new THREE.Color(c));
const BLOOMS = ['#e2574c', '#f2a7c3', '#f2c14e', '#7fb865'].map((c) => new THREE.Color(c));
const LEAVES = ['#6fa35a', '#7fb865', '#5d9150', '#9bc46e'].map((c) => new THREE.Color(c));
const SHUTTERS = ['#4f7f6a', '#4a6a8f', '#a8553f', '#e8e2d6'].map((c) => new THREE.Color(c));
const DOORS = ['#6b4632', '#3f5e7a', '#7a3b3b', '#48664a'].map((c) => new THREE.Color(c));

const ICO = new THREE.IcosahedronGeometry(1, 0).toNonIndexed().attributes.position.array;

const yBottom = (L) => (L === 0 ? BASE_BOTTOM : BASE_TOP + (L - 1) * LEVEL_H);
const yTop = (L) => BASE_TOP + L * LEVEL_H;
// Height used for drag-building on a level: water surface for foundations, mid-floor otherwise
export const levelPlaneY = (L) => (L === 0 ? 0 : (yBottom(L) + yTop(L)) / 2);

function hash(...nums) {
  let h = 2166136261;
  for (const n of nums) {
    h = Math.imul(h ^ (n | 0), 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}
const pickFrom = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];

// Outline pairing: an edge shared by two triangles is drawn only at a crease, and belongs
// to the triangle that was born later so it pops in with that block
function pairEdges(halfEdges, cosT, out) {
  const groups = new Map();
  for (const h of halfEdges) {
    const g = groups.get(h.key);
    if (g) g.push(h); else groups.set(h.key, [h]);
  }
  for (const g of groups.values()) {
    if (g.length === 2) {
      const [a, b] = g;
      if (a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2] > cosT) continue;
    }
    out.push(g.reduce((p, c) => (c.born > p.born ? c : p)));
  }
}

function linesGeometry(lineLists) {
  let n = 0;
  for (const l of lineLists) n += l.length;
  const pos = new Float32Array(n * 6), piv = new Float32Array(n * 6), born = new Float32Array(n * 2);
  let i = 0;
  for (const list of lineLists) {
    for (const h of list) {
      pos.set(h.pos, i * 6);
      piv.set(h.piv, i * 6);
      born[i * 2] = born[i * 2 + 1] = h.born;
      i++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aPivot', new THREE.BufferAttribute(piv, 3));
  g.setAttribute('aBorn', new THREE.BufferAttribute(born, 1));
  return g;
}

const COS_CREASE = Math.cos((25 * Math.PI) / 180);
const ATTRS = [['position', 3], ['normal', 3], ['color', 3], ['aPivot', 3], ['aBorn', 1], ['aGlow', 1], ['aWave', 1]];

export class Town {
  constructor(grid) {
    this.grid = grid;
    this.cells = new Set();
    this.born = new Map(); // cell key -> time (s) the pop animation starts
    this.colorIndex = new Map(); // cell key -> PALETTE index
    this.autoColor = new Set(); // cells whose color was not picked by the player
    this.vertexQuads = grid.verts.map(() => []);
    for (const q of grid.quads) for (const v of q) this.vertexQuads[v].push(q);
    this.cache = new Map(); // quad -> record
    this.edgeCache = new Map(); // shared quad edge -> merged outline
    // Shared quad edges, for merging outline half-edges across neighbouring quads
    const byEdge = new Map();
    grid.quads.forEach((q, qi) => {
      for (let e = 0; e < 4; e++) {
        const a = q[e], b = q[(e + 1) % 4];
        const k = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (!byEdge.has(k)) byEdge.set(k, []);
        byEdge.get(k).push([q, e]);
      }
    });
    this.quadEdges = [...byEdge.entries()].map(([id, sides]) => ({ id, sides }));
    this.records = [];
    this.vertexCache = new Map(); // grid vertex -> merged outline of edges standing on it
    this.chunks = null; // laid out on the first buildChunks()
  }

  key(v, L) { return v * 64 + L; }
  has(v, L) { return L >= 0 && this.cells.has(this.key(v, L)); }
  topSame(v, L) { return this.has(v, L) && !this.has(v, L + 1); }
  // Mooring for a dock's boat: the first spot off the dock whose whole hull, with a little
  // clearance, lies over open sea. Each stretch of water gets at most one boat, moored by the
  // lowest-numbered dock around it. Returns [x, z, yaw] or null.
  boatSpot(v, units) {
    const { verts, neighbors } = this.grid;
    const wantsBoat = (u) => units.ground.get(u)?.type === 'dock' && hash(u, 51) < 0.4;
    const water = units.water(v).filter((w) => !neighbors[w].some((u) => u < v && this.has(u, 0) && wantsBoat(u)));
    if (!water.length) return null;
    const start = Math.floor(hash(v, 52) * water.length);
    const [cx, cz] = verts[v];
    for (let k = 0; k < water.length; k++) {
      const w = water[(start + k) % water.length];
      const near = new Set([w, ...neighbors[w]]);
      for (const u of neighbors[w]) for (const x of neighbors[u]) near.add(x);
      // A point is over open sea when its nearest grid vertex is not a pond and has nothing
      // built low enough for the hull or the mast to hit
      const open = (x, z) => {
        let best = -1, bestD = Infinity;
        for (const u of near) {
          const d = Math.hypot(verts[u][0] - x, verts[u][1] - z);
          if (d < bestD) { bestD = d; best = u; }
        }
        return !this.has(best, 0) && !this.has(best, 1) && !units.ponds.has(best);
      };
      const out = Math.atan2(verts[w][1] - cz, verts[w][0] - cx);
      for (const t of [0.7, 0.8, 0.9, 1]) {
        const px = cx + (verts[w][0] - cx) * t, pz = cz + (verts[w][1] - cz) * t;
        // Alongside the dock first, then bow out to sea
        for (const yaw of [out + Math.PI / 2, out]) {
          const ax = Math.cos(yaw), az = Math.sin(yaw);
          let fits = true;
          for (const lx of [-0.48, -0.24, 0, 0.24, 0.52]) {
            for (const lz of [-0.26, 0, 0.26]) {
              if (!open(px + lx * ax - lz * az, pz + lx * az + lz * ax)) { fits = false; break; }
            }
            if (!fits) break;
          }
          if (fits) return [+px.toFixed(3), +pz.toFixed(3), +yaw.toFixed(3)];
        }
      }
    }
    return null;
  }

  canBuild(v, L) { return !this.grid.fixed[v] && L >= 0 && L < MAX_LEVEL; }

  // color: PALETTE index, or null to inherit from the block below / pick by hash
  add(v, L, born = -100, color = null) {
    if (!this.canBuild(v, L) || this.has(v, L)) return false;
    const k = this.key(v, L);
    if (color === null) {
      this.autoColor.add(k);
      const below = this.colorIndex.get(this.key(v, L - 1));
      color = L > 1 && below !== undefined ? below : Math.floor(hash(v, 99) * PALETTE.length);
    }
    this.cells.add(k);
    this.born.set(k, born);
    this.colorIndex.set(k, color);
    return true;
  }

  remove(v, L) {
    const k = this.key(v, L);
    this.born.delete(k);
    this.colorIndex.delete(k);
    this.autoColor.delete(k);
    return this.cells.delete(k);
  }

  clear() { this.cells.clear(); this.born.clear(); this.colorIndex.clear(); this.autoColor.clear(); }

  // Everything needed to put a cell back exactly (undo, saved links)
  cellData(v, L) {
    const k = this.key(v, L);
    return { v, L, color: this.colorIndex.get(k), auto: this.autoColor.has(k) };
  }

  restore({ v, L, color, auto }, born = -100) {
    if (!this.canBuild(v, L) || this.has(v, L)) return false;
    const k = this.key(v, L);
    this.cells.add(k);
    this.born.set(k, born);
    this.colorIndex.set(k, color);
    if (auto) this.autoColor.add(k);
    return true;
  }

  // Geometry of one isolated block, used for hover preview and removal animation
  singleBlockGeometry(v, L, color = null) {
    const t = new Town(this.grid);
    t.add(v, L, -100, color ?? this.colorIndex.get(this.key(v, L)) ?? null);
    return t.buildGeometry(this.vertexQuads[v], false);
  }

  pivot(v, L) { return [this.grid.verts[v][0], yBottom(L), this.grid.verts[v][1]]; }

  // Tall lone towers get a spire; heights at shared points stay consistent because a
  // lone top never shares a ridge with a neighbour
  roofRise(v, L, units) {
    if (L === 0 || units.bridge.has(this.key(v, L)) || units.terrace.has(this.key(v, L))) return 0;
    if (this.coverGap(v, L, units)) return 0;
    if (units.lighthouse.get(v) === L) return 0;
    if (L >= 3 && hash(v, L, 5) < 0.45 && this.grid.neighbors[v].every((u) => !this.has(u, L))) return SPIRE_RISE;
    return ROOF_RISE;
  }

  // Empty levels between a top cell and a block standing on posts above it in the same
  // column; 0 when there is none. The lower cell becomes a covered porch the posts stand on.
  coverGap(v, L, units) {
    if (this.has(v, L + 1)) return 0;
    for (let l = L + 2; l < MAX_LEVEL; l++) {
      if (this.has(v, l)) return units.support.has(this.key(v, l)) ? l - L - 1 : 0;
    }
    return 0;
  }

  // Cell of a roof unit that carries its landmark: the center unless something hovers over it
  landmarkHost(unit, units) {
    if (!('host' in unit)) unit.host = [unit.center, ...unit.cells].find((c) => !this.coverGap(c, unit.L, units));
    return unit.host;
  }

  // Exterior double staircase from a plaza up to a first-floor door
  hasStair(v, target) {
    return this.has(v, 1) && this.has(v, 2) && !this.has(target, 1) && this.has(target, 0) && hash(v, target, 7) < 0.3;
  }

  // Group connected cells into larger units that get their own look:
  // - ground units: connected foundation-only cells -> park / square / courtyard / dock
  // - roof units: connected top cells on the same level -> one building with a shared
  //   roof color, and a landmark (cupola / clock tower) when big enough
  analyzeUnits() {
    const { neighbors, verts } = this.grid;
    const ground = new Map(); // v -> unit
    const roof = new Map(); // cell key -> unit
    const rowColor = new Map(); // v -> PALETTE index for row houses
    const ponds = this.findPonds();
    const water = (v) => neighbors[v].filter((u) => !this.has(u, 0) && !ponds.has(u));

    const flood = (start, L, store, keyOf) => {
      const unit = { cells: [start], L };
      store.set(keyOf(start), unit);
      for (let i = 0; i < unit.cells.length; i++) {
        for (const u of neighbors[unit.cells[i]]) {
          if (this.topSame(u, L) && !store.has(keyOf(u))) {
            store.set(keyOf(u), unit);
            unit.cells.push(u);
          }
        }
      }
      unit.set = new Set(unit.cells);
      unit.size = unit.cells.length;
      return unit;
    };

    // Most connected cell of the unit, ties broken by distance to the centroid
    const centerOf = (unit) => {
      let cx = 0, cz = 0;
      for (const v of unit.cells) { cx += verts[v][0]; cz += verts[v][1]; }
      cx /= unit.size; cz /= unit.size;
      let best = unit.cells[0], bestScore = -Infinity;
      for (const v of unit.cells) {
        const links = neighbors[v].filter((u) => unit.set.has(u)).length;
        const score = links * 10 - Math.hypot(verts[v][0] - cx, verts[v][1] - cz);
        if (score > bestScore) { bestScore = score; best = v; }
      }
      return best;
    };

    for (const k of this.cells) {
      const v = Math.floor(k / 64), L = k % 64;
      if (!this.topSame(v, L)) continue;
      if (L === 0) {
        if (ground.has(v)) continue;
        const unit = flood(v, 0, ground, (u) => u);
        unit.center = centerOf(unit);
        const enclosed = unit.cells.every((c) => neighbors[c].every((u) => unit.set.has(u) || this.has(u, 1)));
        const thin = unit.cells.every((c) => water(c).length >= 2);
        unit.type = unit.size < 3 ? 'small' : thin ? 'dock' : enclosed ? 'courtyard' : unit.size >= 6 ? 'square' : 'park';
      } else {
        if (roof.has(k)) continue;
        const unit = flood(v, L, roof, (u) => this.key(u, L));
        unit.center = centerOf(unit);
        const degrees = unit.cells.map((c) => neighbors[c].filter((u) => unit.set.has(u)).length);
        const edges = degrees.reduce((a, b) => a + b, 0) / 2;
        const isPath = unit.size >= 3 && edges === unit.size - 1 && Math.max(...degrees) <= 2;
        unit.type = isPath ? 'row' : 'building';
        // Unit-wide choices come from votes and counts over the cells, never from one special
        // cell, so a new block only flips them when the balance actually tips
        const votes = (seed) => unit.cells.filter((c) => hash(c, L, seed) < 0.5).length * 2 > unit.size;
        unit.garden = votes(21);
        if (unit.type === 'building') {
          if (unit.size >= 4) {
            // Most common wall color, ties to the lower palette index
            const count = new Map();
            for (const c of unit.cells) {
              const ci = this.colorIndex.get(this.key(c, L));
              count.set(ci, (count.get(ci) ?? 0) + 1);
            }
            unit.roofColor = [...count].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
          } else {
            unit.roofColor = null;
          }
          unit.landmark = unit.size >= 5 ? (votes(31) ? 'cupola' : 'clock') : null;
        } else if (unit.type === 'row') {
          // Neighbouring auto-colored houses never share a color. Settled cell by cell in vertex
          // order, so growing the row only repaints houses right next to the change.
          const final = new Map();
          const sorted = [...unit.cells].sort((x, y) => x - y);
          for (const c of sorted) if (!this.autoColor.has(this.key(c, L))) final.set(c, this.colorIndex.get(this.key(c, L)));
          for (const c of sorted) {
            if (final.has(c)) continue;
            const taken = neighbors[c].filter((u) => unit.set.has(u) && final.has(u)).map((u) => final.get(u));
            let ci = this.colorIndex.get(this.key(c, L));
            for (let s = 0; taken.includes(ci) && s < PALETTE.length; s++) ci = (ci + 4) % PALETTE.length;
            final.set(c, ci);
            rowColor.set(c, ci);
          }
        }
      }
    }

    // Lighthouse: a solid lone tower at least 5 floors high standing next to open water.
    // Maps vertex -> top level; only cells up to that level get the lighthouse look.
    const lighthouse = new Map();
    // Bridge: a single-layer floating block joined to something on the same level, with
    // nothing of its own column close below (that makes it a house on supports instead)
    const bridge = new Set();
    for (const k of this.cells) {
      const v = Math.floor(k / 64), L = k % 64;
      if (L >= 1 && !this.has(v, L - 1) && !this.has(v, L + 1) && !this.has(v, L - 2) && !this.has(v, L - 3)
        && neighbors[v].some((u) => this.has(u, L))) bridge.add(k);
      if (L < 4 || !this.topSame(v, L)) continue;
      let solid = true;
      for (let l = 0; l < L && solid; l++) solid = this.has(v, l);
      for (let l = L + 2; l < MAX_LEVEL && solid; l++) solid = !this.has(v, l);
      if (!solid) continue;
      const around = new Set(this.vertexQuads[v].flat());
      around.delete(v);
      const lone = [...around].every((u) => {
        for (let l = L - 1; l <= MAX_LEVEL; l++) if (this.has(u, l)) return false;
        return true;
      });
      if (lone && water(v).length >= 2) lighthouse.set(v, L);
    }
    // Walkways joined on one level form a span that picks its style together:
    //   w: wooden walkway · c: covered gallery
    const bridgeStyle = new Map();
    for (const k of bridge) {
      if (bridgeStyle.has(k)) continue;
      const L = k % 64;
      const cells = [Math.floor(k / 64)];
      bridgeStyle.set(k, null);
      for (let i = 0; i < cells.length; i++) {
        for (const u of neighbors[cells[i]]) {
          const ku = this.key(u, L);
          if (bridge.has(ku) && !bridgeStyle.has(ku)) { bridgeStyle.set(ku, null); cells.push(u); }
        }
      }
      const votes = (seed) => cells.filter((c) => hash(c, L, seed) < 0.5).length * 2 > cells.length;
      const style = cells.length >= 3 && votes(71) ? 'c' : 'w';
      // One roof color for the whole span: its most common block color, ties to the lower index
      const count = new Map();
      for (const c of cells) {
        const ci = this.colorIndex.get(this.key(c, L));
        count.set(ci, (count.get(ci) ?? 0) + 1);
      }
      const color = [...count].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
      for (const c of cells) bridgeStyle.set(this.key(c, L), { style, color });
    }
    // Roof terrace: a normal roof whose attached neighbour rises exactly two floors higher
    const terrace = new Set();
    for (const [k, unit] of roof) {
      const v = Math.floor(k / 64), L = k % 64;
      if (bridge.has(k) || lighthouse.has(v)) continue;
      if (neighbors[v].some((u) => this.has(u, L) && this.has(u, L + 1) && this.has(u, L + 2) && !this.has(u, L + 3))) terrace.add(k);
    }
    const { support, braced, stayed } = this.findSupport(bridge, bridgeStyle);
    return { ground, roof, rowColor, lighthouse, bridge, bridgeStyle, terrace, water, ponds, support, braced, stayed };
  }

  // Every floating block is carried down to the ground, by posts of its own or by same-level
  // neighbours that are carried themselves, so nothing is left hanging in the air.
  // Blocks with their column close below (1-2 empty levels) always stand on posts. The rest
  // lean on neighbours where that is believable: spanning between two carried sides, or
  // reaching out one cell from a solid wall or posts (only when at most two floors high).
  // Past that they borrow structure from buildings close by: timber brackets from the wall of a
  // neighbour one or two floors lower, or iron tie rods from a taller building's wall down to a
  // wooden walkway. Everything below a level is carried by the time it is solved, so both are
  // safe to lean on.
  // Posts go in only where all that fails, the shortest first, and each new post lets more
  // neighbours lean on it.
  // support: cell key -> { kind, unit, pb } for blocks on posts
  // braced: cell key -> [[neighbour, its top level], ...] · stayed: cell key -> [[x, y, z] anchor, ...]
  findSupport(bridge, bridgeStyle) {
    const { neighbors, verts } = this.grid;
    const support = new Map();
    const braced = new Map();
    const stayed = new Map();
    const byLevel = new Map();
    for (const k of this.cells) {
      const v = Math.floor(k / 64), L = k % 64;
      if (L === 0 || this.has(v, L - 1)) continue;
      if (!byLevel.has(L)) byLevel.set(L, []);
      byLevel.get(L).push(v);
    }
    const unitDir = (v, u) => {
      const d = [verts[u][0] - verts[v][0], verts[u][1] - verts[v][1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      return [d[0] / l, d[1] / l];
    };
    for (const [L, cells] of byLevel) {
      const floating = new Set(cells);
      const style = (v) => bridgeStyle.get(this.key(v, L))?.style;
      // What posts would stand on: the top of the block's own column, a walkway deck, or the sea bed
      const floor = new Map();
      for (const v of cells) {
        let l = L - 1;
        while (l >= 0 && !this.has(v, l)) l--;
        floor.set(v, { l, pb: l < 0 ? -0.1 : bridge.has(this.key(v, l)) ? yBottom(l) : yTop(l) });
      }
      const posted = new Set(cells.filter((v) => floor.get(v).l >= 0 && floor.get(v).l >= L - 3));
      const held = new Set();
      const anchor = (u) => this.has(u, L) && (!floating.has(u) || posted.has(u));
      const carried = (u) => anchor(u) || held.has(u);
      const floors = (v) => { let h = 1; while (this.has(v, L + h)) h++; return h; };
      const spans = (v, nb) => {
        const cs = nb.filter(carried).map((u) => unitDir(v, u));
        for (let a = 0; a < cs.length; a++) {
          for (let b = a + 1; b < cs.length; b++) if (cs[a][0] * cs[b][0] + cs[a][1] * cs[b][1] < -0.45) return true;
        }
        return false;
      };
      // Neighbours whose top is one or two floors below this level, for brackets to rise from.
      // Brackets on one side can only carry a single floor; a taller block needs them from
      // two sides, or it would read as hanging off one wall.
      const brackets = (v) => {
        if (floors(v) > 2) return [];
        const out = [];
        for (const u of neighbors[v]) {
          if (this.has(u, L)) continue;
          const l = this.has(u, L - 1) ? L - 1 : L >= 2 && this.has(u, L - 2) ? L - 2 : -1;
          if (l >= 0 && !bridge.has(this.key(u, l))) out.push([u, l]);
        }
        const dirs = out.map(([u]) => unitDir(v, u));
        const spread = dirs.some((a) => dirs.some((b) => a[0] * b[0] + a[1] * b[1] < 0.3));
        if (floors(v) > 1 && !spread) return [];
        return out.sort((a, b) => a[0] - b[0]);
      };
      // Solid buildings rising above a wooden walkway or gallery within reach along it: one floor above
      // reaches two cells, two floors three. At most one anchor per side, nearest first.
      const stays = (v) => {
        const hung = (u) => style(u) === 'w' || style(u) === 'c';
        if (!hung(v)) return [];
        const found = [];
        const seen = new Set([v]);
        let ring = [v];
        for (let d = 1; d <= 3 && ring.length; d++) {
          const next = [];
          for (const w of ring) {
            for (const a of neighbors[w]) {
              if (seen.has(a) || !this.has(a, L)) continue;
              seen.add(a);
              if (floating.has(a)) { if (hung(a)) next.push(a); continue; }
              let r = 0;
              while (r < 2 && this.has(a, L + r + 1)) r++;
              if (r && d <= r + 1) found.push({ a, w, r });
            }
          }
          ring = next;
        }
        const picked = [];
        for (const f of found) {
          const dir = unitDir(v, f.a);
          if (picked.some((g) => g.dir[0] * dir[0] + g.dir[1] * dir[1] > 0.3)) continue;
          picked.push({ ...f, dir });
          if (picked.length === 2) break;
        }
        const rd = (x) => Math.round(x * 1000) / 1000;
        return picked.map(({ a, w, r }) => {
          const e = [(verts[a][0] + verts[w][0]) / 2, (verts[a][1] + verts[w][1]) / 2];
          return [rd(e[0]), rd(yTop(L + r) - 0.2), rd(e[1])];
        });
      };
      // How a floating cell is held without posts of its own, or null. A mid-span walkway
      // prefers tie rods over hanging on the span alone.
      const hold = (v) => {
        const nb = neighbors[v].filter((u) => this.has(u, L));
        if (floors(v) <= 2 && nb.some(anchor)) return true;
        // A tip held by one cell becomes a gazebo, whose roof the rods would cut through
        const sy = nb.length > 1 ? stays(v) : [];
        if (sy.length) { stayed.set(this.key(v, L), sy); return true; }
        if (spans(v, nb)) return true;
        const bu = brackets(v);
        if (bu.length) { braced.set(this.key(v, L), bu); return true; }
        return false;
      };
      const grow = (seeds) => {
        const work = [...seeds];
        while (work.length) {
          const v = work.pop();
          if (!floating.has(v) || carried(v) || !hold(v)) continue;
          held.add(v);
          for (const u of neighbors[v]) if (floating.has(u) && !carried(u)) work.push(u);
        }
      };
      grow(cells);
      for (;;) {
        const left = cells.filter((v) => !carried(v));
        if (!left.length) break;
        const cost = (v) => L - 1 - floor.get(v).l;
        const open = (v) => neighbors[v].filter((u) => floating.has(u) && !carried(u)).length;
        const best = left.reduce((a, v) => (cost(v) - cost(a) || open(a) - open(v) || hash(v, L, 83) - hash(a, L, 83)) < 0 ? v : a);
        posted.add(best);
        grow(neighbors[best]);
      }
      // Posts joined on one level form a unit that picks one kind of support together
      const seen = new Set();
      for (const s of posted) {
        if (seen.has(s)) continue;
        const unit = [s];
        seen.add(s);
        for (let i = 0; i < unit.length; i++) {
          for (const u of neighbors[unit[i]]) if (posted.has(u) && !seen.has(u)) { seen.add(u); unit.push(u); }
        }
        const votes = (seed) => unit.filter((c) => hash(c, L, seed) < 0.5).length * 2 > unit.length;
        const gaps = unit.map((c) => (floor.get(c).l < 0 ? Infinity : L - 1 - floor.get(c).l));
        const kind = unit.some((c) => style(c) === 'w') ? 'timber'
          : gaps.some((g) => g >= 3) ? 'pillar'
          : gaps.every((g) => g === 1) ? (votes(81) ? 'colonnade' : 'timber')
          : unit.length === 1 && votes(82) ? 'stem' : 'stilts';
        const id = Math.min(...unit);
        for (const c of unit) support.set(this.key(c, L), { kind, unit: id, pb: floor.get(c).pb });
      }
    }
    return { support, braced, stayed };
  }

  // Water fully enclosed by foundations becomes a pond. Regions are grown through
  // unbuilt vertices; touching the fixed rim means open sea.
  //   well: a single vertex among houses · basin: framed by houses
  //   lagoon: large, with an islet and a rowboat · lily: small garden pond
  findPonds() {
    const { neighbors, verts, fixed } = this.grid;
    const ponds = new Map();
    const seen = new Set();
    for (let s = 0; s < verts.length; s++) {
      if (seen.has(s) || fixed[s] || this.has(s, 0)) continue;
      const cells = [s];
      seen.add(s);
      let sea = false;
      const bank = new Set();
      for (let i = 0; i < cells.length; i++) {
        for (const u of neighbors[cells[i]]) {
          if (this.has(u, 0)) { bank.add(u); continue; }
          if (fixed[u]) sea = true;
          else if (!seen.has(u)) { seen.add(u); cells.push(u); }
        }
      }
      if (sea || !bank.size) continue;
      let built = 0, born = -100, cx = 0, cz = 0;
      for (const u of bank) {
        if (this.has(u, 1)) built++;
        born = Math.max(born, this.born.get(this.key(u, 0)) ?? -100);
      }
      for (const c of cells) { cx += verts[c][0]; cz += verts[c][1]; }
      cx /= cells.length; cz /= cells.length;
      const center = cells.reduce((a, c) =>
        Math.hypot(verts[c][0] - cx, verts[c][1] - cz) < Math.hypot(verts[a][0] - cx, verts[a][1] - cz) ? c : a);
      const framed = built / bank.size >= 0.5;
      const type = framed ? (cells.length === 1 ? 'well' : 'basin') : cells.length >= 5 ? 'lagoon' : 'lily';
      for (const c of cells) ponds.set(c, { type, b: born, c: c === center });
    }
    return ponds;
  }

  // Every per-cell input the geometry depends on, including what comes from unit analysis.
  // Its JSON is part of the quad signature, so geometry never goes stale.
  cellInfo(v, L, units) {
    const k = this.key(v, L);
    let ci = this.colorIndex.get(k) ?? 0;
    if (units.rowColor.has(v) && this.autoColor.has(k)) ci = units.rowColor.get(v);
    const lh = units.lighthouse.get(v);
    const info = {
      b: this.born.get(k) ?? -100,
      ci,
      st: L === 0 ? 'g' : lh !== undefined && L <= lh ? 'l' : 'n',
      t: !this.has(v, L + 1),
      br: units.bridge.has(k),
      tr: units.terrace.has(k),
      r: this.roofRise(v, L, units),
      // 0 stays dark; otherwise the switch-on order, so floors light up one by one as night falls
      lit: hash(v, L, 77) < 0.7 ? 0.02 + 0.98 * hash(v, L, 78) : 0,
    };
    const sup = units.support.get(k);
    const attached = () => this.grid.neighbors[v].filter((u) => this.has(u, L)).sort((a, b) => a - b);
    // On posts: their kind, the unit sharing them, and the height they stand on
    if (sup) ({ kind: info.pk, unit: info.pu, pb: info.pb } = sup);
    // Held by brackets from lower neighbours, or tie rods from taller buildings
    if (units.braced.has(k)) info.bu = units.braced.get(k);
    if (units.stayed.has(k)) info.sy = units.stayed.get(k);
    if (info.br) {
      ({ style: info.bs, color: info.bc } = units.bridgeStyle.get(k));
      const un = attached();
      // A tip sticking out into the air, held only by more walkway, becomes a gazebo
      if (un.length === 1 && units.bridge.has(this.key(un[0], L))) info.gz = 1;
    }
    // A block hanging free: which same-level neighbours hold it decides its underside
    else if (!sup && !info.bu && L > 0 && !this.has(v, L - 1)) {
      info.un = attached();
      // Holders with a solid wall below the shared edge, for struts to rise from
      const walled = info.un.filter((u) => this.has(u, L - 1) && !units.bridge.has(this.key(u, L - 1)));
      if (walled.length) info.hw = walled;
    }
    if (info.t) {
      const cv = this.coverGap(v, L, units);
      if (cv) info.cv = cv;
    }
    if (!info.t) return info;
    if (L === 0) {
      const gu = units.ground.get(v);
      info.gt = gu ? gu.type : 'small';
      info.gc = gu ? gu.center === v : false;
      if (info.gt === 'dock' && hash(v, 51) < 0.4) {
        const spot = this.boatSpot(v, units);
        if (spot) info.boat = spot;
      }
      // String across the street between two facing houses: the two most opposite neighbours
      // with at least two solid floors, over a cell with nothing built above it
      if (info.gt !== 'dock' && !units.ponds.has(v) && hash(v, 130) < 0.6) {
        const { neighbors, verts } = this.grid;
        const solid = (u, l) => this.has(u, l) && !units.bridge.has(this.key(u, l));
        const tall = neighbors[v].filter((u) => solid(u, 1) && solid(u, 2));
        const dir = (u) => {
          const d = [verts[u][0] - verts[v][0], verts[u][1] - verts[v][1]], l = Math.hypot(d[0], d[1]);
          return [d[0] / l, d[1] / l];
        };
        let best = null, bd = -0.8;
        for (let a = 0; a < tall.length; a++) {
          for (let b = a + 1; b < tall.length; b++) {
            const da = dir(tall[a]), db = dir(tall[b]), d = da[0] * db[0] + da[1] * db[1];
            if (d < bd) [bd, best] = [d, [tall[a], tall[b]]];
          }
        }
        let clear = true;
        for (let l = 1; l < MAX_LEVEL; l++) if (this.has(v, l)) clear = false;
        if (best && clear) info.ss = best;
      }
      return info;
    }
    const ru = units.roof.get(k);
    info.lt = lh === L;
    if (ru) {
      info.ut = ru.type;
      info.gd = ru.garden;
      info.rc = ru.roofColor != null ? ru.roofColor : ci;
      if (ru.landmark && this.landmarkHost(ru, units) === v) info.lm = ru.landmark;
      if (ru.type === 'row') info.ch = hash(v, L, 3) < 0.5;
    }
    return info;
  }

  // One merged mesh and outline for the given quads (all of them by default)
  buildGeometry(quads = this.grid.quads, useCache = true) {
    const { recOf, fx } = this.buildRecords(quads, useCache);
    const records = quads.map((q) => recOf.get(q));
    const edges = this.quadEdges.filter((qe) => qe.sides.some(([q]) => recOf.has(q)));
    const vs = [...new Set(quads.flat())];
    const { geometry, lines, meta } = this.assemble(records, edges, vs, recOf, useCache);
    return { geometry, edges: lines, meta, fx };
  }

  // Spatial chunks, each drawn as its own mesh so an edit only re-uploads the ones it
  // touches. A chunk owns its quads, the shared edges and grid vertices of its first quad,
  // and depends on every quad whose record feeds those.
  layoutChunks() {
    const { grid } = this;
    const CHUNK = 3;
    const chunkIds = new Map();
    const chunkOf = new Map();
    this.chunks = [];
    for (const q of grid.quads) {
      const cx = q.reduce((a, v) => a + grid.verts[v][0], 0) / 4, cz = q.reduce((a, v) => a + grid.verts[v][1], 0) / 4;
      const id = `${Math.floor(cx / CHUNK)},${Math.floor(cz / CHUNK)}`;
      if (!chunkIds.has(id)) {
        chunkIds.set(id, this.chunks.length);
        this.chunks.push({ id: this.chunks.length, quads: [], edges: [], verts: [], deps: new Set(), recs: null });
      }
      const ch = this.chunks[chunkIds.get(id)];
      ch.quads.push(q);
      ch.deps.add(q);
      chunkOf.set(q, ch);
    }
    for (const qe of this.quadEdges) {
      const ch = chunkOf.get(qe.sides[0][0]);
      ch.edges.push(qe);
      for (const [q] of qe.sides) ch.deps.add(q);
    }
    this.vertexQuads.forEach((qs, v) => {
      if (!qs.length) return;
      const ch = chunkOf.get(qs[0]);
      ch.verts.push(v);
      for (const q of qs) ch.deps.add(q);
    });
    for (const ch of this.chunks) ch.deps = [...ch.deps];
  }

  // The town as per-chunk meshes; only chunks whose inputs changed since the last call are
  // rebuilt. Returns every chunk, flagged dirty when its geometry is new.
  buildChunks() {
    if (!this.chunks) this.layoutChunks();
    const { recOf, fx } = this.buildRecords(this.grid.quads, true);
    const out = [];
    for (const ch of this.chunks) {
      const recs = ch.deps.map((q) => recOf.get(q));
      const same = ch.recs && recs.every((r, i) => r === ch.recs[i]);
      if (!same) {
        ch.recs = recs;
        const records = ch.quads.map((q) => recOf.get(q));
        ch.empty = records.every((r) => !r.meta.length);
        ch.built = ch.empty ? null : this.assemble(records, ch.edges, ch.verts, recOf, true);
      }
      out.push({ id: ch.id, dirty: !same, empty: ch.empty, geometry: ch.built?.geometry, edges: ch.built?.lines });
    }
    return { chunks: out, fx };
  }

  // Build (or reuse) one record per quad
  buildRecords(quads, useCache) {
    const { verts } = this.grid;
    const units = this.analyzeUnits();
    const infos = new Map(); // cell key -> { info, json }
    const infoOf = (v, L) => {
      const k = this.key(v, L);
      let e = infos.get(k);
      if (!e) {
        const info = this.cellInfo(v, L, units);
        e = { info, json: JSON.stringify(info) };
        infos.set(k, e);
      }
      return e;
    };
    const signature = (q) => {
      let s = '';
      for (const v of q) {
        s += '|';
        for (let L = 0; L < MAX_LEVEL; L++) if (this.has(v, L)) s += L + infoOf(v, L).json;
        const pond = units.ponds.get(v);
        if (pond) s += 'P' + JSON.stringify(pond);
      }
      return s;
    };

    // --- Per-quad emission into the current record R ---
    let R = null;
    let noOutline = false;
    let waveFn = null; // per-vertex sway weight for hanging cloth
    let shadeFn = null; // per-vertex color multiplier, for baked occlusion

    const tri = (a, b, c, hint, color, m) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0;
      if (flip) [b, c] = [c, b];
      const len = (Math.hypot(nx, ny, nz) || 1) * (flip ? -1 : 1);
      const n = [nx / len, ny / len, nz / len];
      const pv = this.pivot(m.v, m.L);
      const cell = m.pond ?? infoOf(m.v, m.L).info;
      const glow = color === LAMP ? LAMP_ORDER : color === WINDOW || CURTAINS.includes(color) ? cell.lit : 0;
      for (const p of [a, b, c]) {
        R.position.push(p[0], p[1], p[2]);
        R.normal.push(n[0], n[1], n[2]);
        const k = shadeFn ? shadeFn(p) : 1;
        R.color.push(color.r * k, color.g * k, color.b * k);
        R.aPivot.push(pv[0], pv[1], pv[2]);
        R.aBorn.push(cell.b);
        R.aGlow.push(glow);
        R.aWave.push(waveFn ? waveFn(p) : 0);
      }
      R.normals.push(n);
      R.edgeless.push(noOutline);
      R.meta.push(m);
    };
    const quad = (a, b, c, d, hint, color, m) => {
      tri(a, b, c, hint, color, m);
      tri(a, c, d, hint, color, m);
    };
    const p3 = (p, y) => [p[0], y, p[1]];
    const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

    // Low-poly blob (tree canopy, bush)
    const blob = (c, r, sy, color, m) => {
      for (let i = 0; i < ICO.length; i += 9) {
        const pt = (j) => [c[0] + ICO[i + j] * r, c[1] + ICO[i + j + 1] * r * sy, c[2] + ICO[i + j + 2] * r];
        const a = pt(0), b = pt(3), d = pt(6);
        const hint = [(a[0] + b[0] + d[0]) / 3 - c[0], (a[1] + b[1] + d[1]) / 3 - c[1], (a[2] + b[2] + d[2]) / 3 - c[2]];
        tri(a, b, d, hint, color, m);
      }
    };

    // Box aligned to a horizontal direction dir (unit, 2D)
    const box = (c2, y0, y1, half, dir, color, m) => {
      // Lamps get a round halo at night
      if (color === LAMP) R.fx.glows.push({ x: c2[0], y: (y0 + y1) / 2, z: c2[1], born: (m.pond ?? infoOf(m.v, m.L).info).b });
      const [dx, dz] = dir;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => [
        c2[0] + (dx * s - dz * t) * half,
        c2[1] + (dz * s + dx * t) * half,
      ]);
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        const out = [(a[0] + b[0]) / 2 - c2[0], 0, (a[1] + b[1]) / 2 - c2[1]];
        quad(p3(a, y0), p3(b, y0), p3(b, y1), p3(a, y1), out, color, m);
      }
      quad(...corners.map((p) => p3(p, y1)), [0, 1, 0], color, m);
    };

    const ring = (c2, r, sides, yaw = 0) =>
      Array.from({ length: sides }, (_, s) => {
        const ang = yaw + (s / sides) * Math.PI * 2;
        return [c2[0] + Math.cos(ang) * r, c2[1] + Math.sin(ang) * r];
      });
    const prism = (c2, r, y0, y1, sides, color, m, topColor = color) => {
      const pts = ring(c2, r, sides);
      for (let s = 0; s < sides; s++) {
        const a = pts[s], b = pts[(s + 1) % sides];
        quad(p3(a, y0), p3(b, y0), p3(b, y1), p3(a, y1), [(a[0] + b[0]) / 2 - c2[0], 0, (a[1] + b[1]) / 2 - c2[1]], color, m);
        tri(p3(c2, y1), p3(a, y1), p3(b, y1), [0, 1, 0], topColor, m);
      }
    };
    const cone = (c2, r, y0, apex, sides, color, m, yaw = 0) => {
      const pts = ring(c2, r, sides, yaw);
      for (let s = 0; s < sides; s++) {
        const a = pts[s], b = pts[(s + 1) % sides];
        tri(p3(a, y0), p3(b, y0), p3(c2, apex), [(a[0] + b[0]) / 2 - c2[0], r, (a[1] + b[1]) / 2 - c2[1]], color, m);
      }
    };

    const fountain = (c2, y, scale, m) => {
      prism(c2, 0.34 * scale, y, y + 0.12, 8, WHITE, m, WATER);
      prism(c2, 0.05 * scale, y + 0.12, y + 0.34 * scale + 0.1, 6, WHITE, m);
      prism(c2, 0.14 * scale, y + 0.34 * scale + 0.1, y + 0.34 * scale + 0.15, 8, WHITE, m, WATER);
    };

    const tree = (c2, y, r, m, seed) => {
      box(c2, y, y + 0.35, 0.04, [1, 0], TRUNK, m);
      blob([c2[0], y + 0.55, c2[1]], r, 1.3, pickFrom(LEAVES, seed), m);
    };

    // Rooftop landmark for big buildings, standing on the roof peak at c2
    const landmark = (type, c2, y, wallColor, m) => {
      if (type === 'cupola') {
        prism(c2, 0.26, y - 0.15, y + 0.3, 8, WHITE, m);
        for (const p of ring(c2, 0.265, 8, Math.PI / 8)) box(p, y + 0.02, y + 0.26, 0.035, [1, 0], WINDOW, m);
        blob([c2[0], y + 0.3, c2[1]], 0.27, 0.85, COPPER, m);
        prism(c2, 0.025, y + 0.5, y + 0.72, 4, GOLD, m);
      } else {
        box(c2, y - 0.15, y + 0.85, 0.17, [1, 0], wallColor, m);
        // Clock face on each side: vertical disc facing outward
        for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const cx = c2[0] + dx * 0.18, cz = c2[1] + dz * 0.18, cy = y + 0.6;
          const face = Array.from({ length: 10 }, (_, s) => {
            const ang = (s / 10) * Math.PI * 2;
            return [cx - dz * Math.cos(ang) * 0.1, cy + Math.sin(ang) * 0.1, cz + dx * Math.cos(ang) * 0.1];
          });
          noOutline = true;
          for (let s = 0; s < 10; s++) tri([cx, cy, cz], face[s], face[(s + 1) % 10], [dx, 0, dz], WHITE, m);
          noOutline = false;
          tri([cx + dx * 0.005, cy, cz + dz * 0.005], [cx + dx * 0.005, cy + 0.08, cz + dz * 0.005], [cx + dx * 0.005 - dz * 0.015, cy, cz + dz * 0.005 + dx * 0.015], [dx, 0, dz], SLATE, m);
        }
        box(c2, y + 0.85, y + 0.9, 0.2, [1, 0], WHITE, m);
        cone(c2, 0.26, y + 0.9, y + 1.35, 4, SLATE, m, Math.PI / 4);
      }
    };

    const lighthouseTop = (c2, y, m) => {
      prism(c2, 0.46, y, y + 0.06, 12, SLATE, m);
      prism(c2, 0.2, y + 0.06, y + 0.12, 8, SLATE, m);
      prism(c2, 0.18, y + 0.12, y + 0.46, 8, LAMP, m);
      prism(c2, 0.24, y + 0.46, y + 0.5, 8, SLATE, m);
      cone(c2, 0.26, y + 0.5, y + 0.82, 8, LH_RED, m);
      prism(c2, 0.02, y + 0.82, y + 0.95, 4, GOLD, m);
      R.fx.lamps.push({ x: c2[0], y: y + 0.29, z: c2[1], born: infoOf(m.v, m.L).info.b });
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
    // Square bar between two 3D points (beams, braces, strings)
    const bar = (a, b, h, color, m) => {
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
        quad(add(a, o0), add(b, o0), add(b, o1), add(a, o1), [o0[0] + o1[0], o0[1] + o1[1], o0[2] + o1[2]], color, m);
      }
    };
    // Half-round cap along a roof crease through the 3D points pts, half sunk into the roof;
    // the last end is closed when capEnd is set
    const ridgeCap = (pts, r, color, m, capEnd) => {
      noOutline = true;
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
          quad(A[k].p, B[k].p, B[k + 1].p, A[k + 1].p, hint, color, m);
        }
      }
      const last = profs[profs.length - 1];
      if (capEnd) for (let k = 1; k < 4; k++) tri(last[0].p, last[k].p, last[k + 1].p, dirs[dirs.length - 1], color, m);
      noOutline = false;
    };
    // Sagging string from a to b (3D); returns the point at t along it
    const sagString = (a, b, sag, color, m) => {
      const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
      for (let k = 0; k < 4; k++) bar(at(k / 4), at((k + 1) / 4), 0.006, color, m);
      return at;
    };
    // Flat piece of cloth hanging from a string, visible from both sides and swaying
    const hanging = (pts, color, m) => {
      const y = Math.max(...pts.map((pt) => pt[1]));
      noOutline = true;
      waveFn = (pt) => (y - pt[1]) * 3;
      const d = [pts[1][0] - pts[0][0], pts[1][2] - pts[0][2]];
      for (const sd of [1, -1]) {
        const hint = [-d[1] * sd, 0, d[0] * sd];
        if (pts.length === 4) quad(...pts, hint, color, m);
        else tri(...pts, hint, color, m);
      }
      waveFn = null;
      noOutline = false;
    };
    const plants = (c2, y, seed, m) => {
      for (let k = 0; k < 2; k++) {
        const pos = offset(c2, seed * 6.28 + k * 2.4, 0.22);
        prism(pos, 0.055, y, y + 0.09, 6, TERRACOTTA, m);
        blob([pos[0], y + 0.15, pos[1]], 0.08, 1.1, pickFrom(LEAVES, hash(seed * 997, k)), m);
      }
    };
    const offset = (c2, ang, r) => [c2[0] + Math.cos(ang) * r, c2[1] + Math.sin(ang) * r];
    // Bunting or a washing line across the street over ground cell v, between the second-floor
    // walls of the two facing houses (walls pass through the edge midpoints)
    const streetString = (v, [a, b], m) => {
      const y = yBottom(2) + 0.67;
      const pa = p3(lerp2(verts[v], verts[a], 0.5), y), pb = p3(lerp2(verts[v], verts[b], 0.5), y);
      const len = Math.hypot(pb[0] - pa[0], pb[2] - pa[2]);
      if (hash(v, 131) < 0.55) {
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
        const u = verts[this.grid.neighbors[v][0]];
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

    // Overhanging eaves where roof quadrant i meets an outer wall: a thick wedge carrying the
    // slope out past the wall. At the edge midpoint a strip ends where the neighbouring quad's
    // strip starts; at the quad center it meets the next wall's strip on their mitred line, or
    // follows a rounded corner (arc).
    // eaved[k]: quadrant k gets eaves too, otherwise the open end of the wedge is capped.
    const eaves = (i, C, M, Q, occ, eaved, arc, y, color, m) => {
      const unit = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
      const out = (p, d) => [p[0] + d[0] * EAVE, p[1] + d[1] * EAVE];
      const yo = y - EAVE_DROP, yb = yo - EAVE_RIM;
      const shade = color.clone().multiplyScalar(0.55);
      // Wedge from wall top A->B out to Ao->Bo
      const strip = (A, B, Ao, Bo) => {
        const d = unit(A, B), mid = lerp2(Ao, Bo, 0.5), base = lerp2(A, B, 0.5);
        quad(p3(A, y), p3(B, y), p3(Bo, yo), p3(Ao, yo), [0, 1, 0], color, m);
        quad(p3(Ao, yo), p3(Bo, yo), p3(Bo, yb), p3(Ao, yb), [mid[0] - base[0], 0, mid[1] - base[1]], color, m);
        noOutline = true;
        quad(p3(A, y), p3(B, y), p3(Bo, yb), p3(Ao, yb), [0, -1, 0], shade, m);
        noOutline = false;
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
        return Math.hypot(x[0] - Q[0], x[1] - Q[1]) < EAVE * 3 ? x : null;
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
      for (const [k, j] of [[i, n], [p, p]]) {
        if (occ[j]) continue;
        const own = line(k);
        // Checkerboard corners have four walls at the center: no single partner to mitre with
        const other = segs.length === 2 ? segs.find((s) => s !== k) : null;
        const qo = (other != null && meet(own, line(other))) || own.p;
        const along = k === i ? strip(M[k], Q, mOut(k, j), qo) : strip(Q, M[k], qo, mOut(k, j));
        const partner = other == null ? -1 : occ[other] ? other : (other + 1) % 4;
        if (partner < 0 || !eaved[partner]) {
          const toQ = k === i ? along : [-along[0], -along[1]];
          tri(p3(Q, y), p3(qo, yo), p3(qo, yb), [toQ[0], 0, toQ[1]], color, m);
        }
      }
    };

    // Wall face a->b between heights y0 and y1, darkened in soft bands where it stands on the
    // ground (foot) or tucks under the eaves, in place of ambient occlusion
    const face = (a, b, y0, y1, towards, color, m, foot, under) => {
      const yA = foot ? y0 + AO_BAND : y0, yB = under ? y1 - AO_BAND : y1;
      shadeFn = (pt) => (foot && pt[1] < y0 + 1e-4 ? AO_FOOT : under && pt[1] > y1 - 1e-4 ? AO_EAVES : 1);
      if (foot) quad(p3(a, y0), p3(b, y0), p3(b, yA), p3(a, yA), towards, color, m);
      quad(p3(a, yA), p3(b, yA), p3(b, yB), p3(a, yB), towards, color, m);
      if (under) quad(p3(a, yB), p3(b, yB), p3(b, y1), p3(a, y1), towards, color, m);
      shadeFn = null;
    };
    // Which bands a house wall of cell (v, L) gets
    const aoBands = (v, L) => {
      const I = infoOf(v, L).info;
      return [L === 1 && this.has(v, 0), I.t && I.r > 0 && !I.lt];
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
      if (q.every((u, j) => mine(j)) || q.some((u, j) => inf[j] && this.has(u, L - 1))) return;
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
      if (this.has(v, L - 1)) return null;
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

    // Roof over a walkway: a gallery hips like a house roof along covered neighbours and leans
    // against the houses it docks onto; a lone gazebo tip gets a steep pyramid
    const canopy = (v, L, I, q, i, C, M, Q, occ, br, roofed, yd, firstQuad, m) => {
      const n = (i + 1) % 4, p = (i + 3) % 4;
      const ye = yd + 0.55, rise = I.bs === 'c' ? 0.25 : 0.5;
      const high = occ.map((o, j) => roofed[j] || (o && !br[j]));
      const h = (hi) => (hi ? ye + rise : ye);
      const roof = ROOFS[I.bc].clone().multiplyScalar(I.gz ? 1 : 0.85);
      quad(p3(C[i], ye + rise), p3(M[i], h(high[n])), p3(Q, h(high.every(Boolean))), p3(M[p], h(high[p])), [0, 1, 0], roof, m);
      quad(p3(C[i], ye), p3(M[i], ye), p3(Q, ye), p3(M[p], ye), [0, -1, 0], WOOD.clone().multiplyScalar(0.8), m);
      if (!occ[n] || !occ[p]) {
        const post = lerp2(Q, C[i], 0.12);
        box(post, yd, ye, 0.03, [1, 0], WOOD, m);
      }
      if (I.gz && firstQuad) {
        // Lantern hanging in the middle of the gazebo
        bar([C[i][0], ye, C[i][1]], [C[i][0], ye - 0.14, C[i][1]], 0.008, SLATE, m);
        box(C[i], ye - 0.24, ye - 0.14, 0.04, [1, 0], LAMP, m);
        prism(C[i], 0.02, ye + rise, ye + rise + 0.14, 4, GOLD, m);
      }
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
        const centers = this.vertexQuads[v].filter((qq) => qq.includes(target)).map((qq) =>
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
          noOutline = true;
          // Stops where a rounded corner takes over (fa/fb lie on a-b)
          const tOf = (pt) => ((pt[0] - a[0]) * (b[0] - a[0]) + (pt[1] - a[1]) * (b[1] - a[1])) / (len * len);
          const t0 = tOf(fa), t1 = tOf(fb);
          quad(p3(at(t0, 0.005), 0.02), p3(at(t1, 0.005), 0.02), p3(at(t1, 0.14), 0.02), p3(at(t0, 0.14), 0.02), [0, 1, 0], FOAM, m);
          noOutline = false;
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
      const facesPlaza = L === 1 && !this.has(target, 1) && this.has(target, 0);
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
      const skyGlass = (yA, yB) => { shadeFn = (pt) => 1 + 0.6 * Math.max(0, Math.min(1, (pt[1] - yA) / (yB - yA))); };
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
        R.fx.halos.push({ x: c[0], y: yc, z: c[1], nx, nz, hw, hh, rb, rt, order: I.lit, born: I.b });
      };
      // Big window with a chunky frame, optionally round-arched; hw is its half width
      const window1 = (hw, h0, h1, round = false, drape = null) => {
        const w = U(hw), f = U(FRAME), yA = y0 + h0, yB = y0 + h1;
        halo((yA + yB) / 2, hw, (yB - yA) / 2, 0, round ? hw : 0);
        const ys = round ? yB - hw : yB; // springline of the arch
        skyGlass(yA, yB);
        rect(tm(0), tm(w), h0, ys - y0, WINDOW, 0.004);
        if (round) fan(ys, hw, 0, Math.PI / 2, 0.012, WINDOW);
        shadeFn = null;
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
        shadeFn = null;
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
          noOutline = true;
          quad(p3(w0, yW), p3(w1, yW), p3(o1, yV), p3(o0, yV), [0, -1, 0], c.clone().multiplyScalar(0.6), m);
          noOutline = false;
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
      if (facesPlaza && this.has(v, 2)) {
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
      if (L >= 2 && this.has(target, L - 1) && !this.has(target, L) && infoOf(target, L - 1).info.tr) {
        // French door out onto the neighbour's roof terrace
        window1(0.14, 0.03, 0.57);
        return;
      }
      // A lower neighbour's pitched roof rises against this wall and would bury the window
      if (L >= 2 && this.has(target, L - 1) && !this.has(target, L)) {
        const T = infoOf(target, L - 1).info;
        if (T.t && !T.br && !T.cv && T.r > 0) return;
      }
      if (L === 2 && this.hasStair(v, target) && !aIsM) {
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
      if ((facesPlaza && h < 0.6) || (units.bridge.has(this.key(target, L)) && h < 0.75)) {
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
        const leaf = pickFrom(IVY, hash(v, target, 20)), top = this.has(v, 2) ? 0.95 : 0.6;
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

    const emitQuad = (q) => {
      const C = q.map((v) => verts[v]);
      const Q = [(C[0][0] + C[1][0] + C[2][0] + C[3][0]) / 4, (C[0][1] + C[1][1] + C[2][1] + C[3][1]) / 4];
      const M = C.map((c, i) => lerp2(c, C[(i + 1) % 4], 0.5));
      const quadId = Math.min(...q) * 4096 + Math.max(...q);
      const styleOf = (I) => (I.st === 'g' ? (I.gt === 'dock' ? 'dock' : 'ground')
        : I.st === 'l' ? 'lighthouse' : 'normal');
      const wallColorOf = (I, L, style = styleOf(I)) => (L === 0 ? (style === 'dock' ? WOOD : STONE)
        : style === 'lighthouse' ? (L % 2 ? WHITE : LH_RED) : WALLS[I.ci]);
      // Outer corners of houses standing on the floor below are rounded: quadrant i's two walls
      // meet the quad center on an arc tangent to both. Returns its points from the wall towards
      // n to the wall towards p, with outward normals, or null when the corner stays sharp.
      // Foundations round off too, unless a house above keeps the corner square.
      const cornerArc = (i, L) => {
        if (!this.has(q[i], L) || (L > 0 && !this.has(q[i], L - 1))) return null;
        if ([1, 2, 3].some((d) => this.has(q[(i + d) % 4], L))) return null;
        const I = infoOf(q[i], L).info;
        if (L === 0) {
          if (styleOf(I) !== 'ground' || [1, 2, 3].some((d) => units.ponds.has(q[(i + d) % 4]))) return null;
          if (this.has(q[i], 1) && !cornerArc(i, 1)) return null;
        } else if (I.br || styleOf(I) !== 'normal') return null;
        const p = (i + 3) % 4;
        const l1 = Math.hypot(M[i][0] - Q[0], M[i][1] - Q[1]), l2 = Math.hypot(M[p][0] - Q[0], M[p][1] - Q[1]);
        const e1 = [(M[i][0] - Q[0]) / l1, (M[i][1] - Q[1]) / l1], e2 = [(M[p][0] - Q[0]) / l2, (M[p][1] - Q[1]) / l2];
        const theta = Math.acos(Math.max(-1, Math.min(1, e1[0] * e2[0] + e1[1] * e2[1])));
        if (theta > 2.97) return null; // barely a corner
        const t = Math.min(CORNER, l1 * 0.3, l2 * 0.3), rad = t * Math.tan(theta / 2);
        const bis = [e1[0] + e2[0], e1[1] + e2[1]], bl = Math.hypot(bis[0], bis[1]);
        const dc = t / Math.cos(theta / 2);
        const O = [Q[0] + (bis[0] / bl) * dc, Q[1] + (bis[1] / bl) * dc];
        const a0 = Math.atan2(Q[1] + e1[1] * t - O[1], Q[0] + e1[0] * t - O[0]);
        const a1 = Math.atan2(Q[1] + e2[1] * t - O[1], Q[0] + e2[0] * t - O[0]);
        let da = a1 - a0;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        // Facets under the outline crease angle, so the corner reads as smooth
        const K = Math.max(2, Math.ceil(Math.abs(da) / 0.38));
        const pts = [], nrm = [];
        for (let k = 0; k <= K; k++) {
          const a = a0 + (da * k) / K;
          nrm.push([Math.cos(a), Math.sin(a)]);
          pts.push([O[0] + Math.cos(a) * rad, O[1] + Math.sin(a) * rad]);
        }
        return { pts, nrm };
      };
      // Fan from c at height yc over a ring of [point, height], facing along hint
      const fanOver = (c, yc, ring, hint, color, m) => {
        for (let k = 0; k + 1 < ring.length; k++) tri(p3(c, yc), p3(...ring[k]), p3(...ring[k + 1]), hint, color, m);
      };

      // Pond water sits above the sea waves and below the foundation tops
      q.forEach((v, i) => {
        const P = units.ponds.get(v);
        if (!P) return;
        const p = (i + 3) % 4;
        const pm = { kind: 'pond', v, L: 0, pond: P };
        noOutline = true;
        quad(p3(C[i], POND_Y), p3(M[i], POND_Y), p3(Q, POND_Y), p3(M[p], POND_Y), [0, 1, 0], POND_COLORS[P.type], pm);
        noOutline = false;
        // Now and then a firefly spot over the pond water at night
        if (hash(v, quadId, 81) < 0.4) {
          const f = lerp2(C[i], Q, 0.5);
          R.fx.flies.push({ x: f[0], y: POND_Y, z: f[1], born: P.b });
        }
        const r = (k) => hash(v, k, 71);
        const reedy = P.type === 'lily' || P.type === 'lagoon';
        if (reedy && (this.has(q[(i + 1) % 4], 0) || this.has(q[p], 0)) && hash(v, quadId, 72) < 0.55) {
          const spot = lerp2(C[i], Q, 0.62);
          for (let k = 0; k < 3; k++) {
            const pos = offset(spot, hash(v, quadId, 73 + k) * 6.28, 0.05);
            box(pos, POND_Y, POND_Y + 0.2 + hash(v, quadId, 76 + k) * 0.16, 0.012, [1, 0], REED, pm);
          }
        }
        if (this.vertexQuads[v][0] !== q) return;
        const yg = yTop(0);
        if (P.type === 'well') {
          prism(C[i], 0.24, POND_Y, yg + 0.2, 10, STONE, pm, POND_COLORS.well);
          const d = [Math.cos(r(1) * 6.28), Math.sin(r(1) * 6.28)];
          for (const sd of [1, -1]) box([C[i][0] + d[0] * 0.2 * sd, C[i][1] + d[1] * 0.2 * sd], yg + 0.2, yg + 0.62, 0.025, d, WOOD, pm);
          cone(C[i], 0.34, yg + 0.62, yg + 0.86, 4, ROOFS[Math.floor(r(2) * ROOFS.length)], pm, Math.atan2(d[1], d[0]) + Math.PI / 4);
        } else if (P.type === 'basin') {
          if (P.c) fountain(C[i], POND_Y - 0.02, 0.8, pm);
          else if (r(3) < 0.35) lilyPad(offset(C[i], r(4) * 6.28, 0.15), POND_Y, false, pm);
        } else if (P.type === 'lagoon' && P.c) {
          prism(C[i], 0.32, POND_Y - 0.05, POND_Y + 0.07, 7, BANK, pm, GRASS);
          tree(C[i], POND_Y + 0.07, 0.2, pm, r(5));
        } else {
          const pads = 1 + Math.floor(r(6) * 3);
          for (let k = 0; k < pads; k++) lilyPad(offset(C[i], r(7 + k) * 6.28, 0.1 + r(10 + k) * 0.18), POND_Y, r(13 + k) < 0.3, pm);
          if (P.type === 'lagoon' && r(16) < 0.3) {
            R.fx.boats.push({ x: C[i][0], z: C[i][1], yaw: r(17) * 6.28, seed: r(18), born: P.b, y: POND_Y, s: 0.55 });
          }
        }
        if (reedy && !P.c && r(20) < 0.3) duck(offset(C[i], r(21) * 6.28, 0.12), POND_Y, r(22) * 6.28, pm);
      });

      for (let L = 0; L < MAX_LEVEL; L++) {
        const occ = q.map((v) => this.has(v, L));
        if (!occ.some(Boolean)) continue;
        const inf = q.map((v, i) => (occ[i] ? infoOf(v, L).info : null));
        const top = inf.map((I) => !!I && I.t);
        const br = inf.map((I) => !!I && I.br);
        const roofed = inf.map((I) => !!I && I.br && !I.cv && (I.bs === 'c' || !!I.gz));
        // Ridges only join proper roofs; walkways (at floor height) and terraces stay flat.
        // A roof also rises against a taller neighbour (lean-to), so no gutter forms there.
        const ridge = top.map((t, i) => t && !br[i] && !inf[i].tr && !inf[i].cv);
        const up = occ.map((o, i) => o && !top[i]);
        const high = ridge.map((r, i) => r || up[i]);
        const rises = inf.filter((I, i) => ridge[i]).map((I) => I.r);
        const allHigh = high.every(Boolean) && rises.every((r) => r === rises[0]);
        const firstRidge = ridge.indexOf(true);
        // Covered porch under a block hovering over the column
        const porch = inf.map((I, i) => top[i] && !br[i] && !I.tr && !!I.cv && L > 0 && styleOf(I) === 'normal');
        const eaved = inf.map((I, i) => ridge[i] && L > 0 && I.r > 0 && !I.lt);

        for (let i = 0; i < 4; i++) {
          if (!occ[i]) continue;
          const v = q[i], I = inf[i];
          const n = (i + 1) % 4, p = (i + 3) % 4;
          const style = styleOf(I);
          const wallColor = wallColorOf(I, L, style);
          const firstQuad = this.vertexQuads[v][0] === q; // emit per-column extras once
          const topMeta = { kind: 'top', v, L };
          const yt = yTop(L);
          const arc = cornerArc(i, L);
          // Outline of the quadrant's top from M[i] round the quad center to M[p]
          const rim = (hN, hQ, hP) => [[M[i], hN], ...(arc ? arc.pts : [Q]).map((pt) => [pt, hQ]), [M[p], hP]];

          if (top[i] && br[i]) {
            const yd = yBottom(L);
            quad(p3(C[i], yd), p3(M[i], yd), p3(Q, yd), p3(M[p], yd), [0, 1, 0], DECK_TOP, topMeta);
            if (roofed[i]) canopy(v, L, I, q, i, C, M, Q, occ, br, roofed, yd, firstQuad, topMeta);
          } else if (top[i] && I.tr) {
            fanOver(C[i], yt, rim(yt, yt, yt), [0, 1, 0], TERRACE, topMeta);
            if (firstQuad) terraceProps(C[i], yt, v, L, topMeta);
          } else if (porch[i]) {
            // Covered porch under a block hovering over this column
            fanOver(C[i], yt, rim(yt, yt, yt), [0, 1, 0], TERRACE, topMeta);
            if (firstQuad && hash(v, L, 85) < 0.6) plants(C[i], yt, hash(v, L, 86), topMeta);
          } else if (top[i]) {
            // Hip roof: ridge runs along edges shared with same-height neighbours
            const rise = I.r;
            const hC = yt + rise;
            const hN = high[n] ? yt + rise : yt;
            const hP = high[p] ? yt + rise : yt;
            const hQ = allHigh ? yt + rise : yt;
            let color;
            if (L === 0) {
              const type = I.gt;
              if (firstQuad && I.ss) streetString(v, I.ss, topMeta);
              if (type === 'small') {
                const g = hash(v, 11);
                color = g < 0.45 ? PLAZA : GRASS;
                if (g > 0.75 && firstQuad && !I.cv) tree(C[i], yt, 0.26, topMeta, hash(v, 12));
                else if (g < 0.45 && firstQuad && !I.cv) plazaProp(C[i], yt, v, topMeta, 0.5);
              } else if (type === 'dock') {
                color = pickFrom(PLANKS, hash(v, 53));
                if (firstQuad && I.boat) {
                  const [x, z, yaw] = I.boat;
                  R.fx.boats.push({ x, z, yaw, seed: hash(v, 54), born: I.b });
                }
              } else {
                color = type === 'square' ? PLAZA : GRASS;
                if (firstQuad && !I.cv) {
                  const treeChance = { park: 0.55, courtyard: 0.4, square: 0.15 }[type];
                  if (I.gc && type !== 'park') fountain(C[i], yt, type === 'square' ? 1 : 0.7, topMeta);
                  else if (I.gc || hash(v, 12) < treeChance) tree(C[i], yt, 0.22 + hash(v, 13) * 0.1, topMeta, hash(v, 14));
                  else if (type !== 'park') plazaProp(C[i], yt, v, topMeta);
                }
              }
            } else if (I.lt) {
              color = WHITE;
            } else if (allHigh) {
              color = I.gd ? GARDEN : ROOF_FLAT;
            } else {
              color = ROOFS[I.rc ?? I.ci];
            }
            fanOver(C[i], hC, rim(hN, hQ, hP), [0, 1, 0], color, topMeta);
            if (eaved[i]) eaves(i, C, M, Q, occ, eaved, arc, yt, color, topMeta);
            // Rounded caps on the ridge (each half edge C -> M once, from the quadrant it starts
            // in) and on the hip from the apex down to the corner and out to the eave tip
            if (eaved[i] && !allHigh) {
              const cap = color.clone().multiplyScalar(1.06);
              if (ridge[n] && eaved[n] && inf[n].r === rise) ridgeCap([p3(C[i], hC), p3(M[i], hC)], RIDGE_R, cap, topMeta, false);
              // Only a true hip (both edges low) folds along C -> Q; beside a ridge or a taller
              // wall that line lies flat on the roof slope
              if (!high[n] && !high[p]) {
                const pts = [p3(C[i], hC)];
                if (arc) {
                  const k = arc.pts.length >> 1, e = arc.pts[k], en = arc.nrm[k];
                  pts.push(p3(e, yt), p3([e[0] + en[0] * EAVE, e[1] + en[1] * EAVE], yt - EAVE_DROP));
                } else {
                  pts.push(p3(Q, yt));
                  // No eave tip past a corner the diagonal quadrant also reaches
                  const wm = occ[(i + 2) % 4] ? null : !occ[p] ? M[p] : !occ[n] ? M[i] : null;
                  if (wm) {
                    const dl = Math.hypot(Q[0] - C[i][0], Q[1] - C[i][1]) || 1, d = [(Q[0] - C[i][0]) / dl, (Q[1] - C[i][1]) / dl];
                    const wl = Math.hypot(wm[0] - Q[0], wm[1] - Q[1]) || 1, wn = [(wm[1] - Q[1]) / wl, -(wm[0] - Q[0]) / wl];
                    const cos = Math.abs(d[0] * wn[0] + d[1] * wn[1]);
                    const t = Math.min(EAVE * 1.6, EAVE / Math.max(cos, 0.3));
                    pts.push(p3([Q[0] + d[0] * t, Q[1] + d[1] * t], yt - EAVE_DROP));
                  }
                }
                ridgeCap(pts, RIDGE_R, cap, topMeta, true);
              }
            }

            if (firstQuad && I.lt) lighthouseTop(C[i], hC, topMeta);
            // Gold ball on a stem crowning a lone pointed roof
            if (firstQuad && eaved[i] && !allHigh && this.grid.neighbors[v].every((u) => !this.has(u, L))) {
              box(C[i], hC - 0.02, hC + 0.07, 0.012, [1, 0], SLATE, topMeta);
              blob([C[i][0], hC + 0.1, C[i][1]], 0.04, 1, GOLD, topMeta);
            }
            const isRow = I.ut === 'row';
            const dormerQuad = this.vertexQuads[v][Math.floor(this.vertexQuads[v].length / 2)];
            if (isRow && !allHigh && q === dormerQuad && hash(v, L, 41) < 0.8) {
              const dir = [Q[0] - C[i][0], Q[1] - C[i][1]];
              const dl = Math.hypot(dir[0], dir[1]) || 1;
              dormer(lerp2(C[i], Q, 0.5), (hC + hQ) / 2, [dir[0] / dl, dir[1] / dl], wallColor, topMeta);
            }

            if (L > 0 && allHigh && i === firstRidge) {
              if (I.ut && I.gd && hash(quadId, L, 22) < 0.6) {
                blob([Q[0], hQ + 0.1, Q[1]], 0.14, 0.9, pickFrom(LEAVES, hash(quadId, 23)), topMeta);
              } else if (I.ut && !I.gd && hash(quadId, L, 24) < 0.4) {
                box(Q, hQ, hQ + 0.1, 0.1, [1, 0], WHITE, topMeta); // skylight
              }
            }
            const isLandmark = L > 0 && !!I.lm;
            if (isLandmark && firstQuad) landmark(I.lm, C[i], hC, wallColor, topMeta);
            // Chimney on some pitched roofs, sitting on the C-Q diagonal of the quadrant
            const wantsChimney = isRow ? I.ch : hash(v, L, 3) < 0.3;
            if (L > 0 && !allHigh && !isLandmark && rise === ROOF_RISE && firstQuad && wantsChimney) {
              const pos = lerp2(C[i], Q, 0.5);
              const dir = [M[i][0] - C[i][0], M[i][1] - C[i][1]];
              const dl = Math.hypot(dir[0], dir[1]) || 1;
              // Chunky stack in the wall color (brick on pale houses) with a white cap and dark flue
              const d = [dir[0] / dl, dir[1] / dl], yc = hC + 0.06;
              box(pos, (hC + hQ) / 2 - 0.1, yc, 0.095, d, wallColor.r + wallColor.g + wallColor.b > 2.6 ? BRICK : wallColor, topMeta);
              box(pos, yc, yc + 0.05, 0.12, d, WHITE, topMeta);
              noOutline = true;
              box(pos, yc + 0.05, yc + 0.052, 0.065, d, SHADOW, topMeta);
              noOutline = false;
              R.fx.smoke.push({ x: pos[0], y: yc + 0.05, z: pos[1], born: I.b, seed: hash(v, L, 4) });
            }
          }

          // Floating block: walkways get a flat deck underside, blocks on posts a vault over
          // them, blocks held by their neighbours an arch or a corbel
          if (L > 0 && !this.has(v, L - 1)) {
            const bm = { kind: 'bottom', v, L };
            if (br[i]) {
              const yb = yBottom(L) - DECK;
              quad(p3(C[i], yb), p3(M[i], yb), p3(Q, yb), p3(M[p], yb), [0, -1, 0], DECK_TOP.clone().multiplyScalar(0.7), bm);
              if (I.pk) posts(v, L, I, q, i, C, M, Q, inf, yb, wallColor, firstQuad, bm);
              if (I.bu) brackets(L, I, q, i, C, M, Q, yb, bm);
              if (I.sy && firstQuad) tieRods(v, I, yBottom(L), bm);
              seams(v, L, I, q, i, C, M, Q, occ, inf, DECK_TOP.clone().multiplyScalar(0.7), bm);
            } else {
              const yb = yBottom(L);
              const kind = I.pk;
              if (I.bu) {
                quad(p3(C[i], yb), p3(M[i], yb), p3(Q, yb), p3(M[p], yb), [0, -1, 0], WOOD.clone().multiplyScalar(0.7), bm);
                brackets(L, I, q, i, C, M, Q, yb, bm);
              } else if (!kind && I.un.length) {
                // Held by same-level neighbours: a plank ceiling on joists, with struts from
                // the walls below where there are any
                quad(p3(C[i], yb), p3(M[i], yb), p3(Q, yb), p3(M[p], yb), [0, -1, 0], WOOD.clone().multiplyScalar(0.7), bm);
                joists(v, L, I, q, i, C, M, Q, occ, yb, wallColor, firstQuad, bm);
              } else if (!kind) {
                underside(v, L, I.un, q, i, C, M, Q, occ, yb, wallColor, firstQuad, bm);
              } else {
                const flat = kind === 'timber' || kind === 'stem';
                quad(p3(C[i], yb + (flat ? 0 : ARCH_RISE)), p3(M[i], yb), p3(Q, yb), p3(M[p], yb), [0, -1, 0],
                  (kind === 'timber' ? WOOD : wallColor).clone().multiplyScalar(0.7), bm);
                posts(v, L, I, q, i, C, M, Q, inf, yb, wallColor, firstQuad, bm);
              }
              seams(v, L, I, q, i, C, M, Q, occ, inf, wallColor, bm);
            }
          }

          for (const [j, a, b, aIsM] of [[n, M[i], Q, true], [p, Q, M[p], false]]) {
            const dir = [C[j][0] - C[i][0], 0, C[j][1] - C[i][1]];
            const m = { kind: 'wall', v, L, target: q[j] };
            if (!occ[j]) {
              const bank = L === 0 && ['lily', 'lagoon'].includes(units.ponds.get(q[j])?.type);
              const side = bank ? BANK : wallColor;
              const qEnd = arc ? arc.pts[aIsM ? 0 : arc.pts.length - 1] : null;
              wall(a, b, aIsM, dir, v, L, q[j], side, m, style, br[i] && I.bs, top[i] && (I.tr || porch[i]), qEnd);
            } else if (br[j] && !br[i]) {
              // A walkway docks onto this block's floor: the full wall stands above its deck
              wall(a, b, aIsM, dir, v, L, q[j], wallColor, m, style, false, top[i] && (I.tr || porch[i]));
            }
          }
          if (arc) {
            const { pts, nrm } = arc, bands = aoBands(v, L), half = pts.length / 2;
            for (let k = 0; k + 1 < pts.length; k++) {
              const m = { kind: 'wall', v, L, target: q[k < half - 0.5 ? n : p] };
              const h = [nrm[k][0] + nrm[k + 1][0], 0, nrm[k][1] + nrm[k + 1][1]];
              face(pts[k], pts[k + 1], yBottom(L), yt, h, wallColor, m, ...bands);
              if (L === 0) {
                const f = (j, d) => p3([pts[j][0] + nrm[j][0] * d, pts[j][1] + nrm[j][1] * d], 0.02);
                noOutline = true;
                quad(f(k, 0.005), f(k + 1, 0.005), f(k + 1, 0.14), f(k, 0.14), [0, 1, 0], FOAM, m);
                noOutline = false;
              }
            }
          }
          // Where only one of two stacked floors has its corner rounded, a ledge closes the step
          if (!top[i]) {
            const up = cornerArc(i, L + 1);
            if (up && !arc) {
              fanOver(Q, yt, up.pts.map((pt) => [pt, yt]), [0, 1, 0], wallColor, topMeta);
            } else if (arc && !up) {
              const above = wallColorOf(infoOf(v, L + 1).info, L + 1);
              fanOver(Q, yt, arc.pts.map((pt) => [pt, yt]), [0, -1, 0], above.clone().multiplyScalar(0.7), { kind: 'bottom', v, L: L + 1 });
            }
          }
        }

        // Diagonal neighbours only touch at the quad center. Walkways and the waterline get a
        // small joint; between houses each of the two nooks gets its own little scene
        for (const [i, j] of [[0, 2], [1, 3]]) {
          const n = (i + 1) % 4, p = (i + 3) % 4;
          if (!occ[i] || !occ[j] || occ[n] || occ[p] || br[i] !== br[j]) continue;
          const yt = yTop(L);
          const vi = inf[i].b >= inf[j].b ? i : j; // pops in with the later of the two
          const nooks = [[M[i], M[n], q[n]], [M[p], M[j], q[p]]];
          if (br[i] || L === 0) {
            const [yA, yB, w, side, topColor] = br[i]
              ? [yBottom(L) - DECK, yBottom(L), 0.34, DECK_TOP, DECK_TOP]
              : [yt - 0.16, yt - 0.05, 0.42, STONE, PLAZA];
            const tm = { kind: 'top', v: q[vi], L };
            for (const [ma, mb, target] of nooks) {
              const a = lerp2(Q, ma, w), b = lerp2(Q, mb, w);
              const out = [(a[0] + b[0]) / 2 - Q[0], 0, (a[1] + b[1]) / 2 - Q[1]];
              quad(p3(a, yA), p3(b, yA), p3(b, yB), p3(a, yB), out, side, { kind: 'wall', v: q[vi], L, target });
              tri(p3(Q, yB), p3(a, yB), p3(b, yB), [0, 1, 0], topColor, tm);
              tri(p3(Q, yA), p3(a, yA), p3(b, yA), [0, -1, 0], side.clone().multiplyScalar(0.7), { kind: 'bottom', v: q[vi], L });
              fence(lerp2(a, Q, 0.12), lerp2(b, Q, 0.12), yB, WHITE, tm, 0.16);
            }
            if (L === 0 && this.has(q[i], 1) && this.has(q[j], 1) && hash(quadId, 90) < 0.5) {
              // Street lamp on the landing between two houses
              const [ma, mb] = nooks[hash(quadId, 91) < 0.5 ? 0 : 1];
              const pos = lerp2(Q, lerp2(ma, mb, 0.5), 0.14);
              box(pos, yB, yB + 0.6, 0.016, [1, 0], SLATE, tm);
              box(pos, yB + 0.6, yB + 0.7, 0.04, [1, 0], LAMP, tm);
              cone(pos, 0.07, yB + 0.7, yB + 0.78, 4, SLATE, tm, Math.PI / 4);
            }
            continue;
          }
          nooks.forEach(([ai, aj, target], k) => {
            const m = { kind: 'wall', v: q[vi], L, target };
            const s = hash(quadId, L, 92 + k);
            const yb = yBottom(L);
            const pi = (t, y) => p3(lerp2(Q, ai, t), y), pj = (t, y) => p3(lerp2(Q, aj, t), y);
            if (top[i] && top[j]) {
              if (s < 0.55) {
                // Bunting strung between the two eaves
                const at = sagString(pi(0.75, yt - 0.03), pj(0.75, yt - 0.03), 0.07, WHITE, m);
                for (let f = 0; f < 5; f++) {
                  const t0 = 0.12 + f * 0.16, a = at(t0), b = at(t0 + 0.1), c = at(t0 + 0.05);
                  hanging([a, b, [c[0], c[1] - 0.09, c[2]]], pickFrom(UMBRELLAS, hash(quadId, L, 100 + f + k * 7)), m);
                }
              }
            } else if (s < 0.32) {
              // Washing line with laundry
              const at = sagString(pi(0.6, yb + 0.74), pj(0.6, yb + 0.74), 0.05, WHITE, m);
              for (let f = 0; f < 3; f++) {
                const t0 = 0.18 + f * 0.24, a = at(t0), b = at(t0 + 0.13);
                const hgt = 0.1 + hash(quadId, L, 110 + f) * 0.07;
                const col = pickFrom([WHITE, ...WALLS, ...SHUTTERS], hash(quadId, L, 120 + f + k * 5));
                hanging([a, b, [b[0], b[1] - hgt, b[2]], [a[0], a[1] - hgt, a[2]]], col, m);
              }
            } else if (s < 0.52 && L >= 2 && !this.has(target, L - 1)) {
              // Corner balcony filling the nook, railing across its opening
              const ys = yb + 0.05;
              const out = [(ai[0] + aj[0]) / 2 - Q[0], 0, (ai[1] + aj[1]) / 2 - Q[1]];
              tri(p3(Q, ys), p3(ai, ys), p3(aj, ys), [0, 1, 0], WHITE, m);
              tri(p3(Q, yb), p3(ai, yb), p3(aj, yb), [0, -1, 0], WHITE.clone().multiplyScalar(0.7), m);
              quad(p3(ai, yb), p3(aj, yb), p3(aj, ys), p3(ai, ys), out, WHITE, m);
              fence(lerp2(ai, Q, 0.06), lerp2(aj, Q, 0.06), ys, WHITE, m, 0.18);
              if (hash(quadId, L, 96 + k) < 0.6) plants(lerp2(Q, lerp2(ai, aj, 0.5), 0.55), ys, hash(quadId, L, 97), m);
            }
          });
        }
      }
    };

    const cosT = COS_CREASE;
    const records = quads.map((q) => {
      const sig = signature(q);
      if (useCache) {
        const cached = this.cache.get(q);
        if (cached && cached.sig === sig) return cached;
      }
      R = { position: [], normal: [], color: [], aPivot: [], aBorn: [], aGlow: [], aWave: [], normals: [], edgeless: [], meta: [], fx: { smoke: [], lamps: [], boats: [], halos: [], glows: [], flies: [] } };
      emitQuad(q);
      const rec = this.finishRecord(R, q, cosT);
      rec.sig = sig;
      if (useCache) this.cache.set(q, rec);
      return rec;
    });
    if (useCache) this.records = records;
    const fx = { smoke: [], lamps: [], boats: [], halos: [], glows: [], flies: [] };
    for (const r of records) for (const key in fx) fx[key].push(...r.fx[key]);
    return { recOf: new Map(quads.map((q, i) => [q, records[i]])), fx };
  }

  // Concatenate records into one mesh; outlines are their own interior edges, the half-edges
  // merged across the given shared quad edges, and edges standing on the given grid vertices
  assemble(records, quadEdges, vs, recOf, useCache) {
    const cosT = COS_CREASE;
    const geometry = new THREE.BufferGeometry();
    let triCount = 0;
    for (const r of records) triCount += r.meta.length;
    for (const [name, size] of ATTRS) {
      const arr = new Float32Array(triCount * 3 * size);
      let o = 0;
      for (const r of records) { arr.set(r.attrs[name], o); o += r.attrs[name].length; }
      geometry.setAttribute(name, new THREE.BufferAttribute(arr, size));
    }
    const meta = [];
    for (const r of records) for (const m of r.meta) meta.push(m);
    geometry.computeBoundingSphere();

    const lineLists = records.map((r) => r.lines);
    for (const qe of quadEdges) {
      const sides = qe.sides.filter(([q]) => recOf.has(q));
      if (!sides.length) continue;
      const recs = sides.map(([q]) => recOf.get(q));
      const cached = useCache ? this.edgeCache.get(qe.id) : null;
      if (cached && cached.recs.length === recs.length && cached.recs.every((r, i) => r === recs[i])) {
        lineLists.push(cached.lines);
        continue;
      }
      const halves = [];
      sides.forEach(([, e], i) => halves.push(...recs[i].boundary[e]));
      const lines = [];
      pairEdges(halves, cosT, lines);
      if (useCache) this.edgeCache.set(qe.id, { recs, lines });
      lineLists.push(lines);
    }
    for (const v of vs) {
      const recs = this.vertexQuads[v].filter((q) => recOf.has(q)).map((q) => recOf.get(q));
      const cached = useCache ? this.vertexCache.get(v) : null;
      if (cached && cached.recs.length === recs.length && cached.recs.every((r, i) => r === recs[i])) {
        lineLists.push(cached.lines);
        continue;
      }
      const halves = [];
      for (const r of recs) if (r.atVertex.has(v)) halves.push(...r.atVertex.get(v));
      const lines = [];
      pairEdges(halves, cosT, lines);
      if (useCache) this.vertexCache.set(v, { recs, lines });
      lineLists.push(lines);
    }
    return { geometry, lines: linesGeometry(lineLists), meta };
  }

  // Freeze a record's arrays, pair up its own outline edges and sort the rest by the
  // quad edge they lie on, so neighbours can be merged without touching other quads
  finishRecord(R, q, cosT) {
    const attrs = {};
    for (const [name] of ATTRS) attrs[name] = new Float32Array(R[name]);
    const pos = attrs.position;
    const C = q.map((v) => this.grid.verts[v]);
    const rk = (x) => Math.round(x * 1e4);
    const vk = (i) => `${rk(pos[i * 3])},${rk(pos[i * 3 + 1])},${rk(pos[i * 3 + 2])}`;
    const onEdge = (i) => {
      const x = pos[i * 3], z = pos[i * 3 + 2];
      const hits = [];
      for (let e = 0; e < 4; e++) {
        const a = C[e], b = C[(e + 1) % 4];
        const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
        const px = x - a[0], pz = z - a[1];
        const cross = dx * pz - dz * px, dot = dx * px + dz * pz;
        if (Math.abs(cross) < 1e-4 * Math.sqrt(l2) && dot > -1e-6 && dot < l2 + 1e-6) hits.push(e);
      }
      return hits;
    };

    const halves = [];
    const triCount = R.meta.length;
    for (let t = 0; t < triCount; t++) {
      if (R.edgeless[t]) continue;
      for (let e = 0; e < 3; e++) {
        const i0 = t * 3 + e, i1 = t * 3 + ((e + 1) % 3);
        const k0 = vk(i0), k1 = vk(i1);
        halves.push({
          key: k0 < k1 ? `${k0}|${k1}` : `${k1}|${k0}`,
          n: R.normals[t],
          born: attrs.aBorn[i0],
          pos: [pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2], pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]],
          piv: [...attrs.aPivot.subarray(i0 * 3, i0 * 3 + 3), ...attrs.aPivot.subarray(i1 * 3, i1 * 3 + 3)],
          i0, i1,
        });
      }
    }
    const count = new Map();
    for (const h of halves) count.set(h.key, (count.get(h.key) || 0) + 1);
    // Grid vertex a point sits on, or -1: it lies on two of the quad's edges
    const cornerOf = (hits) => (hits.length < 2 ? -1 : q[hits.includes(0) && hits.includes(3) ? 0 : Math.max(...hits)]);
    const inner = [], boundary = [[], [], [], []], atVertex = new Map();
    for (const h of halves) {
      if (count.get(h.key) > 1) { inner.push(h); continue; }
      const e0 = onEdge(h.i0), e1 = onEdge(h.i1);
      const c0 = cornerOf(e0);
      // Edges standing on a grid vertex touch every quad around it: merged per vertex
      if (c0 >= 0 && c0 === cornerOf(e1)) {
        if (!atVertex.has(c0)) atVertex.set(c0, []);
        atVertex.get(c0).push(h);
        continue;
      }
      const shared = e0.filter((e) => e1.includes(e));
      // Along one quad edge: merged with the quad across it. Anything else is only ours.
      if (shared.length === 1) boundary[shared[0]].push(h);
      else inner.push(h);
    }
    const lines = [];
    pairEdges(inner, cosT, lines);

    const box = new THREE.Box3();
    const pt = new THREE.Vector3();
    for (let i = 0; i < pos.length; i += 3) box.expandByPoint(pt.fromArray(pos, i));
    return { attrs, meta: R.meta, fx: R.fx, lines, boundary, atVertex, box };
  }

  // Closest hit against the last cached build; per-quad boxes skip most triangles
  raycast(ray) {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    let best = null;
    for (const r of this.records) {
      if (!r.meta.length || !ray.intersectsBox(r.box)) continue;
      const p = r.attrs.position;
      for (let t = 0; t < r.meta.length; t++) {
        a.fromArray(p, t * 9); b.fromArray(p, t * 9 + 3); c.fromArray(p, t * 9 + 6);
        if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
        const d = hit.distanceTo(ray.origin);
        if (!best || d < best.distance) best = { distance: d, point: hit.clone(), meta: r.meta[t] };
      }
    }
    return best;
  }

  // Triangles of walls that currently face (v, L); kept briefly when a block is added so
  // the neighbours do not show a hole while the new block springs up
  facesTowards(v, L) {
    const out = ATTRS.map(() => []);
    for (const q of this.vertexQuads[v]) {
      const r = this.cache.get(q);
      if (!r) continue;
      r.meta.forEach((m, t) => {
        if (m.kind !== 'wall' || m.target !== v || m.L !== L) return;
        ATTRS.forEach(([name, size], ai) => {
          const src = r.attrs[name];
          for (let j = t * 3 * size; j < (t + 1) * 3 * size; j++) out[ai].push(src[j]);
        });
      });
    }
    if (!out[0].length) return null;
    const g = new THREE.BufferGeometry();
    ATTRS.forEach(([name, size], ai) => g.setAttribute(name, new THREE.Float32BufferAttribute(out[ai], size)));
    g.getAttribute('aBorn').array.fill(-100);
    return g;
  }
}
