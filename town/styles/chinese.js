// Southern Chinese water town: whitewashed and earth-toned walls under grey tiles, with a few
// vermilion walls and glazed roofs for temples; lacquered lattice windows backed with paper,
// red studded doors, red lanterns and granite arch bridges, under flared eaves with upturned corners;
// the tower by the water is a pagoda. See european.js for the kit fields.
import * as THREE from 'three';
import { LACQUER, PAPER } from '../constants.js';

// Hue families follow the european slots, so a town keeps its feel when it switches style
const walls = ['#f3f1ec', '#ede3cc', '#e8d4a0', '#ebd2b8', '#c46a58', '#eedcd8', '#d0dcc4', '#c8e0d8', '#d6e0e8'];
const tower = new THREE.Color('#efe8da');
const roofs = ['#596064', '#625d57', '#7a4038', '#5a6066', '#d4b45a', '#57525b', '#4a6e5e', '#466a6c', '#46546f'];

export default {
  name: 'chinese',
  label: 'Chinese',
  palette: { walls, roofs },
  walls: walls.map((c) => new THREE.Color(c)),
  roofs: roofs.map((c) => new THREE.Color(c)),
  trim: LACQUER,
  glass: PAPER,
  lattice: true,
  doors: ['#a3322a', '#8c2a24', '#b8452e', '#5a3426'].map((c) => new THREE.Color(c)),
  studded: true,
  awnings: ['#b3372c', '#3c4a5c', '#6e5a3c'].map((c) => new THREE.Color(c)),
  stripes: false,
  lanterns: 'red',
  stoneBridges: true,
  eaves: { out: 0.17, drop: 0.045, lift: 0.12 },
  squareCorners: true,
  spireRise: 0.8,
  finial: 'gourd',
  dormers: false,
  chimney: { stack: new THREE.Color('#e6e1d6'), cap: new THREE.Color('#44494c') },
  firewalls: { wall: new THREE.Color('#f1efe9'), cap: new THREE.Color('#44494c') },
  tower: { walls: [tower, tower], top: 'pagoda', roof: new THREE.Color('#4f5558'), rise: 0.7 },
};
