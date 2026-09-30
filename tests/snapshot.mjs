// Geometry snapshot: builds a fixed set of towns in Node and fingerprints everything the town
// hands to the renderer, so a refactor can prove it changed nothing.
//   node tests/snapshot.mjs            compare with tests/snapshot.json
//   node tests/snapshot.mjs --update   record the current output as the new baseline
import { register } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

register('./resolve-three.mjs', import.meta.url);
const { generateGrid, mulberry32 } = await import('../grid.js');
const { Town, MAX_LEVEL, PALETTE_SIZE, STYLES, DEFAULT_STYLE } = await import('../town.js');

const here = (f) => new URL(f, import.meta.url);
const fixtures = JSON.parse(readFileSync(here('./fixtures.json'), 'utf8'));

// Same decoding as loadFromHash in main.js, with birth times that depend only on the cell
function decode(hash) {
  const params = new URLSearchParams(hash);
  const seed = Number(params.get('s'));
  const bin = Buffer.from(params.get('t'), 'base64url').toString('latin1');
  const grid = generateGrid({ radius: 5, seed });
  const cells = [];
  for (let i = 0; i + 2 < bin.length; i += 3) {
    const v = (bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1);
    cells.push({ v, L: bin.charCodeAt(i + 2) >> 4, c: bin.charCodeAt(i + 2) & 15 });
  }
  return { grid, cells: cells.sort((a, b) => a.L - b.L) };
}

// Random stress towns: columns of every height, painted and auto colors, and floating blocks
// that have to be carried by posts, brackets or neighbours
function fuzz(seed) {
  const rand = mulberry32(seed);
  const grid = generateGrid({ radius: 5, seed });
  const free = grid.verts.map((p, v) => v).filter((v) => !grid.fixed[v]);
  const cells = [];
  const taken = new Set();
  const put = (v, L, c) => { const k = v * 64 + L; if (!taken.has(k)) { taken.add(k); cells.push({ v, L, c }); } };
  for (let i = 0; i < 70; i++) {
    const v = free[Math.floor(rand() * free.length)];
    const h = Math.floor(rand() * rand() * 7);
    const c = rand() < 0.4 ? 15 : Math.floor(rand() * PALETTE_SIZE);
    for (let L = 0; L <= h; L++) put(v, L, c);
  }
  for (let i = 0; i < 25; i++) {
    const v = free[Math.floor(rand() * free.length)];
    put(v, 1 + Math.floor(rand() * (MAX_LEVEL - 2)), rand() < 0.5 ? 15 : Math.floor(rand() * PALETTE_SIZE));
  }
  return { grid, cells: cells.sort((a, b) => a.L - b.L) };
}

function place(town, grid, { v, L, c }) {
  const born = L * 0.15 + Math.hypot(grid.verts[v][0], grid.verts[v][1]) * 0.04;
  if (c === 15) town.add(v, L, born, null);
  else town.restore({ v, L, color: c, auto: false }, born);
}

function fingerprint(built) {
  const h = createHash('sha256');
  let tris = 0;
  for (const ch of [...built.chunks].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    h.update(`chunk ${ch.id} ${!!ch.empty}\n`);
    if (ch.empty) continue;
    for (const name of Object.keys(ch.geometry.attributes).sort()) {
      const a = ch.geometry.attributes[name].array;
      h.update(name);
      h.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    }
    const e = ch.edges.attributes.position.array;
    h.update(Buffer.from(e.buffer, e.byteOffset, e.byteLength));
    tris += ch.geometry.attributes.position.count / 3;
  }
  h.update(JSON.stringify(built.fx));
  return { hash: h.digest('hex').slice(0, 16), tris };
}

const results = {};
for (const [name, hash] of Object.entries(fixtures)) {
  const { grid, cells } = decode(hash);
  const town = new Town(grid);
  for (const c of cells) place(town, grid, c);
  results[name] = fingerprint(town.buildChunks());
}
for (const seed of [11, 12, 13]) {
  const { grid, cells } = fuzz(seed);
  const town = new Town(grid);
  for (const c of cells) place(town, grid, c);
  results[`fuzz${seed}`] = fingerprint(town.buildChunks());
  // Edit and rebuild incrementally, as the app does after every change
  const rand = mulberry32(seed + 1000);
  for (let i = 0; i < 8; i++) {
    const { v, L } = cells[Math.floor(rand() * cells.length)];
    if (town.has(v, L)) town.remove(v, L);
  }
  const free = grid.verts.map((p, v) => v).filter((v) => !grid.fixed[v]);
  for (let i = 0; i < 8; i++) {
    const v = free[Math.floor(rand() * free.length)];
    let L = 0;
    while (town.has(v, L) && L < MAX_LEVEL - 1) L++;
    place(town, grid, { v, L, c: rand() < 0.5 ? 15 : Math.floor(rand() * PALETTE_SIZE) });
  }
  results[`fuzz${seed}-edited`] = fingerprint(town.buildChunks());
}

// Every other style on a few of the towns
for (const style of Object.keys(STYLES).filter((n) => n !== DEFAULT_STYLE)) {
  for (const [name, { grid, cells }] of [['showcase', decode(fixtures.showcase)], ['seed7', decode(fixtures.seed7)], ['fuzz11', fuzz(11)]]) {
    const town = new Town(grid);
    town.setStyle(style);
    for (const c of cells) place(town, grid, c);
    results[`${style}:${name}`] = fingerprint(town.buildChunks());
  }
}

// Switching style rebuilds every chunk, and switching back gives the original geometry exactly
{
  const base = STYLES[DEFAULT_STYLE];
  STYLES.__test = { ...base, name: '__test', walls: [...base.walls].reverse(), roofs: [...base.roofs].reverse() };
  const { grid, cells } = decode(fixtures.seed1);
  const town = new Town(grid);
  for (const c of cells) place(town, grid, c);
  const before = fingerprint(town.buildChunks()).hash;
  town.setStyle('__test');
  const other = town.buildChunks();
  const allDirty = other.chunks.every((ch) => ch.dirty || ch.empty);
  town.setStyle(DEFAULT_STYLE);
  const back = fingerprint(town.buildChunks()).hash;
  delete STYLES.__test;
  const ok = allDirty && fingerprint(other).hash !== before && back === before;
  console.log(`${ok ? 'ok  ' : 'FAIL'} style switch     rebuilds and switches back exactly`);
  if (!ok) process.exitCode = 1;
}

const file = here('./snapshot.json');
if (process.argv.includes('--update') || !existsSync(file)) {
  writeFileSync(file, JSON.stringify(results, null, 1) + '\n');
  console.log('Snapshot recorded:', Object.keys(results).length, 'towns');
} else {
  const expected = JSON.parse(readFileSync(file, 'utf8'));
  let failed = 0;
  for (const name of new Set([...Object.keys(expected), ...Object.keys(results)])) {
    const a = expected[name], b = results[name];
    const ok = a && b && a.hash === b.hash;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(20)} ${b ? `${b.tris} tris` : 'missing'}${ok || !a ? '' : ` (was ${a.tris})`}`);
  }
  if (failed) { console.log(`${failed} town(s) changed`); process.exit(1); }
  console.log('All towns unchanged');
}
