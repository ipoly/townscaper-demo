import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { generateGrid, mulberry32 } from './grid.js';
import { Town, MAX_LEVEL, PALETTE_SIZE, STYLES, DEFAULT_STYLE, levelPlaneY } from './town.js';
import { Sfx } from './audio.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Neutral keeps the palette's hues and saturation and only rolls off the brightest light
renderer.toneMapping = THREE.NeutralToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#cfe6ec');
scene.fog = new THREE.Fog('#cfe6ec', 30, 70);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 200);
camera.position.set(14, 16, 18);
// Portrait screens see less of the island sideways: start further out
if (camera.aspect < 1) camera.position.multiplyScalar(Math.min(1.8, 1 / camera.aspect) ** 0.7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.45;
controls.minDistance = 6;
controls.maxDistance = 50;
controls.autoRotateSpeed = 0.5; // a full circle in two minutes (orbit mode)

const hemi = new THREE.HemisphereLight('#fff6e8', '#a89c8a', 1.4);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff1d6', 2.2);
sun.position.set(12, 20, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 60 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const now = () => performance.now() / 1000;
let lastActive = now(); // last input, camera move or town change
const uTime = { value: now() };
const uNight = { value: 0 };
const uRays = { value: 0 }; // dawn light shafts
const uDay = { value: 1 }; // cloud shadows and sea sparkles
const uDusk = { value: 0 }; // sunset glitter on the sea
const uRain = { value: 0 }; // overcast, falling rain, wet town
const uSunDir = { value: new THREE.Vector3() };
// Lit windows switch on in their own order (0 < order <= 1) as uNight rises, so floors light up one by one
const LIGHT_ON = `float lightOn(float order) { return order > 0.0 ? smoothstep(order * 0.5, order * 0.5 + 0.04, uNight) * uNight : 0.0; }`;

// Sky over the town and sea: drifting cloud shadows by day, and on the water sparkles by day and the
// sunset's glitter path at dusk. All of it is a few lines in the existing materials, no extra pass
const SKY_GLSL = `uniform float uTime, uDay, uDusk, uRain;
uniform vec3 uSunDir, uSunColor, uSkyColor;
varying vec3 vWorldPos;
float skyHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float skyNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(skyHash(i), skyHash(i + vec2(1.0, 0.0)), f.x), mix(skyHash(i + vec2(0.0, 1.0)), skyHash(i + vec2(1.0)), f.x), f.y);
}
float cloudShadow(vec2 p) {
  p = p * 0.06 + uTime * vec2(0.035, 0.015);
  float n = skyNoise(p) * 0.65 + skyNoise(p * 2.3 + 7.0) * 0.35;
  return smoothstep(0.5, 0.66, n) * uDay;
}`;
function withSky(material, { water = false } = {}) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, r) => {
    prev?.call(material, shader, r);
    Object.assign(shader.uniforms, { uTime, uDay, uDusk, uRain, uSunDir, uSunColor: { value: sun.color }, uSkyColor: { value: hemi.color } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SKY_GLSL}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
  float shade = 1.0 - 0.45 * cloudShadow(vWorldPos.xz);
  reflectedLight.directDiffuse *= shade;
  reflectedLight.directSpecular *= shade;
}`);
    if (water) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float near = 1.0 - smoothstep(22.0, 40.0, length(cameraPosition - vWorldPos));
  // Day: a few tiny glints that twinkle on and off, out of the cloud shadows
  vec2 sp = vWorldPos.xz * 1.3, cell = floor(sp);
  float h = skyHash(cell);
  vec2 spot = vec2(skyHash(cell + 3.1), skyHash(cell + 5.7)) * 0.6 + 0.2;
  float twinkle = pow(max(0.0, sin(uTime * (1.5 + h * 2.0) + h * 40.0)), 12.0);
  float glint = step(0.82, h) * twinkle * smoothstep(0.1, 0.0, length(fract(sp) - spot));
  totalEmissiveRadiance += vec3(1.0, 0.98, 0.9) * glint * uDay * (1.0 - cloudShadow(vWorldPos.xz)) * near * 2.0;
  // Dusk: a band of light on the sea towards the low sun, broken into fine flickering glitter
  vec3 refl = reflect(-normalize(cameraPosition - vWorldPos), vec3(0.0, 1.0, 0.0));
  float path = pow(max(dot(refl, uSunDir), 0.0), 48.0);
  vec2 gp = vWorldPos.xz * vec2(5.0, 2.5), gcell = floor(gp);
  float gh = skyHash(gcell);
  float flicker = pow(max(0.0, sin(uTime * (2.0 + gh * 3.0) + gh * 60.0)), 4.0);
  float glitter = step(0.4, gh) * flicker * smoothstep(0.35, 0.0, length(fract(gp) - 0.5));
  totalEmissiveRadiance += uSunColor * path * (0.3 + glitter * 6.0) * uDusk * near;
  // Rain: rings spreading from drops, each cell starting a new one at a random spot every second or so
  float rings = 0.0;
  for (int i = 0; i < 2; i++) {
    vec2 rp = vWorldPos.xz * 1.7 + float(i) * 17.3, rc = floor(rp);
    float phase = uTime * 0.9 + skyHash(rc + float(i) * 11.0), cycle = floor(phase), age = fract(phase);
    vec2 c = vec2(skyHash(rc + cycle * 1.7), skyHash(rc + cycle * 3.1 + 8.3)) * 0.5 + 0.25;
    rings += smoothstep(0.035, 0.0, abs(length(fract(rp) - c) - age * 0.25)) * (1.0 - age);
  }
  totalEmissiveRadiance += uSkyColor * rings * uRain * near * 0.3;
}`);
    } else {
      // Wet in the rain: surfaces a little darker, and a sheen of sky on the tops at grazing angles
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
float wetTop = smoothstep(0.35, 0.9, dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)));
diffuseColor.rgb *= 1.0 - 0.15 * uRain;
roughnessFactor = mix(roughnessFactor, 0.45, uRain * wetTop);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += uSkyColor * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 4.0) * wetTop * uRain * 0.4;`);
    }
  };
  // Wrapped callbacks share their source text, so keep the program cache from mixing town and water
  const base = prev?.toString() ?? '';
  material.customProgramCacheKey = () => base + (water ? 'sky-water' : 'sky');
  return material;
}

// Low-poly water: vertices bob in the shader (local z is up), flat shading turns that into facets
const waterMaterial = new THREE.MeshStandardMaterial({ color: '#5aa6c4', roughness: 0.35, metalness: 0.1, flatShading: true });
waterMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = uTime;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uTime;')
    .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
float fade = 1.0 - smoothstep(20.0, 40.0, length(position.xy));
transformed.z += fade * (sin(position.x * 0.8 + uTime * 1.3) * 0.035 + sin(position.y * 1.1 - uTime * 1.1) * 0.03);`);
};
withSky(waterMaterial, { water: true });
const water = new THREE.Mesh(new THREE.PlaneGeometry(160, 160, 140, 140), waterMaterial);
water.rotation.x = -Math.PI / 2;
water.receiveShadow = true;
water.raycast = () => {};
scene.add(water);

// Stars, only visible at night
const starGeo = new THREE.BufferGeometry();
{
  const pts = [], r = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const a = r() * Math.PI * 2, e = 0.12 + r() * 1.3;
    pts.push(Math.cos(a) * Math.cos(e) * 90, Math.sin(e) * 90, Math.sin(a) * Math.cos(e) * 90);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
}
const starMaterial = new THREE.PointsMaterial({ color: '#ffffff', size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0, fog: false });
scene.add(new THREE.Points(starGeo, starMaterial));

// --- Pop animation: every vertex scales around its block's pivot with a damped spring ---
// Town materials also sway hanging cloth and, at night, light up windows and lamps
const POP_DURATION = 0.7;

function withPop(material, { glow = false } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uNight = uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aPivot;
attribute float aBorn;
attribute float aWave;
attribute float aGlow;
varying float vGlow;
uniform float uTime;`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
vGlow = aGlow;
transformed.z += aWave * sin(uTime * 7.0 + aPivot.x * 3.0 - aWave * 2.5) * 0.07;
float popT = (uTime - aBorn) / ${POP_DURATION.toFixed(2)};
if (popT < 1.0) {
  float k = max(popT, 0.0);
  float damp = exp(-6.0 * k);
  float sy = 1.0 - damp * cos(k * 16.0);
  float sxz = 1.0 - damp * cos(k * 16.0 + 1.3);
  if (popT < 0.0) { sy = 0.0; sxz = 0.0; }
  transformed = aPivot + (transformed - aPivot) * vec3(sxz, sy, sxz);
}`);
    if (glow) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vGlow;\nuniform float uNight;\n${LIGHT_ON}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += lightOn(vGlow) * vec3(1.0, 0.68, 0.3) * 1.8;`);
    }
  };
  return material;
}

// Colored shade: part of the sky and ground light is tinted with a deeper version of the surface
// color, so shaded walls stay saturated instead of turning grey (the way painted plaster reads)
const SHADE_TINT = 0.6;
function withColoredShade(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, r) => {
    prev?.call(material, shader, r);
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
  vec3 base = diffuseColor.rgb;
  vec3 tint = min(base * base / max(dot(base, vec3(0.3333)), 1e-3), vec3(1.5));
  reflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, irradiance * RECIPROCAL_PI * tint, ${SHADE_TINT.toFixed(2)});
}`);
  };
  return material;
}

const townMaterial = withSky(withColoredShade(withPop(new THREE.MeshStandardMaterial({
  vertexColors: true, flatShading: true, roughness: 0.85,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
}), { glow: true })));
const townDepthMaterial = withPop(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
const outlineMaterial = withPop(new THREE.LineBasicMaterial({ color: '#6b5446', transparent: true, opacity: 0.3 }));
const ghostMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, depthWrite: false });

// --- Day / dusk / night / dawn ---
const MOODS = [
  { name: 'Day', bg: '#cfe6ec', sky: '#fff6e8', ground: '#a89c8a', hemi: 1.4, sun: '#fff1d6', sunI: 2.2, sunPos: [12, 20, 8], water: '#5aa6c4', night: 0, exp: 1.3, day: 1 },
  { name: 'Dusk', bg: '#f0b48e', sky: '#ffd0a8', ground: '#5a6f8f', hemi: 1.0, sun: '#ff9458', sunI: 1.7, sunPos: [20, 6, 2], water: '#6b8fb2', night: 0.45, exp: 1.2, dusk: 1 },
  { name: 'Night', bg: '#1c2744', sky: '#8492c4', ground: '#26324c', hemi: 1.0, sun: '#aabcff', sunI: 0.7, sunPos: [-10, 18, -6], water: '#1f3654', night: 1, exp: 0.95 },
  // Cool pastel light from the side opposite dusk, a thin mist and a few windows still lit
  { name: 'Dawn', bg: '#e6d4de', sky: '#f2e2f2', ground: '#8a90ad', hemi: 1.25, sun: '#ffc6a0', sunI: 1.5, sunPos: [-18, 6, 6], water: '#8fb2c9', night: 0.15, exp: 1.25, fog: [16, 55], rays: 1 },
];
const FOG = [30, 70];
// The blended mood lives in `look`; applyLook layers the weather over it and writes the scene
const lookOf = (m) => ({
  fog: new THREE.Vector2(...(m.fog ?? FOG)), bg: new THREE.Color(m.bg), sky: new THREE.Color(m.sky), ground: new THREE.Color(m.ground),
  sun: new THREE.Color(m.sun), water: new THREE.Color(m.water), sunPos: new THREE.Vector3(...m.sunPos),
  hemi: m.hemi, sunI: m.sunI, night: m.night, exp: m.exp, rays: m.rays ?? 0, day: m.day ?? 0, dusk: m.dusk ?? 0,
});
const cloneLook = (l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, typeof v === 'number' ? v : v.clone()]));
const look = lookOf(MOODS[0]);
let moodIndex = 0, moodFrom = null, moodTo = null, moodStart = 0, moodEase = 1.6;
function setMood(i, ease = 1.6) {
  moodFrom = cloneLook(look);
  moodTo = lookOf(MOODS[i]);
  moodIndex = i;
  moodStart = now();
  moodEase = ease;
  const btn = document.getElementById('btn-mood');
  for (const svg of btn.querySelectorAll('svg')) svg.toggleAttribute('hidden', svg.dataset.mood !== MOODS[i].name);
  btn.dataset.tip = `${MOODS[i].name} · switch to ${MOODS[(i + 1) % MOODS.length].name} (N)`;
  document.body.classList.toggle('dark', MOODS[i].night > 0.7);
  themeColorEl.content = MOODS[i].bg;
  syncFavicon(MOODS[i].name);
}
// The tab icon follows the time of day too: sky, sea, window, wall and roof recolored, the window lit at dusk and night
const themeColorEl = document.querySelector('meta[name="theme-color"]');
const faviconEl = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
const faviconPngEl = document.querySelector('link[rel="icon"][type="image/png"]');
// A missing icon (or link) only leaves the tab icon as it is, it never stops the app
const faviconSvg = faviconEl ? fetch(faviconEl.href).then((r) => (r.ok ? r.text() : null)).catch(() => null) : Promise.resolve(null);
const FAVICON_DAY = ['#e8f5f6', '#bfe3ea', '#5aa6c4', '#34424f', '#fcc28d', '#af3d36'];
const FAVICON = {
  Dusk: ['#ffd0a8', '#f0b48e', '#6b8fb2', '#ffc861', '#f0a878', '#9c3432'],
  Night: ['#34406a', '#1c2744', '#1f3654', '#ffc861', '#8a7080', '#5e2c3c'],
  Dawn: ['#f2e2f2', '#e6d4de', '#8fb2c9', '#34424f', '#fcc28d', '#af3d36'],
};
async function syncFavicon(name) {
  const svg = await faviconSvg;
  if (!svg) return;
  const colors = FAVICON[name] ?? FAVICON_DAY;
  const url = 'data:image/svg+xml,' + encodeURIComponent(FAVICON_DAY.reduce((out, c, i) => out.replaceAll(c, colors[i]), svg));
  faviconEl.href = url;
  if (!faviconPngEl) return;
  // Browsers that pick the PNG fallback get the same picture, drawn from the SVG
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { return; }
  const canvas = Object.assign(document.createElement('canvas'), { width: 32, height: 32 });
  canvas.getContext('2d').drawImage(img, 0, 0, 32, 32);
  faviconPngEl.href = canvas.toDataURL();
}
function updateMood(t) {
  if (!moodFrom) return false;
  const k = moodEase > 0 ? Math.min(1, (t - moodStart) / moodEase) : 1;
  const e = k * k * (3 - 2 * k);
  for (const key in look) {
    look[key] = typeof look[key] === 'number' ? THREE.MathUtils.lerp(moodFrom[key], moodTo[key], e) : look[key].copy(moodFrom[key]).lerp(moodTo[key], e);
  }
  if (k >= 1) moodFrom = null;
  return true;
}

// --- Rain: an overcast sky over any time of day, eased in and out ---
let raining = false, rainFrom = 0, rainStart = -Infinity, rainEase = 2.5;
const RAIN_FOG = [20, 58];
function setRain(on, ease = 2.5) {
  raining = on;
  rainFrom = uRain.value;
  rainStart = now();
  rainEase = ease;
  const btn = document.getElementById('btn-rain');
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  sfx.setRain(on ? 1 : 0);
}
function updateRain(t) {
  const k = Math.min(1, (t - rainStart) / rainEase);
  if (k >= 1 && uRain.value === +raining) return false;
  uRain.value = THREE.MathUtils.lerp(rainFrom, +raining, k * k * (3 - 2 * k));
  return true;
}
// Overcast colors keep their brightness but lose most of their hue to a cool grey
const tmpColor = new THREE.Color();
function overcast(out, c, r, dim) {
  const l = (c.r * 0.3 + c.g * 0.59 + c.b * 0.11) * dim;
  return out.copy(c).lerp(tmpColor.setRGB(l * 0.94, l * 0.98, l * 1.06), r * 0.8);
}
function applyLook() {
  const r = uRain.value;
  overcast(scene.background, look.bg, r, 0.85);
  scene.fog.color.copy(scene.background);
  // Rain pulls the fog in, but never past a mood that is already misty
  scene.fog.near = Math.min(look.fog.x, THREE.MathUtils.lerp(look.fog.x, RAIN_FOG[0], r));
  scene.fog.far = Math.min(look.fog.y, THREE.MathUtils.lerp(look.fog.y, RAIN_FOG[1], r));
  overcast(hemi.color, look.sky, r, 0.95);
  overcast(hemi.groundColor, look.ground, r, 0.9);
  overcast(sun.color, look.sun, r, 1);
  overcast(waterMaterial.color, look.water, r, 0.8);
  hemi.intensity = look.hemi * (1 + 0.1 * r);
  sun.intensity = look.sunI * (1 - 0.7 * r);
  sun.position.copy(look.sunPos);
  // A dark rainy day switches some lights on; clear-sky effects fade away
  uNight.value = Math.max(look.night, 0.35 * r);
  uRays.value = look.rays * (1 - r);
  uDay.value = look.day * (1 - r);
  uDusk.value = look.dusk * (1 - r);
  renderer.toneMappingExposure = look.exp;
  starMaterial.opacity = (Math.max(0, look.night - 0.4) / 0.6) * (1 - r);
}

// --- Ambient life: lighthouse beams, chimney smoke, boats, seagulls ---
const beamGroup = new THREE.Group();
scene.add(beamGroup);
// Additive cone whose brightness fades from the lamp to the far end (uv.y is 1 at the tip)
const beamMaterial = new THREE.ShaderMaterial({
  uniforms: { opacity: { value: 0 } },
  vertexShader: 'varying float vT; void main() { vT = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform float opacity; varying float vT; void main() { gl_FragColor = vec4(vec3(1.0, 0.93, 0.66) * opacity * pow(vT, 2.2), 1.0); }',
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});
const beamGeometry = new THREE.ConeGeometry(1.1, 9, 16, 1, true).translate(0, -4.5, 0).rotateZ(Math.PI / 2);
let lamps = [];

function syncBeams(list) {
  beamGroup.clear();
  lamps = list.map((l) => {
    const g = new THREE.Group();
    g.position.set(l.x, l.y, l.z);
    for (const s of [0, Math.PI]) {
      const beam = new THREE.Mesh(beamGeometry, beamMaterial);
      beam.rotation.y = s;
      g.add(beam);
    }
    beamGroup.add(g);
    return { g, born: l.born, phase: l.x * 1.7 };
  });
}

// --- Night halos: soft additive glow around lit windows and lamps, drawn as plain geometry ---
const GLOW_COLOR = 'vec3(1.0, 0.72, 0.38)';
const glowFade = `smoothstep(aBorn + 0.4, aBorn + 1.0, uTime) * uNight`;
// Windows: a quad in front of the wall whose brightness falls off with the distance from the pane
const HALO_PAD = 0.22, HALO_OFF = 0.07;
const haloMaterial = new THREE.ShaderMaterial({
  uniforms: { uTime, uNight },
  vertexShader: `attribute vec2 aLocal; attribute vec2 aSize; attribute vec2 aRound; attribute float aBorn, aOrder;
uniform float uTime, uNight;
${LIGHT_ON}
varying vec2 vLocal, vSize, vRound; varying float vFade;
void main() {
  vLocal = aLocal; vSize = aSize; vRound = aRound;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  // Fade out when the wall is seen edge-on, so the flat quad never shows its outline
  float facing = smoothstep(0.05, 0.35, abs(dot(normalize(cameraPosition - wp.xyz), normal)));
  vFade = smoothstep(aBorn + 0.4, aBorn + 1.0, uTime) * lightOn(aOrder) * facing;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
  fragmentShader: `varying vec2 vLocal, vSize, vRound; varying float vFade;
void main() {
  // Signed distance to the pane outline, rounded to match round windows and arches
  float r = vLocal.y > 0.0 ? vRound.y : vRound.x;
  vec2 q = abs(vLocal) - vSize + r;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  // Brightest at the outline, fading out over the wall and dimming smoothly over the pane itself
  float a = d > 0.0 ? pow(1.0 - clamp(d / ${HALO_PAD.toFixed(2)}, 0.0, 1.0), 2.2) : mix(1.0, 0.2, smoothstep(0.0, 0.05, -d));
  gl_FragColor = vec4(${GLOW_COLOR} * a * vFade * 0.45, 1.0);
}`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
});
// Lamps: a round sprite pulled towards the camera so the wall behind does not cut it
const glowMaterial = new THREE.ShaderMaterial({
  uniforms: { uTime, uNight, uScale: { value: 1 } },
  vertexShader: `attribute float aBorn;
uniform float uTime, uNight, uScale;
varying float vFade;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = 0.9 * uScale * projectionMatrix[1][1] / -mv.z;
  mv.xyz += normalize(-mv.xyz) * 0.3;
  vFade = ${glowFade};
  gl_Position = projectionMatrix * mv;
}`,
  fragmentShader: `varying float vFade;
void main() {
  float a = pow(max(0.0, 1.0 - length(gl_PointCoord - 0.5) * 2.0), 2.5);
  gl_FragColor = vec4(${GLOW_COLOR} * a * vFade * 0.8, 1.0);
}`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
});
const halos = new THREE.Mesh(new THREE.BufferGeometry(), haloMaterial);
const glows = new THREE.Points(new THREE.BufferGeometry(), glowMaterial);
for (const o of [halos, glows]) { o.frustumCulled = false; o.raycast = () => {}; scene.add(o); }
const glowScale = () => { glowMaterial.uniforms.uScale.value = renderer.getDrawingBufferSize(new THREE.Vector2()).y / 2; };
glowScale();

function syncHalos(list, lampList) {
  // Both halves of a face report the same window: merge them and average their normals
  const byKey = new Map();
  for (const h of list) {
    const k = `${Math.round(h.x * 100)},${Math.round(h.y * 100)},${Math.round(h.z * 100)}`;
    const o = byKey.get(k);
    if (o) { o.nx += h.nx; o.nz += h.nz; } else byKey.set(k, { ...h });
  }
  const pos = [], nrm = [], local = [], size = [], round = [], order = [], born = [], index = [];
  for (const h of byKey.values()) {
    const nl = Math.hypot(h.nx, h.nz) || 1, nx = h.nx / nl, nz = h.nz / nl;
    const ex = h.hw + HALO_PAD, ey = h.hh + HALO_PAD, base = pos.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(h.x + nx * HALO_OFF - nz * su * ex, h.y + sv * ey, h.z + nz * HALO_OFF + nx * su * ex);
      nrm.push(nx, 0, nz);
      local.push(su * ex, sv * ey);
      size.push(h.hw, h.hh);
      round.push(h.rb, h.rt);
      order.push(h.order);
      born.push(h.born);
    }
    index.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aLocal', new THREE.Float32BufferAttribute(local, 2));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 2));
  g.setAttribute('aRound', new THREE.Float32BufferAttribute(round, 2));
  g.setAttribute('aOrder', new THREE.Float32BufferAttribute(order, 1));
  g.setAttribute('aBorn', new THREE.Float32BufferAttribute(born, 1));
  g.setIndex(index);
  halos.geometry.dispose();
  halos.geometry = g;
  const p = new THREE.BufferGeometry();
  p.setAttribute('position', new THREE.Float32BufferAttribute(lampList.flatMap((l) => [l.x, l.y, l.z]), 3));
  p.setAttribute('aBorn', new THREE.Float32BufferAttribute(lampList.map((l) => l.born), 1));
  glows.geometry.dispose();
  glows.geometry = p;
}

// --- Dawn light shafts: long soft strips slanting in from the sun, turned to face the camera ---
const RAY_COUNT = 9, RAY_LENGTH = 16;
const rayMaterial = new THREE.ShaderMaterial({
  uniforms: { uTime, uRays, uSunDir },
  vertexShader: `attribute vec2 aCorner; attribute vec2 aSeed;
uniform float uTime, uRays; uniform vec3 uSunDir;
varying vec2 vCorner; varying float vFade;
void main() {
  // aCorner.x is the side (-1..1), aCorner.y runs from the ground (0) up towards the sun (1)
  vec3 p = position + uSunDir * aCorner.y * ${RAY_LENGTH.toFixed(1)};
  vec3 side = normalize(cross(uSunDir, cameraPosition - p));
  float width = mix(0.35, 0.9, aSeed.x) * (1.0 + aCorner.y * 0.6);
  p += side * aCorner.x * width;
  vCorner = aCorner;
  vFade = uRays * (0.55 + 0.45 * sin(uTime * 0.35 + aSeed.y * 6.28));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`,
  fragmentShader: `varying vec2 vCorner; varying float vFade;
void main() {
  float across = 1.0 - vCorner.x * vCorner.x;
  float along = smoothstep(0.0, 0.15, vCorner.y) * (1.0 - smoothstep(0.35, 1.0, vCorner.y));
  gl_FragColor = vec4(vec3(1.0, 0.9, 0.74) * across * across * along * vFade * 0.16, 1.0);
}`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});
const rays = new THREE.Mesh(new THREE.BufferGeometry(), rayMaterial);
rays.frustumCulled = false;
rays.raycast = () => {};
scene.add(rays);
const townBox = new THREE.Box3();

// Dawn mist: a few thin layers of drifting noise low over the water, so the shafts have air to light up.
// Stacked thin layers soften the line where the mist meets a wall without needing a depth texture
const MIST_LAYERS = [0.06, 0.22, 0.4, 0.6], MIST_MARGIN = 7;
const mistMaterial = new THREE.ShaderMaterial({
  uniforms: { uTime, uRays, uMistColor: { value: new THREE.Color() } },
  vertexShader: `attribute vec2 aLocal; attribute float aLayer;
varying vec2 vLocal, vWorld; varying float vLayer;
void main() {
  vLocal = aLocal; vWorld = position.xz; vLayer = aLayer;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`,
  fragmentShader: `uniform float uTime, uRays; uniform vec3 uMistColor;
varying vec2 vLocal, vWorld; varying float vLayer;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 p = vWorld * 0.22 + vec2(uTime * 0.025, uTime * 0.012) * (1.0 + vLayer) + vLayer * 7.3;
  float n = noise(p) * 0.6 + noise(p * 2.3 + 4.1) * 0.4;
  float edge = 1.0 - smoothstep(0.55, 1.0, length(vLocal));
  float a = uRays * smoothstep(0.3, 0.8, n) * edge * mix(0.16, 0.07, vLayer / 3.0);
  gl_FragColor = vec4(uMistColor, a);
}`,
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
});
const mist = new THREE.Mesh(new THREE.BufferGeometry(), mistMaterial);
mist.frustumCulled = false;
mist.raycast = () => {};
mist.renderOrder = 1;
scene.add(mist);

// Shafts land at fixed pseudo-random spots over the town's footprint
function syncRays() {
  townBox.setFromObject(townGroup);
  if (townBox.isEmpty()) townBox.set(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 0, 4));
  const pos = [], corner = [], seed = [], index = [];
  for (let i = 0; i < RAY_COUNT; i++) {
    const r = (k) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    const x = THREE.MathUtils.lerp(townBox.min.x, townBox.max.x, r(1)), z = THREE.MathUtils.lerp(townBox.min.z, townBox.max.z, r(2));
    const base = pos.length / 3;
    for (const [sx, t] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
      pos.push(x, 0, z);
      corner.push(sx, t);
      seed.push(r(3), r(4));
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 2));
  g.setIndex(index);
  rays.geometry.dispose();
  rays.geometry = g;

  const cx = (townBox.min.x + townBox.max.x) / 2, cz = (townBox.min.z + townBox.max.z) / 2;
  const hx = (townBox.max.x - townBox.min.x) / 2 + MIST_MARGIN, hz = (townBox.max.z - townBox.min.z) / 2 + MIST_MARGIN;
  const mpos = [], mlocal = [], mlayer = [], mindex = [];
  MIST_LAYERS.forEach((y, k) => {
    const base = mpos.length / 3;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      mpos.push(cx + sx * hx, y, cz + sz * hz);
      mlocal.push(sx, sz);
      mlayer.push(k);
    }
    mindex.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.Float32BufferAttribute(mpos, 3));
  mg.setAttribute('aLocal', new THREE.Float32BufferAttribute(mlocal, 2));
  mg.setAttribute('aLayer', new THREE.Float32BufferAttribute(mlayer, 1));
  mg.setIndex(mindex);
  mist.geometry.dispose();
  mist.geometry = mg;
}

// --- Fireflies: small blinking points wandering over the ponds at night ---
const FLIES_PER_SPOT = 1;
const fireflyMaterial = new THREE.ShaderMaterial({
  uniforms: { uTime, uNight, uScale: glowMaterial.uniforms.uScale },
  vertexShader: `attribute float aBorn; attribute vec3 aSeed;
uniform float uTime, uNight, uScale;
varying float vFade;
void main() {
  // Each fly lives for about a third of its cycle, then fades away and comes back somewhere nearby
  float period = mix(9.0, 16.0, aSeed.x), phase = uTime / period + aSeed.y;
  float cycle = floor(phase), age = fract(phase);
  float life = smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(0.25, 0.38, age));
  vec2 hop = fract(sin(vec2(cycle * 12.99 + aSeed.z * 78.23, cycle * 39.35 + aSeed.x * 11.13)) * 43758.55) - 0.5;
  float t = uTime * (0.5 + 0.4 * aSeed.x) + aSeed.y * 6.28;
  vec3 p = position + vec3(hop.x * 0.5, 0.0, hop.y * 0.5) + vec3(sin(t * 1.3) * 0.28, 0.12 + 0.3 * (0.5 + 0.5 * sin(t * 0.7 + aSeed.z * 6.28)), cos(t * 1.1 + aSeed.z * 3.0) * 0.28);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = 0.24 * uScale * projectionMatrix[1][1] / -mv.z;
  float blink = pow(0.5 + 0.5 * sin(uTime * (1.2 + aSeed.z) + aSeed.x * 20.0), 3.0);
  vFade = smoothstep(0.55, 0.95, uNight) * smoothstep(aBorn + 0.6, aBorn + 1.4, uTime) * life * (0.15 + 0.85 * blink);
  gl_Position = projectionMatrix * mv;
}`,
  fragmentShader: `varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = pow(max(0.0, 1.0 - d), 2.0) + 0.8 * (1.0 - smoothstep(0.1, 0.25, d));
  gl_FragColor = vec4(vec3(0.78, 1.0, 0.42) * a * vFade, 1.0);
}`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
});
const fireflies = new THREE.Points(new THREE.BufferGeometry(), fireflyMaterial);
fireflies.frustumCulled = false;
fireflies.raycast = () => {};
scene.add(fireflies);

function syncFireflies(list) {
  const pos = [], seed = [], born = [];
  list.forEach((f, i) => {
    for (let k = 0; k < FLIES_PER_SPOT; k++) {
      const r = (j) => { const x = Math.sin((i * FLIES_PER_SPOT + k) * 91.7 + j * 47.3 + f.x * 13.1) * 43758.5453; return x - Math.floor(x); };
      pos.push(f.x + (r(1) - 0.5) * 0.3, f.y, f.z + (r(2) - 0.5) * 0.3);
      seed.push(r(3), r(4), r(5));
      born.push(f.born);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 3));
  g.setAttribute('aBorn', new THREE.Float32BufferAttribute(born, 1));
  fireflies.geometry.dispose();
  fireflies.geometry = g;
}

// Rain streaks: short lines falling through a box that wraps around the camera target, one draw
const RAIN_DROPS = 3000, RAIN_W = 44, RAIN_H = 24;
const rainMaterial = new THREE.ShaderMaterial({
  uniforms: { uTime, uRain, uCenter: { value: controls.target }, uColor: { value: new THREE.Color() } },
  vertexShader: `attribute float aTop;
uniform float uTime, uRain;
uniform vec3 uCenter;
varying float vA;
void main() {
  // Falls slightly slanted; the top end trails behind along the same slant
  float y = mod(position.y - uTime * 13.0, ${RAIN_H.toFixed(1)}) - 0.5;
  vec2 xz = mod(position.xz + vec2(0.2, 0.08) * y - uCenter.xz, ${RAIN_W.toFixed(1)}) - ${(RAIN_W / 2).toFixed(1)} + uCenter.xz;
  vec3 p = vec3(xz.x, y, xz.y) + aTop * vec3(0.1, 0.55, 0.04);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vA = (1.0 - aTop) * uRain * smoothstep(-0.5, 0.5, y) * (1.0 - smoothstep(${(RAIN_H - 5).toFixed(1)}, ${(RAIN_H - 1).toFixed(1)}, y)) * (1.0 - smoothstep(18.0, 45.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}`,
  fragmentShader: `uniform vec3 uColor;
varying float vA;
void main() { gl_FragColor = vec4(uColor, vA * 0.7); }`,
  transparent: true, depthWrite: false,
});
const rainLines = new THREE.LineSegments(new THREE.BufferGeometry(), rainMaterial);
{
  const pos = [], top = [], r = mulberry32(11);
  for (let i = 0; i < RAIN_DROPS; i++) {
    const x = r() * RAIN_W, y = r() * RAIN_H, z = r() * RAIN_W;
    pos.push(x, y, z, x, y, z);
    top.push(0, 1);
  }
  rainLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  rainLines.geometry.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1));
}
rainLines.frustumCulled = false;
rainLines.raycast = () => {};
rainLines.visible = false;
scene.add(rainLines);

const SMOKE_MAX = 300;
const smokeMesh = new THREE.InstancedMesh(
  new THREE.IcosahedronGeometry(1, 2),
  new THREE.MeshStandardMaterial({ color: '#fbfaf7', emissive: '#6a6864', roughness: 1, transparent: true, opacity: 0.8 }),
  SMOKE_MAX,
);
smokeMesh.count = 0;
smokeMesh.frustumCulled = false;
scene.add(smokeMesh);
let chimneys = [];
const chimneyNext = new Map(); // position key -> next puff time; survives rebuilds
const puffs = [];
const tmpMat = new THREE.Matrix4(), tmpQuat = new THREE.Quaternion(), tmpPos = new THREE.Vector3(), tmpScale = new THREE.Vector3();

function updateSmoke(t) {
  // Chimneys smoke at dusk when supper is on, and at dawn in half the houses already lit (breakfast).
  // Puffs already out drift away
  const dusk = uDusk.value > 0.5, dawn = uRays.value > 0.5;
  for (const c of chimneys) {
    const key = `${c.x.toFixed(2)},${c.z.toFixed(2)}`;
    const cooking = dusk || (dawn && c.breakfast && c.wake > 0 && uNight.value > c.wake * 0.5 + 0.02);
    if (!cooking) { chimneyNext.delete(key); continue; }
    if (t < c.born + 0.8) continue;
    const next = chimneyNext.get(key) ?? t + c.seed * 1.5;
    if (t >= next) {
      if (puffs.length < SMOKE_MAX) puffs.push({ x: c.x, y: c.y, z: c.z, t0: t, spin: Math.random() * 6 });
      chimneyNext.set(key, t + 1.1 + c.seed * 0.8);
    } else chimneyNext.set(key, next);
  }
  let n = 0;
  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i];
    const a = (t - p.t0) / 3.2;
    if (a >= 1) { puffs.splice(i, 1); continue; }
    // Small round puffs that swell, then shrink away as they drift off
    const s = 0.04 + 0.09 * Math.sin(Math.PI * Math.min(1, a * 1.15));
    tmpPos.set(p.x + a * 0.6, p.y + 0.05 + a * 1.4, p.z + a * 0.25);
    tmpQuat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.spin + a * 2);
    tmpScale.setScalar(Math.max(s, 0.001));
    smokeMesh.setMatrixAt(n++, tmpMat.compose(tmpPos, tmpQuat, tmpScale));
  }
  smokeMesh.count = n;
  smokeMesh.instanceMatrix.needsUpdate = true;
}

const boatGroup = new THREE.Group();
scene.add(boatGroup);
const boats = new Map(); // position key -> { mesh, born, seed }
const HULLS = ['#c9473a', '#3f6f9a', '#f2e6d0', '#4f8a6a', '#e0b84a'].map((c) => new THREE.MeshStandardMaterial({ color: c, flatShading: true }));
const hullGeometry = (() => {
  const s = new THREE.Shape();
  s.moveTo(-0.34, -0.12); s.lineTo(0.18, -0.12); s.lineTo(0.38, 0); s.lineTo(0.18, 0.12); s.lineTo(-0.34, 0.12); s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: 0.13, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, -0.05, 0);
})();
const sailGeometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0.12, 0, 0, 0.62, 0, -0.3, 0.12, 0], 3));
sailGeometry.computeVertexNormals();
const mastGeometry = new THREE.CylinderGeometry(0.012, 0.012, 0.6, 5).translate(0, 0.38, 0);
const sailMaterial = new THREE.MeshStandardMaterial({ color: '#f7f4ee', side: THREE.DoubleSide, flatShading: true });
const mastMaterial = new THREE.MeshStandardMaterial({ color: '#7a5a40' });

function syncBoats(list) {
  const seen = new Set();
  for (const b of list) {
    const key = `${b.x.toFixed(2)},${b.z.toFixed(2)}`;
    seen.add(key);
    if (boats.has(key)) continue;
    const mesh = new THREE.Group();
    const hull = new THREE.Mesh(hullGeometry, HULLS[Math.floor(b.seed * HULLS.length)]);
    hull.castShadow = true;
    mesh.add(hull);
    if (b.seed > 0.4) {
      mesh.add(new THREE.Mesh(mastGeometry, mastMaterial));
      const sail = new THREE.Mesh(sailGeometry, sailMaterial);
      sail.castShadow = true;
      mesh.add(sail);
    }
    mesh.position.set(b.x, b.y ?? 0, b.z);
    mesh.rotation.y = -b.yaw;
    boatGroup.add(mesh);
    boats.set(key, { mesh, born: Math.max(b.born, now()), seed: b.seed, y: b.y ?? 0, size: b.s ?? 1 });
  }
  for (const [key, b] of boats) {
    if (seen.has(key)) continue;
    boatGroup.remove(b.mesh);
    boats.delete(key);
  }
}

function updateBoats(t) {
  for (const b of boats.values()) {
    const k = Math.min(1, Math.max(0, (t - b.born - 0.3) / 0.6));
    const s = k === 0 ? 0.001 : 1 - Math.exp(-6 * k) * Math.cos(k * 14);
    b.mesh.scale.setScalar(s * b.size);
    b.mesh.position.y = b.y + 0.03 + Math.sin(t * 1.6 + b.seed * 20) * 0.025 * b.size;
    b.mesh.rotation.x = Math.sin(t * 1.3 + b.seed * 10) * 0.06;
  }
}

const gulls = [];
{
  const wingGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.06, 0, 0, 0.08, 0.34, 0.02, 0.02], 3));
  wingGeo.computeVertexNormals();
  const gullMat = new THREE.MeshLambertMaterial({ color: '#fbfbf8', side: THREE.DoubleSide });
  const r = mulberry32(99);
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Group();
    const left = new THREE.Mesh(wingGeo, gullMat), right = new THREE.Mesh(wingGeo, gullMat);
    right.scale.x = -1;
    g.add(left, right);
    scene.add(g);
    gulls.push({ g, left, right, R: 5 + r() * 9, h: 6 + r() * 4, speed: (0.12 + r() * 0.12) * (r() < 0.5 ? -1 : 1), phase: r() * 10 });
  }
}

function updateGulls(t) {
  const hide = uNight.value > 0.7;
  for (const s of gulls) {
    s.g.visible = !hide;
    const a = t * s.speed + s.phase;
    s.g.position.set(Math.cos(a) * s.R, s.h + Math.sin(t * 0.7 + s.phase) * 0.5, Math.sin(a) * s.R);
    s.g.rotation.y = -a + (s.speed > 0 ? 0 : Math.PI);
    const flap = Math.sin(t * 7 + s.phase * 3) * 0.55;
    s.left.rotation.z = flap;
    s.right.rotation.z = -flap;
  }
}

// --- World ---
let grid, town, gridLines, seed, townStyle = DEFAULT_STYLE;
// Town meshes per chunk: id -> { mesh, lines }; only chunks an edit touched are replaced
const townGroup = new THREE.Group();
scene.add(townGroup);
let chunkMeshes = new Map(), chunkTown = null;
const undoStack = [], redoStack = [];

function newWorld(worldSeed, fill = seedTown) {
  seed = worldSeed;
  grid = generateGrid({ radius: 5, seed });
  town = new Town(grid);
  town.setStyle(townStyle);
  if (gridLines) { scene.remove(gridLines); gridLines.geometry.dispose(); }
  const pts = [];
  for (const q of grid.quads) {
    for (let i = 0; i < 4; i++) {
      const a = grid.verts[q[i]], b = grid.verts[q[(i + 1) % 4]];
      pts.push(a[0], 0.02, a[1], b[0], 0.02, b[1]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  gridLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.25 }));
  gridLines.raycast = () => {};
  scene.add(gridLines);
  setHover(null);
  undoStack.length = redoStack.length = 0;
  if (fill) fill(seed);
  rebuild();
  syncHistory();
}

// Grow a random blob of houses around the center; they pop in floor by floor
function seedTown(seed) {
  const rand = mulberry32(seed * 7 + 3);
  let start = 0, best = Infinity;
  grid.verts.forEach((p, v) => {
    const d = Math.hypot(p[0], p[1]);
    if (d < best && !grid.fixed[v]) { best = d; start = v; }
  });
  const visited = new Set([start]);
  const frontier = [start];
  while (frontier.length && visited.size < 28) {
    const v = frontier.splice(Math.floor(rand() * frontier.length), 1)[0];
    for (const n of grid.neighbors[v]) {
      if (!visited.has(n) && !grid.fixed[n] && rand() < 0.6) { visited.add(n); frontier.push(n); }
    }
  }
  const t0 = now() + 0.2;
  for (const v of visited) {
    const h = rand() < 0.2 ? 0 : 1 + Math.floor(rand() * rand() * 5);
    const dist = Math.hypot(grid.verts[v][0], grid.verts[v][1]);
    for (let L = 0; L <= h; L++) town.add(v, L, t0 + L * 0.18 + dist * 0.05 + rand() * 0.1);
  }
}

// The first town a visitor sees: a lily pond ringed by garden, a cottage on its bank and a
// lighthouse just off it, the smallest set that shows water, a house and a landmark
const VIEW = [14 / Math.hypot(14, 18), 18 / Math.hypot(14, 18)]; // the opening camera's direction on the ground
function starterTown() {
  const free = (v) => !grid.fixed[v];
  const byDistance = grid.verts.map((p, v) => v).filter(free).sort((a, b) => Math.hypot(...grid.verts[a]) - Math.hypot(...grid.verts[b]));
  const t0 = now() + 0.3;
  const put = (v, L0, L1, delay) => { for (let L = L0; L <= L1; L++) town.add(v, L, t0 + delay + L * 0.18); };
  for (const pond of byDistance) {
    const bank = grid.neighbors[pond];
    if (!bank.every(free)) continue;
    // The cottage sits off to one side of the opening view, not between the camera and the water
    const [px, pz] = grid.verts[pond];
    const toward = (v) => ((grid.verts[v][0] - px) * VIEW[0] + (grid.verts[v][1] - pz) * VIEW[1]);
    const aside = (v) => Math.abs((grid.verts[v][0] - px) * VIEW[1] - (grid.verts[v][1] - pz) * VIEW[0]);
    const cottage = bank.reduce((a, b) => (aside(b) - toward(b) * 0.3 > aside(a) - toward(a) * 0.3 ? b : a));
    // The lighthouse stands apart across the pond from the cottage, so the two read as two buildings
    const apart = (v) => Math.hypot(grid.verts[v][0] - grid.verts[cottage][0], grid.verts[v][1] - grid.verts[cottage][1]);
    const tower = bank.flatMap((b) => grid.neighbors[b])
      .filter((v) => free(v) && v !== pond && !bank.includes(v) && !grid.neighbors[v].includes(cottage) && grid.neighbors[v].filter((u) => free(u) && !bank.includes(u)).length >= 2)
      .sort((a, b) => apart(b) - apart(a))[0];
    if (tower === undefined || Math.hypot(grid.verts[tower][0] - px, grid.verts[tower][1] - pz) < 1) continue;
    bank.forEach((v, i) => put(v, 0, 0, i * 0.08));
    put(cottage, 1, 2, 0.4);
    put(tower, 0, 4, 0.7);
    return;
  }
}

// One of each kind of structure, for checking how blocks are carried: overhangs, arches,
// blocks on posts at every height, long walkways. Each piece gets a clear patch of its own.
const SHOWCASE = [
  // Walkways between two towers: a covered gallery near the water
  { name: 'gallery', len: 8, build: (c) => [[c[0], 0, 1], [c[7], 0, 1], ...c.slice(1, 7).map((v) => [v, 1, 1])] },
  // A walkway hung on tie rods from the towers at its ends
  { name: 'stayed', len: 5, build: (c) => [[c[0], 0, 3], [c[4], 0, 3], ...c.slice(1, 4).map((v) => [v, 1, 1])] },
  // Held by neighbours: a corbel off one wall, an arch between two
  { name: 'corbel', len: 2, build: (c) => [[c[0], 0, 4], [c[1], 3, 4]] },
  { name: 'arch', len: 3, build: (c) => [[c[0], 0, 4], [c[1], 3, 4], [c[2], 0, 4]] },
  // Reaching two cells out: the far one needs a post, the near one leans on it
  { name: 'reach', len: 3, build: (c) => [[c[0], 0, 4], [c[1], 3, 3], [c[2], 3, 3]] },
  // Nothing around: posts all the way down into the sea
  { name: 'lone', len: 1, build: (c) => [[c[0], 3, 4]] },
  // Blocks over their own columns, 1, 2 and 3 empty levels up
  { name: 'gap1', len: 2, wide: true, build: (c) => c.flatMap((v) => [[v, 0, 0], [v, 2, 3]]) },
  { name: 'gap2', len: 2, wide: true, build: (c) => c.flatMap((v) => [[v, 0, 0], [v, 3, 3]]) },
  { name: 'gap3', len: 2, build: (c) => c.flatMap((v) => [[v, 0, 0], [v, 4, 5]]) },
  { name: 'single', len: 1, build: (c) => [[c[0], 0, 0], [c[0], 3, 4]] },
  // Hanging in mid-air with nothing of their own below
  { name: 'slab', len: 3, wide: true, build: (c) => c.map((v) => [v, 2, 2]) },
  { name: 'stack', len: 1, build: (c) => [[c[0], 3, 6]] },
  { name: 'row', len: 4, build: (c) => c.map((v) => [v, 3, 4]) },
  { name: 'skywalk', len: 4, build: (c) => c.map((v) => [v, 4, 4]) },
  // Beside neighbours that do not reach its level: a low house below, a floating house above
  { name: 'overLow', len: 2, build: (c) => [[c[0], 0, 1], [c[1], 3, 4]] },
  { name: 'underHigh', len: 2, build: (c) => [[c[0], 4, 5], [c[1], 2, 2]] },
  // Reaching out three cells from a tower, and a deep overhang two floors thick
  { name: 'reach3', len: 4, build: (c) => [[c[0], 0, 4], [c[1], 3, 3], [c[2], 3, 3], [c[3], 3, 3]] },
  { name: 'overhang', len: 2, wide: true, build: (c) => [[c[0], 0, 5], [c[2], 0, 5], [c[1], 3, 5], [c[3], 3, 5]] },
  // A jetty on brackets off a lower house
  { name: 'jetty', len: 2, build: (c) => [[c[0], 0, 1], [c[1], 2, 2]] },
];

// only: optional piece names, to lay out just those
function showcaseTown(seed, only) {
  const used = new Set();
  const unit = (d) => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; };
  const dirOf = (a, b) => unit([grid.verts[b][0] - grid.verts[a][0], grid.verts[b][1] - grid.verts[a][1]]);
  const along = (v, d, skip) => grid.neighbors[v].filter((u) => !grid.fixed[u] && !skip.includes(u))
    .sort((a, b) => { const da = dirOf(v, a), db = dirOf(v, b); return db[0] * d[0] + db[1] * d[1] - (da[0] * d[0] + da[1] * d[1]); })[0];
  // A run of cells heading around the island, plus a row beside it for the wide pieces
  const layout = (start, piece) => {
    const p = grid.verts[start];
    const d = unit([-p[1], p[0]]);
    const cells = [start];
    while (cells.length < piece.len) {
      const next = along(cells[cells.length - 1], d, cells);
      if (next === undefined) return null;
      cells.push(next);
    }
    if (piece.wide) {
      const out = unit(p);
      for (const v of cells.slice(0, piece.len)) {
        const next = along(v, out, cells);
        if (next === undefined) return null;
        cells.push(next);
      }
    }
    return cells;
  };
  const byDistance = grid.verts.map((p, v) => v).filter((v) => !grid.fixed[v])
    .sort((a, b) => Math.hypot(...grid.verts[a]) - Math.hypot(...grid.verts[b]));
  const t0 = now() + 0.2;
  for (const piece of SHOWCASE.filter((p) => !only || only.includes(p.name))) {
    for (const start of byDistance) {
      if (Math.hypot(...grid.verts[start]) < 1) continue;
      const cells = layout(start, piece);
      if (!cells || cells.some((v) => used.has(v))) continue;
      for (const [v, L0, L1] of piece.build(cells)) {
        const dist = Math.hypot(...grid.verts[v]);
        for (let L = L0; L <= L1; L++) town.add(v, L, t0 + L * 0.15 + dist * 0.04);
      }
      // Keep two free rings around each piece so they read apart
      for (const v of cells) for (const u of grid.neighbors[v]) for (const w of grid.neighbors[u]) used.add(w);
      break;
    }
  }
}

function rebuild() {
  const drop = (id) => {
    const c = chunkMeshes.get(id);
    if (!c) return;
    townGroup.remove(c.mesh, c.lines);
    c.mesh.geometry.dispose();
    c.lines.geometry.dispose();
    chunkMeshes.delete(id);
  };
  if (chunkTown !== town) {
    for (const id of [...chunkMeshes.keys()]) drop(id);
    chunkTown = town;
  }
  const built = town.buildChunks();
  for (const ch of built.chunks) {
    if (!ch.dirty) continue;
    drop(ch.id);
    if (ch.empty) continue;
    const mesh = new THREE.Mesh(ch.geometry, townMaterial);
    mesh.customDepthMaterial = townDepthMaterial;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.raycast = () => {};
    const lines = new THREE.LineSegments(ch.edges, outlineMaterial);
    lines.raycast = () => {};
    townGroup.add(mesh, lines);
    chunkMeshes.set(ch.id, { mesh, lines });
  }
  chimneys = built.fx.smoke;
  syncBeams(built.fx.lamps);
  syncHalos(built.fx.halos, built.fx.glows);
  syncFireflies(built.fx.flies);
  syncRays();
  syncBoats(built.fx.boats);
}

// --- Picking: town triangles via per-quad boxes, water as the y = 0 plane ---
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function pick(clientX, clientY) {
  pointer.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = town.raycast(raycaster.ray);
  if (hit) return hit;
  const point = raycaster.ray.intersectPlane(waterPlane, new THREE.Vector3());
  return point ? { point, meta: null } : null;
}

// Where a left click would build, or null
function buildTarget(hit) {
  if (!hit) return null;
  let v, L;
  const m = hit.meta;
  if (m && m.kind === 'pond') {
    [v, L] = [m.v, 0];
  } else if (m) {
    if (m.kind === 'top') [v, L] = [m.v, m.L + 1];
    else if (m.kind === 'bottom') [v, L] = [m.v, m.L - 1];
    else [v, L] = [m.target, m.L];
  } else {
    let bestD = 1.2;
    v = -1;
    grid.verts.forEach((p, i) => {
      if (grid.fixed[i]) return;
      const d = Math.hypot(p[0] - hit.point.x, p[1] - hit.point.z);
      if (d < bestD) { bestD = d; v = i; }
    });
    if (v < 0) return null;
    L = 0;
  }
  return town.canBuild(v, L) && !town.has(v, L) ? { v, L } : null;
}

// --- Hover preview ---
let ghost = null, ghostKey = null;

function setHover(target) {
  const key = target ? `${target.v}:${target.L}` : null;
  if (key === ghostKey) return;
  ghostKey = key;
  if (ghost) { scene.remove(ghost); ghost.geometry.dispose(); ghost = null; }
  if (!target) return;
  ghost = new THREE.Mesh(town.singleBlockGeometry(target.v, target.L).geometry, ghostMaterial);
  ghost.raycast = () => {};
  ghost.renderOrder = 2;
  scene.add(ghost);
}

// --- Transitions: removed blocks shrink away; faces hidden by a new block linger briefly ---
const dying = [];
const lingering = [];

function spawnDying(v, L) {
  const geometry = town.singleBlockGeometry(v, L).geometry;
  const [px, py, pz] = town.pivot(v, L);
  geometry.translate(-px, -py, -pz);
  const mesh = new THREE.Mesh(geometry, townMaterial);
  mesh.position.set(px, py, pz);
  mesh.raycast = () => {};
  scene.add(mesh);
  dying.push({ mesh, start: now() });
}

function spawnLingering(v, L) {
  const geometry = town.facesTowards(v, L);
  if (!geometry) return;
  const mesh = new THREE.Mesh(geometry, townMaterial);
  mesh.raycast = () => {};
  scene.add(mesh);
  lingering.push({ mesh, until: now() + 0.26 });
}

function updateTransitions(t) {
  for (let i = dying.length - 1; i >= 0; i--) {
    const d = dying[i];
    const k = (t - d.start) / 0.28;
    if (k >= 1) {
      scene.remove(d.mesh);
      d.mesh.geometry.dispose();
      dying.splice(i, 1);
      continue;
    }
    // Back-in easing: a slight swell before collapsing
    const s = 1 - (2.7 * k * k * k - 1.7 * k * k);
    d.mesh.scale.set(s, Math.max(s, 0.001), s);
  }
  for (let i = lingering.length - 1; i >= 0; i--) {
    if (t < lingering[i].until) continue;
    scene.remove(lingering[i].mesh);
    lingering[i].mesh.geometry.dispose();
    lingering.splice(i, 1);
  }
}

// --- Edits, undo / redo ---
// Every edit goes through these so it can be undone and saved; a stroke is one step
const sfx = new Sfx();
let pending = [];
let needsRebuild = false, hoverDirty = false;

function markChanged() { needsRebuild = true; hoverDirty = true; lastActive = now(); }

function addCell(v, L, color) {
  if (!town.canBuild(v, L) || town.has(v, L)) return false;
  spawnLingering(v, L);
  town.add(v, L, now(), color);
  sfx.pop(L);
  pending.push({ op: 'add', data: town.cellData(v, L) });
  markChanged();
  return true;
}

function putCell(data) {
  if (!town.canBuild(data.v, data.L) || town.has(data.v, data.L)) return;
  spawnLingering(data.v, data.L);
  town.restore(data, now());
  sfx.pop(data.L);
  markChanged();
}

function removeCell(v, L, record = true) {
  if (!town.has(v, L)) return false;
  const data = town.cellData(v, L);
  spawnDying(v, L);
  town.remove(v, L);
  sfx.remove();
  if (record) pending.push({ op: 'remove', data });
  markChanged();
  return true;
}

function commit() {
  if (!pending.length) return;
  undoStack.push(pending);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  pending = [];
  scheduleSave();
}

function replay(ops, forward) {
  for (const { op, data } of forward ? ops : [...ops].reverse()) {
    if ((op === 'add') === forward) putCell(data);
    else removeCell(data.v, data.L, false);
  }
  scheduleSave();
}

function undo() {
  commit();
  const ops = undoStack.pop();
  if (!ops) return;
  replay(ops, false);
  redoStack.push(ops);
  syncHistory();
}

function redo() {
  const ops = redoStack.pop();
  if (!ops) return;
  replay(ops, true);
  undoStack.push(ops);
  syncHistory();
}

// --- Save / share: the grid seed plus every cell, packed into the URL hash ---
let saveTimer = 0;
function scheduleSave() {
  syncHistory();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => history.replaceState(null, '', '#' + encodeTown()), 250);
}

// 3 bytes per cell: vertex (16 bits), level (4 bits), color (4 bits, 15 = auto)
function encodeTown() {
  let bin = '';
  for (const k of town.cells) {
    const d = town.cellData(Math.floor(k / 64), k % 64);
    bin += String.fromCharCode(d.v >> 8, d.v & 255, (d.L << 4) | (d.auto ? 15 : d.color));
  }
  const packed = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `s=${seed}&t=${packed}` + (townStyle === DEFAULT_STYLE ? '' : `&style=${townStyle}`);
}

function loadFromHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const s = Number(params.get('s'));
  if (!params.has('s') || !Number.isInteger(s)) return false;
  let bin;
  try { bin = atob((params.get('t') || '').replace(/-/g, '+').replace(/_/g, '/')); } catch { return false; }
  townStyle = STYLES[params.get('style')] ? params.get('style') : DEFAULT_STYLE;
  syncStyle();
  newWorld(s, null);
  const t0 = now() + 0.2;
  const cells = [];
  for (let i = 0; i + 2 < bin.length; i += 3) {
    const v = (bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1);
    const L = bin.charCodeAt(i + 2) >> 4, c = bin.charCodeAt(i + 2) & 15;
    if (v < grid.verts.length && L < MAX_LEVEL && (c === 15 || c < PALETTE_SIZE)) cells.push({ v, L, c });
  }
  // Lower floors first so auto colors inherit the same way they did when built
  cells.sort((a, b) => a.L - b.L);
  for (const { v, L, c } of cells) {
    const dist = Math.hypot(grid.verts[v][0], grid.verts[v][1]);
    const born = t0 + L * 0.15 + dist * 0.04;
    if (c === 15) town.add(v, L, born, null);
    else town.restore({ v, L, color: c, auto: false }, born);
  }
  rebuild();
  return true;
}

const toastEl = document.getElementById('toast');
let toastTimer = 0;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

async function share() {
  commit();
  clearTimeout(saveTimer);
  history.replaceState(null, '', '#' + encodeTown());
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied');
  } catch {
    toast('Link is in the address bar');
  }
}

// --- Screenshot ---
// A clean frame without the grid and hover preview, rendered at a higher pixel ratio for a sharp
// picture and read back in the same task as the render, while the drawing buffer still holds it.
// Phones get the share sheet (save to Photos), others a download.
const coarse = matchMedia('(hover: none) and (pointer: coarse)');
function shotRatio() {
  const gl = renderer.getContext();
  const max = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
  return Math.min(coarse.matches ? 2 : 3, max / Math.max(innerWidth, innerHeight));
}
function screenshot() {
  const hidden = [gridLines, ghost].filter((o) => o && o.visible);
  for (const o of hidden) o.visible = false;
  const ratio = renderer.getPixelRatio();
  renderer.setPixelRatio(Math.max(ratio, shotRatio()));
  glowScale();
  renderer.render(scene, camera);
  renderer.domElement.toBlob(async (blob) => {
    if (!blob) return toast('Could not take a picture');
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const name = `town-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (coarse.matches && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch {}
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Picture saved');
  }, 'image/png');
  for (const o of hidden) o.visible = true;
  // Back to the screen size, redrawn at once so the resized canvas never shows up blank
  renderer.setPixelRatio(ratio);
  glowScale();
  renderer.render(scene, camera);
  sfx.shutter();
  flashEl.classList.remove('flash');
  void flashEl.offsetWidth; // restart the animation
  flashEl.classList.add('flash');
}
const flashEl = document.getElementById('flash');

// --- Orbit mode: after a while without input (or with O) the UI steps aside, the camera circles
// the town and the time of day and weather move on by themselves. A press or key brings it back ---
const ORBIT_AFTER = 30, ORBIT_STEP = 25; // idle seconds before it starts, seconds per time of day
let orbiting = false, lastInput = now(), orbitNext = 0, gridWasOn = true, swallowUp = false;
function setOrbit(on) {
  if (on === orbiting) return;
  orbiting = on;
  document.documentElement.classList.toggle('orbit', on);
  syncCursor();
  controls.autoRotate = on;
  lastInput = now();
  if (on) {
    gridWasOn = gridLines.visible;
    gridLines.visible = false;
    setHover(null);
    orbitNext = now() + ORBIT_STEP;
  } else {
    gridLines.visible = gridWasOn;
  }
}
function updateOrbit(t) {
  if (!orbiting) {
    if (t - lastInput > ORBIT_AFTER && !stroke) setOrbit(true);
    return;
  }
  if (t < orbitNext) return;
  orbitNext = t + ORBIT_STEP;
  setMood((moodIndex + 1) % MOODS.length, 6);
  // Now and then the weather turns; showers clear up more readily than they start
  if (Math.random() < (raining ? 0.5 : 0.25)) setRain(!raining, 6);
}
// A press, wheel or key wakes the town and only wakes it: no block, no zoom, no shortcut. Just moving
// the mouse lets it keep circling, though it still counts as being around
for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) {
  addEventListener(type, (e) => {
    lastInput = now();
    if (!orbiting || type === 'pointermove') return;
    setOrbit(false);
    e.stopPropagation();
    if (type === 'pointerdown') swallowUp = true;
  }, { capture: true });
}
addEventListener('pointerup', (e) => {
  if (!swallowUp) return;
  swallowUp = false;
  e.stopPropagation();
}, { capture: true });
// Coming back to a hidden tab is not the same as leaving it alone
document.addEventListener('visibilitychange', () => { lastInput = now(); });


// --- Input ---
// Left click/drag: build on the level of the first block of the stroke; occupied cells stack upwards
// Shift + left drag: remove on one level · Right click: remove · Right drag: orbit · Middle drag: pan
// Trackpads have no middle button and right drags are awkward there, so Option + drag orbits and
// Cmd + drag or Space + drag pans too
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
let spaceHeld = false;
function cameraDrag(e) {
  return e.pointerType !== 'touch' && e.button === 0 && (e.altKey || e.metaKey || spaceHeld);
}
// Set before OrbitControls reads the press. It turns a rotate into a pan when Cmd is held
addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return;
  controls.mouseButtons.LEFT = !cameraDrag(e) ? null : e.altKey || e.metaKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
}, { capture: true });
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  e.preventDefault();
  spaceHeld = true;
  syncCursor();
});
addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceHeld = false; syncCursor(); } });
addEventListener('blur', () => { spaceHeld = false; });
let downAt = null, lastMove = null;
let stroke = null; // { mode: 'build' | 'erase', L, last: [x, y], lastV, dragging }
controls.addEventListener('change', () => { hoverDirty = true; });

const levelPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const planeHit = new THREE.Vector3();

// Nearest buildable vertex under the cursor, projected onto the horizontal plane of level L
function vertexOnLevel(x, y, L) {
  pointer.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  levelPlane.constant = -levelPlaneY(L);
  if (!raycaster.ray.intersectPlane(levelPlane, planeHit)) return -1;
  let best = -1, bestD = 0.9;
  grid.verts.forEach((p, i) => {
    if (grid.fixed[i]) return;
    const d = Math.hypot(p[0] - planeHit.x, p[1] - planeHit.z);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function strokeAt(x, y) {
  if (stroke.mode === 'build') {
    // Walk from the previous cell to the target one grid neighbour at a time, so a jump in the
    // level-plane projection (e.g. to the diagonal corner) fills the connecting cells instead of
    // placing a detached block or stalling the stroke
    const v = vertexOnLevel(x, y, stroke.L);
    if (v < 0 || v === stroke.lastV) return;
    const [tx, tz] = grid.verts[v];
    // Hysteresis: jitter on the border between two cells must not keep stacking both of them
    const [lx, lz] = grid.verts[stroke.lastV];
    if (Math.hypot(lx - planeHit.x, lz - planeHit.z) - Math.hypot(tx - planeHit.x, tz - planeHit.z) < 0.15) return;
    for (let n = 0; n < 4 && stroke.lastV !== v; n++) {
      const [px, pz] = grid.verts[stroke.lastV];
      let next = -1, bestD = Math.hypot(tx - px, tz - pz);
      for (const u of grid.neighbors[stroke.lastV]) {
        if (grid.fixed[u]) continue;
        const d = Math.hypot(tx - grid.verts[u][0], tz - grid.verts[u][1]);
        if (d < bestD) { bestD = d; next = u; }
      }
      if (next < 0) return;
      // An occupied cell grows upwards: stack on the first free level of its column
      let L = stroke.L;
      while (town.has(next, L)) L++;
      addCell(next, L, selectedColor);
      stroke.lastV = next;
    }
  } else {
    const hit = pick(x, y);
    if (hit && hit.meta && hit.meta.L === stroke.L) removeCell(hit.meta.v, hit.meta.L);
  }
}

function beginStroke(x, y, erase) {
  const hit = pick(x, y);
  if (erase) {
    if (hit && hit.meta) {
      removeCell(hit.meta.v, hit.meta.L);
      stroke = { mode: 'erase', L: hit.meta.L };
    }
  } else {
    const target = buildTarget(hit);
    if (target) {
      addCell(target.v, target.L, selectedColor);
      stroke = { mode: 'build', L: target.L, lastV: target.v };
    }
  }
  if (stroke) stroke.last = [x, y];
  return !!stroke;
}
function continueStroke(x, y) {
  // Sample along the pointer path so fast drags do not skip cells
  const [lx, ly] = stroke.last;
  const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / 6));
  for (let s = 1; s <= steps; s++) strokeAt(lx + ((x - lx) * s) / steps, ly + ((y - ly) * s) / steps);
  stroke.last = [x, y];
}
function endStroke() {
  if (!stroke) return;
  stroke = null;
  commit();
}

// Touch: tap builds, long press removes, one finger orbits and two fingers pan / zoom.
// With the brush or eraser tool on, one finger paints instead and two fingers orbit / zoom.
let touchTool = null; // null | 'brush' | 'erase'
const touchIds = new Set();
let touch = null; // { x, y, moved, done, timer } for the single finger down
function setTouchTool(tool) {
  touchTool = touchTool === tool ? null : tool;
  controls.touches = touchTool
    ? { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE }
    : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  for (const [id, t] of [['btn-brush', 'brush'], ['btn-erase', 'erase']]) {
    const el = document.getElementById(id);
    el.classList.toggle('on', touchTool === t);
    el.setAttribute('aria-pressed', touchTool === t);
  }
}
setTouchTool(null);
function cancelTouch() {
  if (touch) clearTimeout(touch.timer);
  touch = null;
}
function touchDown(e) {
  touchIds.add(e.pointerId);
  if (touchIds.size > 1) {
    // A second finger turns the gesture into camera control
    cancelTouch();
    endStroke();
    return;
  }
  touch = { x: e.clientX, y: e.clientY, moved: false, done: false };
  if (!touchTool) {
    touch.timer = setTimeout(() => {
      if (!touch || touch.moved) return;
      touch.done = true;
      const hit = pick(touch.x, touch.y);
      if (hit && hit.meta && removeCell(hit.meta.v, hit.meta.L)) {
        commit();
        navigator.vibrate?.(15);
      }
    }, 450);
  }
}
function touchMove(e) {
  if (!touch || touchIds.size > 1) return;
  if (!touch.moved && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) < 10) return;
  touch.moved = true;
  clearTimeout(touch.timer);
  if (!touchTool) return;
  // Painting starts where the finger went down, once it is clearly a one-finger drag
  if (!stroke && !touch.done) {
    touch.done = true;
    if (!beginStroke(touch.x, touch.y, touchTool === 'erase')) return;
    stroke.dragging = true;
  }
  if (stroke) continueStroke(e.clientX, e.clientY);
}
function touchUp(e) {
  touchIds.delete(e.pointerId);
  if (stroke) { endStroke(); return; }
  if (touch && !touch.moved && !touch.done && e.type === 'pointerup') {
    if (beginStroke(touch.x, touch.y, touchTool === 'erase')) endStroke();
  }
  cancelTouch();
}

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
// iOS still shows the selection loupe on a long press unless the native touch is cancelled
renderer.domElement.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
// WebKit only grants audio activation on touchend / click, not on pointerdown
for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) {
  addEventListener(type, () => sfx.ensure(), { capture: true, passive: true });
}
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') { touchDown(e); return; }
  downAt = [e.clientX, e.clientY];
  if (e.button !== 0 || cameraDrag(e)) return;
  if (beginStroke(e.clientX, e.clientY, e.shiftKey)) renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') { touchMove(e); return; }
  lastMove = [e.clientX, e.clientY, e.buttons];
  hoverDirty = true;
  if (!stroke) return;
  // A click that wobbles a few pixels is still a click, not a drag
  if (!stroke.dragging && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 8) return;
  stroke.dragging = true;
  continueStroke(e.clientX, e.clientY);
});
renderer.domElement.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'touch') return;
  lastMove = null;
  setHover(null);
});
renderer.domElement.addEventListener('pointercancel', (e) => { if (e.pointerType === 'touch') touchUp(e); });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') { touchUp(e); return; }
  if (stroke) { endStroke(); return; }
  if (e.button !== 2 || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const hit = pick(e.clientX, e.clientY);
  if (hit && hit.meta && removeCell(hit.meta.v, hit.meta.L)) commit();
});

// Trackpad: two-finger scroll orbits and a pinch zooms, while a notched mouse wheel still zooms.
// A scroll is classified on its first event and keeps that until it pauses; the help card can
// pin it to one or the other where the guess goes wrong (smooth mouse wheels)
const SCROLL_MODES = ['auto', 'orbit', 'zoom'], SCROLL_GAP = 250, SCROLL_ORBIT_SPEED = 0.6;
let scrollMode = (() => { try { return localStorage.getItem('ts-scroll'); } catch { return null; } })();
if (!SCROLL_MODES.includes(scrollMode)) scrollMode = 'auto';
let scrollKind = null, scrollLast = -Infinity, pinching = false, pinchScale = 1;
function wheelKind(e) {
  if (e.ctrlKey) return 'zoom'; // pinches arrive as wheel events with Ctrl held
  if (scrollMode !== 'auto') return scrollMode;
  if (e.deltaMode !== 0) return 'zoom';
  if (e.deltaX !== 0) return 'orbit';
  // Notched wheels step by 120 in the legacy delta; trackpads report three times the pixel delta
  if (e.wheelDeltaY) return e.wheelDeltaY % 120 === 0 ? 'zoom' : 'orbit';
  return Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50 ? 'zoom' : 'orbit';
}
document.addEventListener('wheel', (e) => {
  if (e.target !== renderer.domElement) return;
  if (pinching && e.ctrlKey) { e.preventDefault(); e.stopPropagation(); return; }
  const t = performance.now();
  if (t - scrollLast > SCROLL_GAP || (e.ctrlKey && scrollKind !== 'zoom')) scrollKind = wheelKind(e);
  scrollLast = t;
  if (scrollKind !== 'orbit') return; // OrbitControls zooms
  e.preventDefault();
  e.stopPropagation();
  // Same feel as dragging: the view follows the fingers
  const k = (2 * Math.PI * SCROLL_ORBIT_SPEED) / renderer.domElement.clientHeight;
  controls._rotateLeft(-e.deltaX * k);
  controls._rotateUp(-e.deltaY * k);
}, { capture: true, passive: false });
// Safari sends trackpad pinches as gesture events instead, and zooms the whole page unless stopped.
// iOS sends them for touch pinches too, which OrbitControls already zooms from the touches
const fingers = new Set();
addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') fingers.add(e.pointerId); }, { capture: true });
for (const type of ['pointerup', 'pointercancel']) addEventListener(type, (e) => fingers.delete(e.pointerId), { capture: true });
document.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  if (fingers.size) return;
  lastInput = now();
  if (orbiting) setOrbit(false);
  pinching = true;
  pinchScale = 1;
});
document.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (!pinching || !e.scale) return;
  controls._dollyOut(e.scale / pinchScale);
  pinchScale = e.scale;
});
document.addEventListener('gestureend', (e) => { e.preventDefault(); pinching = false; });
function syncScrollMode() {
  const el = document.getElementById('btn-scroll');
  el.textContent = { auto: 'Auto', orbit: 'Orbit', zoom: 'Zoom' }[scrollMode];
  el.setAttribute('aria-label', `Two-finger scroll: ${el.textContent}`);
}
function nextScrollMode() {
  scrollMode = SCROLL_MODES[(SCROLL_MODES.indexOf(scrollMode) + 1) % SCROLL_MODES.length];
  try { localStorage.setItem('ts-scroll', scrollMode); } catch {}
  syncScrollMode();
}
syncScrollMode();

// --- Color palette: "auto" inherits from the block below, otherwise paints new blocks ---
let selectedColor = null;
const paletteEl = document.getElementById('palette');
// Swatches show each color pair as it looks in the daytime sun, roof over wall: rendered once
// through the town's material, lights and tone mapping, and read back before the next frame.
// `up` tilts the surface towards the sky (0 for a wall, 1 for a 45 degree roof)
function litColors(colors, up) {
  const day = MOODS[0], s = new THREE.Scene();
  s.add(new THREE.HemisphereLight(day.sky, day.ground, day.hemi));
  const light = new THREE.DirectionalLight(day.sun, day.sunI);
  light.position.fromArray(day.sunPos);
  s.add(light);
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  cam.position.set(14, 16, 18).setLength(6);
  cam.lookAt(0, 0, 0);
  const geo = new THREE.PlaneGeometry(4, 4), attr = new THREE.Float32BufferAttribute(new Float32Array(12), 3);
  geo.setAttribute('color', attr);
  const mat = withColoredShade(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }));
  const mesh = new THREE.Mesh(geo, mat);
  s.add(mesh);
  const gl = renderer.getContext(), px = new Uint8Array(4), size = renderer.getDrawingBufferSize(new THREE.Vector2());
  mesh.lookAt(day.sunPos[0], up * Math.hypot(day.sunPos[0], day.sunPos[2]), day.sunPos[2]);
  const out = colors.map((hex) => {
    const c = new THREE.Color(hex);
    for (let i = 0; i < 4; i++) attr.setXYZ(i, c.r, c.g, c.b);
    attr.needsUpdate = true;
    renderer.render(s, cam);
    gl.readPixels(size.x >> 1, size.y >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return `rgb(${px[0]}, ${px[1]}, ${px[2]})`;
  });
  geo.dispose();
  mat.dispose();
  return out;
}
// Each style's swatch colors, rendered the first time it is shown
const litCache = new Map();
function litOf(name) {
  if (!litCache.has(name)) {
    const { walls, roofs } = STYLES[name].palette;
    litCache.set(name, { walls: litColors(walls, 0), roofs: litColors(roofs, 1) });
  }
  return litCache.get(name);
}
let LIT, LIT_ROOF;
const swatches = [null, ...Array.from({ length: PALETTE_SIZE }, (_, i) => i)].map((idx, n) => {
  const el = document.createElement('button');
  el.className = 'swatch' + (idx === null ? ' auto' : '');
  el.dataset.tip = idx === null ? 'Auto color (0)' : `Color ${n} (${n})`;
  el.setAttribute('aria-label', idx === null ? 'Auto color' : `Color ${n}`);
  el.onclick = () => selectColor(idx);
  paletteEl.appendChild(el);
  return { el, idx };
});
// --- Canvas cursor: a dab of the paint in hand (roof over wall, like its swatch), a ring while
// Shift erases, a grabbing hand while the view is dragged and a faint ring while orbiting.
// Native cursors from SVG, so they never lag behind the mouse ---
let cursorShift = false, cursorGrab = false;
const svgUrl = (body, scale) => `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${24 * scale}' height='${24 * scale}' viewBox='0 0 24 24'>${body}</svg>`)}")`;
const DAB_SHADOW = "<circle cx='12' cy='13' r='8.5' fill='rgba(0,0,0,0.22)'/>";
function dabBody() {
  let paint;
  if (selectedColor === null) {
    // Auto: a little color wheel of the palette
    const hues = [1, 2, 3, 4, 5, 8, 7, 6].map((i) => LIT[i]);
    paint = hues.map((c, i) => {
      const a0 = (i / hues.length) * 2 * Math.PI, a1 = ((i + 1) / hues.length) * 2 * Math.PI;
      const pt = (a) => `${(12 + 7 * Math.sin(a)).toFixed(2)} ${(12 - 7 * Math.cos(a)).toFixed(2)}`;
      return `<path d='M12 12L${pt(a0)}A7 7 0 0 1 ${pt(a1)}Z' fill='${c}'/>`;
    }).join('');
  } else {
    paint = `<circle cx='12' cy='12' r='7' fill='${LIT[selectedColor]}'/><path d='M5 11A7 7 0 0 1 19 11Z' fill='${LIT_ROOF[selectedColor]}'/>`;
  }
  return `${DAB_SHADOW}<circle cx='12' cy='12' r='8.5' fill='#fff'/>${paint}`;
}
const ERASE_BODY = `${DAB_SHADOW}<circle cx='12' cy='12' r='7.5' fill='none' stroke='#fff' stroke-width='3'/>
  <circle cx='12' cy='12' r='7.5' fill='none' stroke='#d9534f' stroke-width='1.5'/><path d='M8.5 12h7' stroke='#d9534f' stroke-width='2' stroke-linecap='round'/>`;
const ORBIT_BODY = "<circle cx='12' cy='12' r='7' fill='rgba(255,255,255,0.18)' stroke='rgba(255,255,255,0.7)' stroke-width='1.5'/>";
function syncCursor() {
  const el = renderer.domElement;
  if (cursorGrab) { el.style.cursor = 'grabbing'; return; }
  if (spaceHeld) { el.style.cursor = 'grab'; return; }
  const body = orbiting ? ORBIT_BODY : cursorShift ? ERASE_BODY : dabBody();
  el.style.cursor = `${svgUrl(body, 1)} 12 12, crosshair`;
  // Sharp on high-density screens where image-set is understood; ignored (keeping the line above) elsewhere
  el.style.cursor = `image-set(${svgUrl(body, 1)} 1x, ${svgUrl(body, 2)} 2x) 12 12, crosshair`;
}
for (const type of ['keydown', 'keyup']) {
  addEventListener(type, (e) => { if (e.shiftKey !== cursorShift) { cursorShift = e.shiftKey; syncCursor(); } });
}
addEventListener('blur', () => { cursorShift = false; syncCursor(); });
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' && (e.button !== 0 || cameraDrag(e))) { cursorGrab = true; syncCursor(); }
});
addEventListener('pointerup', () => { if (cursorGrab) { cursorGrab = false; syncCursor(); } });
// Swatches, cursor and the style button follow the town's building style
function syncStyle() {
  ({ walls: LIT, roofs: LIT_ROOF } = litOf(townStyle));
  for (const { el, idx } of swatches) {
    if (idx !== null) el.style.backgroundImage = `linear-gradient(${LIT_ROOF[idx]} 45%, ${LIT[idx]} 45%)`;
    else el.style.background = `conic-gradient(${[1, 2, 3, 4, 5, 8, 7, 6, 1].map((i) => LIT[i]).join(', ')})`;
  }
  document.getElementById('btn-style').dataset.tip = `Building style: ${STYLES[townStyle].label} (B)`;
  syncCursor();
}
// The whole town switches at once; the style is saved with it in the link
function setTownStyle(name) {
  if (!STYLES[name] || name === townStyle) return;
  townStyle = name;
  town.setStyle(name);
  syncStyle();
  rebuild();
  scheduleSave();
  toast(`${STYLES[name].label} style`);
}
function nextStyle() {
  const names = Object.keys(STYLES);
  setTownStyle(names[(names.indexOf(townStyle) + 1) % names.length]);
}
function selectColor(idx) {
  selectedColor = idx;
  for (const s of swatches) s.el.classList.toggle('active', s.idx === idx);
  syncCursor();
}
syncStyle();
selectColor(null);

function clearTown() {
  if (!town.cells.size) return;
  for (const k of [...town.cells]) removeCell(Math.floor(k / 64), k % 64);
  commit();
  toast('Cleared · press Z to undo');
}
function toggleMute() {
  sfx.ensure();
  sfx.setMuted(!sfx.muted);
  syncSound();
}
function syncSound() {
  const btn = document.getElementById('btn-sound');
  for (const svg of btn.querySelectorAll('svg')) svg.toggleAttribute('hidden', svg.dataset.sound !== (sfx.muted ? 'off' : 'on'));
  btn.setAttribute('aria-pressed', String(!sfx.muted));
  btn.dataset.tip = sfx.muted ? 'Unmute (M)' : 'Mute (M)';
}
function toggleGrid() {
  gridLines.visible = !gridLines.visible;
  const btn = document.getElementById('btn-grid');
  btn.classList.toggle('on', gridLines.visible);
  btn.setAttribute('aria-pressed', String(gridLines.visible));
}
function syncHistory() {
  document.getElementById('btn-undo').disabled = !undoStack.length && !pending.length;
  document.getElementById('btn-redo').disabled = !redoStack.length;
}
function randomIsland() {
  newWorld(Math.floor(Math.random() * 1e6));
  scheduleSave();
}
function showcase() {
  newWorld(42, showcaseTown);
  scheduleSave();
}

// Help card: open on the first visit, then remember whether it was closed
const helpEl = document.getElementById('help'), helpOpenEl = document.getElementById('help-open');
function setHelp(open) {
  helpEl.classList.toggle('hidden', !open);
  helpOpenEl.classList.toggle('hidden', open);
  try { localStorage.setItem('ts-help', open ? '1' : '0'); } catch {}
}
setHelp((() => { try { return localStorage.getItem('ts-help') === '1'; } catch { return false; } })());

const buttons = {
  'btn-new': randomIsland,
  'btn-showcase': showcase,
  'btn-style': nextStyle,
  'btn-mood': () => setMood((moodIndex + 1) % MOODS.length),
  'btn-rain': () => setRain(!raining),
  'btn-grid': toggleGrid,
  'btn-undo': undo,
  'btn-redo': redo,
  'btn-clear': clearTown,
  'btn-share': share,
  'btn-photo': screenshot,
  'btn-sound': toggleMute,
  'btn-brush': () => setTouchTool('brush'),
  'btn-erase': () => setTouchTool('erase'),
  'help-close': () => setHelp(false),
  'help-open': () => setHelp(true),
  'btn-scroll': nextScrollMode,
};
for (const [id, fn] of Object.entries(buttons)) {
  const el = document.getElementById(id);
  el.onclick = fn;
  // Keep focus off the buttons so Space / Enter never re-trigger them while building
  el.addEventListener('pointerup', () => el.blur());
}
syncSound();

addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (key === 'y') { e.preventDefault(); redo(); return; }
  if (mod) return;
  if (e.key >= '0' && e.key <= '9') {
    const n = Number(e.key);
    if (n <= PALETTE_SIZE) selectColor(n === 0 ? null : n - 1);
  }
  if (key === 'r') randomIsland();
  if (key === 't') showcase();
  if (key === 'b') nextStyle();
  if (key === 'c') clearTown();
  if (key === 'g') toggleGrid();
  if (key === 'h' || e.key === '?') setHelp(helpEl.classList.contains('hidden'));
  if (key === 'n') setMood((moodIndex + 1) % MOODS.length);
  if (key === 'w') setRain(!raining);
  if (key === 'm') toggleMute();
  if (key === 's') share();
  if (key === 'p') screenshot();
  if (key === 'o') setOrbit(true);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  glowScale();
});

// Without a town in the link (a first visit) open on the starter scene up close
if (!loadFromHash()) {
  newWorld(42, starterTown);
  let cx = 0, cz = 0;
  for (const k of town.cells) { const p = grid.verts[Math.floor(k / 64)]; cx += p[0] / town.cells.size; cz += p[1] / town.cells.size; }
  const offset = camera.position.clone().multiplyScalar(0.42);
  controls.target.set(cx, 1.2, cz);
  camera.position.copy(controls.target).add(offset);
}
// Every visit opens circling slowly, like a postcard, until the first touch
setOrbit(true);
// Open at the local time of day, picked by the inline script in index.html
setMood(Math.max(0, MOODS.findIndex((m) => m.name === document.documentElement.dataset.mood)), 0);
// Ambient motion is slow, so after a few idle seconds 30fps looks the same and saves battery.
// Any input or camera movement brings back the full frame rate immediately.
const IDLE_AFTER = 3, IDLE_FRAME = 1 / 30;
let lastFrame = 0;
const markActive = () => { lastActive = now(); };
for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) {
  addEventListener(type, markActive, { capture: true, passive: true });
}
controls.addEventListener('change', markActive);
let splash = document.getElementById('splash');
renderer.setAnimationLoop(() => {
  const t = now();
  // Small slack so a 60Hz display lands on every second frame instead of drifting
  if (t - lastActive > IDLE_AFTER && t - lastFrame < IDLE_FRAME - 0.004) return;
  const dt = Math.min(0.1, t - lastFrame);
  lastFrame = t;
  uTime.value = t;
  controls.update(dt);
  if (needsRebuild) {
    needsRebuild = false;
    rebuild();
    ghostKey = '__stale';
  }
  // Hover raycast only after pointer/camera/town changes, hidden while dragging
  if (hoverDirty) {
    hoverDirty = false;
    if (lastMove && lastMove[2] === 0 && !stroke && !orbiting) setHover(buildTarget(pick(lastMove[0], lastMove[1])));
    else setHover(null);
  }
  if (ghost) ghostMaterial.opacity = 0.35 + 0.15 * Math.sin(t * 6);
  updateTransitions(t);
  updateOrbit(t);
  if (updateMood(t) | updateRain(t)) applyLook();
  updateSmoke(t);
  updateBoats(t);
  updateGulls(t);
  const beam = beamMaterial.uniforms.opacity;
  beam.value = (0.35 * Math.max(0, uNight.value - 0.2)) / 0.8;
  beamGroup.visible = beam.value > 0.002;
  halos.visible = glows.visible = uNight.value > 0.01;
  fireflies.visible = uNight.value > 0.55 && uRain.value < 0.5;
  rainLines.visible = uRain.value > 0.01;
  rainMaterial.uniforms.uColor.value.copy(scene.background).lerp(hemi.color, 0.5).multiplyScalar(1.15);
  rays.visible = mist.visible = uRays.value > 0.01;
  mistMaterial.uniforms.uMistColor.value.copy(scene.background).lerp(sun.color, 0.25);
  uSunDir.value.copy(sun.position).normalize();
  for (const l of lamps) {
    l.g.rotation.y = t * 0.8 + l.phase;
    l.g.scale.setScalar(Math.min(1, Math.max(0.001, (t - l.born - 0.4) / 0.6)));
  }
  renderer.render(scene, camera);
  // The first frame is on screen (shaders compiled): let the town pop in from behind the splash
  if (splash) {
    const el = splash;
    splash = null;
    el.classList.add('done');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

window.__debug = {
  get town() { return town; }, get grid() { return grid; }, rebuild, MAX_LEVEL,
  undo, redo, setMood, setRain, setOrbit, setStyle: setTownStyle, starter: () => newWorld(42, starterTown), world: (s) => newWorld(s), encodeTown, showcase: (only) => newWorld(42, (s) => showcaseTown(s, only)), camera, controls, sfx, frame: () => renderer.info.render.frame, get undoDepth() { return undoStack.length; },
};
