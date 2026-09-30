// Shared measurements, colors and helpers for building the town's geometry.

import * as THREE from 'three';

export const MAX_LEVEL = 10;
export const BASE_BOTTOM = -0.4;
export const BASE_TOP = 0.3;
export const LEVEL_H = 0.75;
export const ROOF_RISE = 0.6;
export const EAVE = 0.09; // how far roofs overhang the walls
export const EAVE_DROP = 0.07;
export const EAVE_RIM = 0.04;
export const RIDGE_R = 0.03; // radius of the rounded caps along roof ridges and hips
export const CORNER = 0.12; // how far a rounded outer corner reaches along each wall
export const AO_BAND = 0.2; // height of the darker band at a wall's foot or under its eaves
export const AO_FOOT = 0.8;
export const AO_EAVES = 0.84;
export const SPIRE_RISE = 1.3;
export const ARCH_RISE = 0.4;
export const DECK = 0.24;
export const POND_Y = 0.12;

export const PALETTE = ['#f6f3ec', '#fbe6b3', '#f2c85b', '#fcc28d', '#ff9592', '#ffd9e2', '#b0dfa3', '#83e4d5', '#cce9ff'];
export const ROOF_OF = ['#c95a37', '#158374', '#474e55', '#af3d36', '#874465', '#624377', '#b17300', '#335189', '#4978a7'];
export const WALLS = PALETTE.map((c) => new THREE.Color(c));
export const ROOFS = ROOF_OF.map((c) => new THREE.Color(c));
export const STONE = new THREE.Color('#b8a58a');
export const PLAZA = new THREE.Color('#dccfb4');
export const GRASS = new THREE.Color('#9cc27a');
export const ROOF_FLAT = new THREE.Color('#a39a92');
export const GARDEN = new THREE.Color('#86b36a');
export const WINDOW = new THREE.Color('#3b4a5a');
export const CURTAINS = ['#f4eee2', '#f6d9d2', '#e3eef0'].map((c) => new THREE.Color(c));
export const IVY = ['#4f8a45', '#5f9a4c', '#467d3e'].map((c) => new THREE.Color(c));
export const WHITE = new THREE.Color('#f7f4ee');
export const BRICK = new THREE.Color('#8a5a4a');
export const TRUNK = new THREE.Color('#7a5a40');
export const FOAM = new THREE.Color('#d9eff4');
export const WATER = new THREE.Color('#7cc4dc');
export const COPPER = new THREE.Color('#6fae9a');
export const GOLD = new THREE.Color('#e0b84a');
export const SLATE = new THREE.Color('#4e5f78');
export const LH_RED = new THREE.Color('#c9473a');
export const LAMP = new THREE.Color('#fff3b8');
export const LAMP_ORDER = 0.08; // street lamps come on before any window
export const WOOD = new THREE.Color('#7d5f43');
export const PLANKS = ['#b8925f', '#a98556'].map((c) => new THREE.Color(c));
export const DECK_TOP = new THREE.Color('#d8cbb0');
export const SHADOW = new THREE.Color('#4a423c');
export const POND = { lily: '#5c9f86', lagoon: '#62aecb', basin: '#74c0d6', well: '#2f4d5c' };
export const POND_COLORS = Object.fromEntries(Object.entries(POND).map(([k, c]) => [k, new THREE.Color(c)]));
export const BANK = new THREE.Color('#7f8f5a');
export const REED = new THREE.Color('#6b8f4a');
export const LILY = new THREE.Color('#5f9a48');
export const BLOSSOM = new THREE.Color('#f2a7c3');
export const TERRACE = new THREE.Color('#d8b48f');
export const TERRACOTTA = new THREE.Color('#b8643f');
export const UMBRELLAS = ['#e2574c', '#3f7fb5', '#f2c14e', '#f7f4ee'].map((c) => new THREE.Color(c));
export const BLOOMS = ['#e2574c', '#f2a7c3', '#f2c14e', '#7fb865'].map((c) => new THREE.Color(c));
export const LEAVES = ['#6fa35a', '#7fb865', '#5d9150', '#9bc46e'].map((c) => new THREE.Color(c));
export const SHUTTERS = ['#4f7f6a', '#4a6a8f', '#a8553f', '#e8e2d6'].map((c) => new THREE.Color(c));
export const DOORS = ['#6b4632', '#3f5e7a', '#7a3b3b', '#48664a'].map((c) => new THREE.Color(c));

export const ICO = new THREE.IcosahedronGeometry(1, 0).toNonIndexed().attributes.position.array;

export const yBottom = (L) => (L === 0 ? BASE_BOTTOM : BASE_TOP + (L - 1) * LEVEL_H);
export const yTop = (L) => BASE_TOP + L * LEVEL_H;
// Height used for drag-building on a level: water surface for foundations, mid-floor otherwise
export const levelPlaneY = (L) => (L === 0 ? 0 : (yBottom(L) + yTop(L)) / 2);

export function hash(...nums) {
  let h = 2166136261;
  for (const n of nums) {
    h = Math.imul(h ^ (n | 0), 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}
export const pickFrom = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];
