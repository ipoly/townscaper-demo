// Voxel town on the irregular grid.
// Voxels live on grid vertices; geometry is emitted per (quad, level) by looking at
// the 4 corner voxels, like marching squares on the dual grid. Each quad is split into
// 4 quadrants (corner, edge mid, center, edge mid), one per corner voxel.
// Decorations (windows, doors, chimneys, trees...) are picked with a deterministic hash
// so rebuilding the mesh never reshuffles them.
// Geometry is cached per quad and keyed by a signature of everything that feeds it, so
// an edit only re-emits the quads whose inputs actually changed.

import * as THREE from 'three';
import { MAX_LEVEL, ROOF_RISE, EAVE, EAVE_DROP, RIDGE_R, CORNER, SPIRE_RISE, ARCH_RISE, DECK, POND_Y, STONE, PLAZA, GRASS, ROOF_FLAT, GARDEN, WHITE, BRICK, FOAM, GOLD, SLATE, LH_RED, LAMP, WOOD, PLANKS, DECK_TOP, SHADOW, POND_COLORS, BANK, REED, TERRACE, UMBRELLAS, LEAVES, SHUTTERS, yBottom, yTop, hash, pickFrom, PALETTE_SIZE } from './town/constants.js';
import { STYLES, DEFAULT_STYLE } from './town/styles/index.js';
import { Emitter, p3, lerp2, offset } from './town/emitter.js';
import { propParts } from './town/parts/props.js';
import { landmarkParts } from './town/parts/landmarks.js';
import { roofParts } from './town/parts/roofs.js';
import { carryParts } from './town/parts/carry.js';
import { wallParts } from './town/parts/walls.js';

export { MAX_LEVEL, PALETTE_SIZE, levelPlaneY } from './town/constants.js';
export { STYLES, DEFAULT_STYLE } from './town/styles/index.js';

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
    this.colorIndex = new Map(); // cell key -> palette index
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
    this.style = DEFAULT_STYLE; // building style for the whole town, see town/styles
  }

  get kit() { return STYLES[this.style]; }
  // Takes effect on the next build: the style is part of every quad's signature
  setStyle(name) {
    if (!STYLES[name]) throw new Error(`Unknown style ${name}`);
    this.style = name;
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

  // color: palette index, or null to inherit from the block below / pick by hash
  add(v, L, born = -100, color = null) {
    if (!this.canBuild(v, L) || this.has(v, L)) return false;
    const k = this.key(v, L);
    if (color === null) {
      this.autoColor.add(k);
      const below = this.colorIndex.get(this.key(v, L - 1));
      color = L > 1 && below !== undefined ? below : Math.floor(hash(v, 99) * PALETTE_SIZE);
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
    const rowColor = new Map(); // v -> palette index for row houses
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
            for (let s = 0; taken.includes(ci) && s < PALETTE_SIZE; s++) ci = (ci + 4) % PALETTE_SIZE;
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
    const kit = this.kit, WALLS = kit.walls, ROOFS = kit.roofs;
    const signature = (q) => {
      let s = kit.name;
      for (const v of q) {
        s += '|';
        for (let L = 0; L < MAX_LEVEL; L++) if (this.has(v, L)) s += L + infoOf(v, L).json;
        const pond = units.ponds.get(v);
        if (pond) s += 'P' + JSON.stringify(pond);
      }
      return s;
    };

    // --- Per-quad emission, drawn through the emitter into its current record ---
    const E = new Emitter((m) => this.pivot(m.v, m.L), (m) => m.pond ?? infoOf(m.v, m.L).info);
    const { tri, quad, blob, box, prism, cone, ridgeCap, sagString, hanging } = E;
    // Building parts, each made from the tools, the town and the parts made before it
    const ctx = { E, tri, quad, blob, box, prism, cone, bar: E.bar, ridgeCap, sagString, hanging, town: this, kit, verts, units, infoOf };
    for (const make of [propParts, landmarkParts, roofParts, carryParts, wallParts]) Object.assign(ctx, make(ctx));
    const { fountain, tree, fence, plants, streetString, plazaProp, terraceProps, duck, lilyPad, landmark, lighthouseTop, eaves, dormer, canopy, posts, brackets, joists, tieRods, underside, seams, face, aoBands, wall } = ctx;

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
        E.noOutline = true;
        quad(p3(C[i], POND_Y), p3(M[i], POND_Y), p3(Q, POND_Y), p3(M[p], POND_Y), [0, 1, 0], POND_COLORS[P.type], pm);
        E.noOutline = false;
        // Now and then a firefly spot over the pond water at night
        if (hash(v, quadId, 81) < 0.4) {
          const f = lerp2(C[i], Q, 0.5);
          E.R.fx.flies.push({ x: f[0], y: POND_Y, z: f[1], born: P.b });
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
            E.R.fx.boats.push({ x: C[i][0], z: C[i][1], yaw: r(17) * 6.28, seed: r(18), born: P.b, y: POND_Y, s: 0.55 });
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
                  E.R.fx.boats.push({ x, z, yaw, seed: hash(v, 54), born: I.b });
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
              E.noOutline = true;
              box(pos, yc + 0.05, yc + 0.052, 0.065, d, SHADOW, topMeta);
              E.noOutline = false;
              // wake: the earliest switch-on order among the house's floors; half the early risers cook breakfast
              let wake = 0;
              for (let l = 0; l <= L; l++) {
                const o = this.has(v, l) ? infoOf(v, l).info.lit : 0;
                if (o > 0 && (!wake || o < wake)) wake = o;
              }
              E.R.fx.smoke.push({ x: pos[0], y: yc + 0.05, z: pos[1], born: I.b, seed: hash(v, L, 4), wake, breakfast: hash(v, L, 5) < 0.5 });
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
                E.noOutline = true;
                quad(f(k, 0.005), f(k + 1, 0.005), f(k + 1, 0.14), f(k, 0.14), [0, 1, 0], FOAM, m);
                E.noOutline = false;
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
      const R = E.begin();
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
