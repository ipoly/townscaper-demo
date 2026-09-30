# Cuter houses

Goal: move the houses from "illustrated architecture" towards the chunky, toy-like look of
the original Townscaper.

## Diagnosis

| # | Now | Townscaper | Where |
|---|-----|------------|-------|
| 1 | Low roofs (`ROOF_RISE = 0.45`), no eaves | Steep, oversized roofs with thick overhanging eaves | `town.js` roof pass |
| 2 | Two small windows per face per floor, glazing bars, lintels, sills | One big centered window per face, chunky frame, no bars | `town.js` `wall()` |
| 3 | Dark outlines (`#2e2a28`, 0.6) on every crease, hard corners | Almost no outlines; volumes read through soft corners and AO | `main.js` `outlineMaterial` |
| 4 | Thin, tall stilts with braces | Thick stone pillars and arches | `town.js` posts |
| 5 | Tall floors (`LEVEL_H = 0.85`) | Squatter floors | `town.js` `LEVEL_H` |
| 6 | Muted, dusty palette | More saturated walls, stronger roof contrast | `town.js` `PALETTE` / `ROOF_OF` |

## Plan

### Phase 1: parameters and local geometry

- [x] 1. Roofs: steeper rise, overhanging eaves with a thick rim
- [x] 2. Windows: one bigger centered window per face, no glazing bars, rounder variants
- [x] 3. Outlines: warmer and much lighter
- [x] 4. Stilts: thicker posts, fewer braces
- [x] 5. Floor height: lower `LEVEL_H`, recheck stairs / doors / balconies
- [x] 6. Palette: +10-20% saturation on walls and roofs

### Phase 2: rounded volumes

- [x] Bevelled / rounded wall corners (transition faces at corners, keep outline pairing intact)
- [x] Rounded ridges and eaves (eaves follow rounded corners; ridge caps in phase 4)
- [x] Simple vertex AO (wall feet, under eaves) to replace outlines

### Phase 3: rounded base and small props

- [x] Rounded foundation corners (quay stones and foam follow the arc)
- [x] Flower boxes under some windows
- [x] Striped awnings over some doors
- [x] Rounded ridge caps on hip roofs (moved to phase 4)

### Phase 4: roof and door details

- [x] Rounded ridge caps on ridges and hips
- [x] Chunky chimneys with a cap
- [x] Arched double doors

### Phase 5: street props

- [x] Wall lanterns beside some double doors (glow at night)
- [x] Small bushes at the foot of plaza-facing walls
- [x] Gold finials on the apex of lone pointed roofs

### Phase 6: window and wall charm

- [x] Glass with a sky gradient (slanted glints tried and dropped)
- [x] Tied-back curtains in some windows
- [x] Ivy climbing some ground-floor walls

### Phase 7: softer smoke and door pots

- [x] Round, smooth white smoke puffs instead of grey faceted balls
- [x] Potted shrubs beside some plaza doors

### Phase 8: street strings and plaza props

- [x] Bunting or a washing line strung across the street between two facing houses
- [x] Lamp posts and benches on squares, courtyards and small plazas

## Progress log

- 2026-09-30: diagnosis done; starting phase 1 items 1-3.
- 2026-09-30: phase 1 items 1-3 done.
 - Roofs: `ROOF_RISE` 0.45 -> 0.6. New `eaves()` in `town.js` adds a wedge (top, rim, shaded
   underside) past every outer wall of a pitched roof; strips share their end at edge midpoints and
   mitre at quad centers, open ends are capped. Tunables: `EAVE`, `EAVE_DROP`, `EAVE_RIM`.
 - Windows: the two per-half-wall panes are replaced by one window centered on the face, drawn
   half by each half-wall in world units (`window1()`, `porthole()`). Variants: plain, arched,
   shuttered, balcony (centered), round. Glazing bars and the double small pane are gone.
 - Outlines: `#2e2a28` @ 0.6 -> `#6b5446` @ 0.3.
 - Known leftovers: windows fold where a face kinks at its midpoint on the irregular grid; lean-to
   roofs (now higher) hide more of the lower part of the taller neighbour's windows.
- 2026-09-30: phase 1 items 4-6 done.
 - Posts: colonnade prisms r 0.08, timber posts 0.055 with small knees, stilts 0.085 and tall pillars
   up to 0.13 without braces; stems 0.28. Posts sit closer to the quad center (`lerp2(Q,c,0.2)`).
 - Floors: `LEVEL_H` 0.85 -> 0.75; window, door and balcony heights shifted to fit.
 - Palette: brighter walls and more saturated roofs; the "auto" swatch in `index.html` follows.
- 2026-09-30: phase 2 done (except rounded hip ridges).
 - Rounded corners: `cornerArc()` replaces the Q corner of an isolated outer quadrant (floor above
   ground, 3 empty neighbours at that level, normal style) with a small arc (`CORNER`). Walls stop at
   the arc, arc facets become wall faces, roofs / terraces / porches are fanned over the new rim.
 - Eaves follow the arc. Ledges close the gap between stacked floors whose corners differ.
 - AO: walls are split into bands (`AO_BAND`); vertices at wall feet (`AO_FOOT`) and under eaves
   (`AO_EAVES`) are darkened through `shadeFn` in `tri()`.
 - Known leftovers: ground-floor and walkway corners stay sharp; hip ridges are not rounded.
- 2026-09-30: phase 3 done (except rounded hip ridges).
 - Foundations: `cornerArc()` also rounds isolated ground quadrants at L0 (no pond next to them),
   unless the house above keeps its corner square. The foam ring stops at the arc and follows it.
 - Flower boxes: `flowerBox()` hangs a terracotta or white box with leaves and blooms under ~45% of
   the plain windows.
 - Awnings: `awning()` puts a striped awning (sloped stripes, valance, shaded underside) over ~55% of
   the plaza doors.
 - Known leftovers: a house on a square foundation can still round its own corner (a ledge fills the
   step); hip ridge caps stay sharp.
- 2026-09-30: phase 4 done.
 - Ridge caps: `ridgeCap()` lays a half-round tube (`RIDGE_R`) along each ridge half edge C -> M
   (drawn once, by the quadrant it starts in) and along each convex hip from the apex to the corner
   and on to the eave tip. Valleys (L-shaped inner corners) and flat roofs get none.
 - Chimneys: thicker stack in the wall color (brick on pale walls) with a white cap and a dark flue;
   smoke starts at the cap.
 - Doors: about 60% of the double doors without an awning get a half-round fanlight over both wings.
 - Known leftovers: hip caps kink slightly where they cross from the roof onto the eave (fixed
   after phase 5).
- 2026-09-30: phase 5 done.
 - Lanterns: `lantern()` hangs a slate-framed `LAMP` box on a bracket beside ~50% of the double doors,
   clear of the awning; it glows with the other lamps at night.
 - Bushes: ~45% of the plaza-facing ground-floor walls without a door get two leaf blobs at their foot
   (not on docks).
 - Finials: a pointed roof whose column has no neighbours at that level gets a slate stem and a gold
   knob at the apex.
- 2026-09-30: hip cap kink fixed.
 - `ridgeCap()` now builds one profile per point instead of one frame per segment. Interior points
   use the averaged direction and are stretched along the bend onto the mitre plane, so the roof and
   eave segments of a hip share their joint ring and the cap no longer narrows or steps there.
- 2026-09-30: phase 6 done.
 - Glass: `skyGlass()` brightens panes towards the top through `shadeFn`. Curtains glow with the
   window at night.
 - Curtains: ~40% of the plain and ~30% of the arched windows get tied-back `CURTAINS` drapes at both
   outer pane edges.
 - Ivy: ~22% of the outer ground-floor walls get a patch of `IVY` leaf blobs near one corner, wide at
   the foot and narrowing upwards, reaching into the next floor when there is one.
- 2026-09-30: window glints removed; the slanted strips read as clutter rather than reflections.
- 2026-09-30: nook arches and stray hip caps fixed.
 - Diagonal nooks no longer get an arch; it cut through the windows and doors centered on the walls.
 - Hip caps are only drawn where both edges of the quadrant are low. Beside a same-height ridge or a
   taller wall the C -> Q line lies flat on the slope, so the caps there stuck out past the eave
   (crossing in an X between two roofs, or poking out beside a taller neighbour). The eave tip is
   also skipped when the diagonal quadrant is built.
- 2026-09-30: phase 7 done.
 - Smoke: puffs use a smoother icosphere and a white, slightly emissive material; they start small,
   swell and shrink away as they drift off, so they no longer read as floating rocks.
 - Door pots: ~45% of the ground-floor plaza door halves get a terracotta pot with a round shrub past
   the doorstep, half of them with a few blooms.
- 2026-09-30: phase 8 done.
 - Street strings: an empty ground cell (no dock, no pond, nothing built above) whose two most
   opposite neighbours both have at least two solid floors stores the pair in `info.ss` (~60%).
   `streetString()` hangs a sagging line between the two wall midpoints just under the second-floor
   roofline, with triangle flags (~55%) or three hanging cloths.
 - Plaza props: `plazaProp()` puts a short slate lamp post with a glowing head or a wooden bench with
   a backrest on square and courtyard cells, and less often on small plaza cells.
 - The nook bunting and laundry and the landing lamps already existed; these add the street and
   plaza versions.
- 2026-09-30: leftovers fixed.
 - Bent faces: where the two halves of a face meet at more than ~20 degrees, `splitWidth()` makes each
   half draw its own window centered on it (sized to the shorter half) instead of one window folding
   across the edge midpoint. Shutters and balconies need the whole face, so they become plain windows
   there; ivy skips these walls. About a tenth to a quarter of the faces bend that much.
 - Lean-to roofs: a wall with a lower neighbour's pitched roof rising against it stays blank, so no
   window is half buried under the roof.
 - Walkway and dock corners stay square on purpose: plank piers and railed walkways read as built
   timber. (Ground-floor corners already round off since phase 2.)
- 2026-09-30: new wall + roof palette, generated offline as pairs with `tools/palette.mjs` (Color.js,
  nothing is loaded at runtime).
 - A color choice is a wall + roof pair, so all nine pairs are searched together (seeded simulated
   annealing) and the score is the distance between the two most alike pairs. Picking each color on
   its own left some pairs almost identical.
 - Each wall slot has a hue family and a lightness tier (white, butter, marigold, apricot, coral,
   rose, sage, mint, sky; four pale, three mid, two bold) and a short list of roofs that suit it.
   Roofs are not reused, at least four are warm, and every roof is at least 0.25 darker than its wall.
 - Colors that do not fit sRGB lose chroma only; lightness and hue are kept exactly.
 - Closest pair: deltaE 11.2 (walls) / 10.0 (roofs), OKLab x100. Old share links open with different
   colors.
- 2026-09-30: palette swatches show the pair as it looks in the scene.
 - The raw hex swatches looked much brighter than the walls: the warm sun, the blue-grey ground light
   and ACES tone mapping darken and mute every surface. `litColors()` in `main.js` renders each color
   once at startup through the town material and daytime lights, on a wall and on a 45 degree roof
   facing the sun, and reads the pixels back.
 - Each swatch shows the lit roof color on top and the lit wall color below, since a choice sets
   both and the roof is the more visible. (A sunlit-to-shade gradient of the wall alone was tried
   first; it read darker than the walls and looked like a roof color.)
 - Swatches keep the daytime look at dusk and night.
- 2026-09-30: app icon recolored with two of the new pairs (mint / navy, apricot / brick).
- 2026-09-30: brighter, more vivid look.
 - Tone mapping: ACES Filmic -> Khronos PBR Neutral, which keeps the palette's hue and saturation and
   only rolls off the brightest light (ACES greyed and darkened every surface; AgX was greyer still).
 - Exposure is now per mood and blends with it: day 1.3, dusk 1.2, night 0.95.
 - The hemisphere ground light is a warm grey (`#a89c8a`) instead of blue-grey, so shaded walls stay warm.
 - Soft bloom was tried and dropped: it mostly showed on lit windows at night and cost several extra
   full-screen passes per frame on phones.
- 2026-09-30: colored shade.
 - `withColoredShade()` in `main.js` tints 60% of the sky and ground light with a deeper version of the
   surface color, so shaded walls stay saturated instead of turning grey, like painted plaster. The
   swatch material uses it too, so swatches still match.
 - A fuller fake subsurface scattering (wrap lighting, light through edges, colored rim, roughness 0.5)
   was tried first and dropped: it read as plastic. The surfaces stay matte (roughness 0.85).
- 2026-09-30: halos at dusk and night.
 - Lit windows get a soft rounded glow quad just off the wall, and box lamps get a glowing sprite. Both
   are additive, fade in with `uNight`, and are hidden by day.
 - This replaces bloom without any full-screen pass: one small mesh and one point set, rebuilt with the town.
- 2026-09-30: dawn.
 - A fourth mood after night: cool pastel light (lavender sky, peach sun low on the side opposite dusk),
   pearly water, a nearer fog for morning mist, and lit windows at a faint 15% glow.
 - Fog near and far are now part of each mood and blend with it (default 30 and 70).
 - The dusk icon is now a setting sun; dawn uses the rising sun.
- 2026-09-30: dawn light shafts and pond fireflies.
 - Dawn: nine long soft strips slant in from the sun over the town's footprint, turned to face the
   camera around their own axis and slowly shimmering. Buildings in front still hide them.
 - Night: a few fireflies over pond water, each glowing for about a third of a 9-16 s cycle and then
   fading away to come back somewhere nearby.
 - Both are a single draw each, animated in the vertex shader, with no full-screen pass.
- 2026-09-30: drifting mist under the dawn light shafts.
 - Four stacked horizontal sheets over the town, low to mid height, carrying soft noise that drifts
   slowly and fades out at the edges, tinted from the sky toward the sun.
 - Only drawn at dawn (one extra draw call), so the shafts have something in the air to light up.
- 2026-09-30: day and dusk get their own touches.
 - Day: soft cloud shadows drift over the town and sea, and tiny glints twinkle on the water
   outside them.
 - Dusk: a band of flickering glitter on the sea towards the low sun (seen when facing the sunset).
 - Lit floors switch on in their own random order as night falls, street lamps first: at dusk about
   four in five are on, at dawn only the early risers.
 - Chimneys smoke at dusk, and at dawn in half of the early-riser houses (breakfast).
 - All of it lives in the existing town and water shaders, no extra draw calls.
- 2026-09-30: a splash screen while Three.js loads and the town is built.
 - Plain HTML and CSS in index.html, so it shows at once: the app icon floating, the title and three
   hopping dots in palette colors.
 - It fades out once the first frame has been rendered (shaders compiled), then removes itself.
- 2026-09-30: save a picture of the town (camera button or P).
 - A clean frame without the grid, hover preview or UI, with a white flash and a soft shutter sound.
 - Desktop downloads a PNG named by date and time; phones open the share sheet, so it can go
   straight to Photos.
- 2026-09-30: rain, over any time of day (cloud button or W).
 - Eases in over a few seconds: the sky, light and sea turn a cool grey, the fog comes a little
   closer and some windows and lamps switch on, as on a dark afternoon.
 - Thin slanted streaks fall around the camera target (one draw), and rings spread over the sea
   where drops land.
 - The town gets wet: slightly darker, with a sheen of sky on roofs at grazing angles.
 - Cloud shadows, sea glints, sunset glitter, dawn shafts, stars and fireflies step aside.
 - A soft rain hiss with sparse patter fades in over the surf.
 - The mood blend now lives in its own state, and the weather is layered over it when both are
   written to the scene.
- 2026-09-30: sharper pictures, and an orbit mode.
 - Pictures render at 3x the page size (2x on phones, capped by the GPU's limits), so they come out
   sharp instead of at screen resolution; window glows are scaled to match.
 - Orbit mode starts after 30 s without input (or with O): the UI fades away, the camera circles the
   town once every two minutes, the time of day moves on every 25 s with slower blends, and now and
   then a shower comes or clears up.
 - Any input brings the UI back; that first press (and any within 0.6 s of waking) does nothing
   else, so waking never builds a block. (Later: only a press, wheel or key wakes it, see below.)
- 2026-09-30: the town opens at the local time of day (dawn 5-8, day 8-17, dusk 17-20, night
  otherwise), set at once without a blend.
- 2026-09-30: the splash and icons follow the town.
 - The splash shows the sky of the time of day the town opens at (a tiny inline script reads the
   clock before anything is drawn; main.js starts from the same mood), and the browser theme
   color follows every change of time.
 - App icon redrawn: the two houses now stand on wooden stilts over the sea, with foam, soft
   reflections and a seagull. The maskable icon keeps the sea full-bleed and shrinks only the
   houses into the safe zone.
 - New small favicon: one house on stilts with a big window, readable at 16 px. The tab icon is
   recolored with the time of day, its window lit at dusk and night.
- 2026-09-30: a gentler first visit.
 - Without a town in the link the page opens on a tiny starter scene instead of the showcase: a
   lily pond ringed by garden, a cottage on its bank and a lighthouse across the water, seen up
   close.
 - Every visit, shared links included, opens in orbit mode. Moving the mouse lets it keep
   circling (and hides the hover highlight); a press, wheel or key wakes it, and that input does
   nothing else. The cursor stays visible while orbiting.
 - The help panel starts closed unless it was left open last time.
 - The orbit class lives on <html> and the inline head script sets it before the first paint, so
   the UI never flashes up while main.js is still loading.
- 2026-09-30: Three.js r170 now ships with the app in vendor/three (the minified build, OrbitControls
  and the MIT license) instead of loading from a CDN, so the town no longer depends on a third-party
  host. The service worker serves vendor/ cache-first; its cache moved to townscaper-v2 so the old
  CDN copies get cleared. The title and app name also dropped the word "Demo".
- 2026-09-30: a custom cursor over the town. It is a dab of the paint in hand, roof color over wall
  color like its swatch (a small color wheel for auto), and it changes as colors are picked. Holding
  Shift turns it into a red eraser ring, dragging the view shows a grabbing hand and orbit mode shows
  a faint ring. They are native SVG cursors, with 2x images for sharp screens, so they never lag.

## Refactor towards building styles

Plan: split the geometry code into an emitter (low-level drawing), parts (roofs, walls, carrying,
street, water, landmarks) and style kits (palette plus the few pieces a style draws its own way),
so that a second style, Chinese first, is a new kit rather than branches all over town.js. Every
step keeps the geometry byte for byte the same.

- 2026-09-30: a geometry snapshot test. `node tests/snapshot.mjs` builds the showcase, starter and
  four seeded towns (captured from the app into tests/fixtures.json) plus three random stress towns
  with edits rebuilt incrementally, and compares a fingerprint of every vertex attribute, outline
  and effect list with tests/snapshot.json (`--update` records a new baseline). It runs in about a
  second and a 0.0001 change to the eave overhang fails every town.
- 2026-09-30: step 2, the emitter. Measurements, colors and hash helpers moved to
  town/constants.js; the low-level drawing (triangles, boxes, prisms, cones, bars, ridge caps,
  strings, cloth) moved to an Emitter class in town/emitter.js that owns the current record and the
  outline / sway / shading flags, which used to be variables shared across the whole build closure.
  buildRecords destructures the tools, so call sites are unchanged. Snapshot identical; a full
  build takes the same time (about 185 ms for a 90-column town in Node).
- 2026-09-30: step 3, parts. The building helpers left the build closure for town/parts/: props
  (fountains, trees, fences, plants, bunting, lamps, benches, parasols, ducks, lily pads), landmarks
  (cupola, clock tower, lighthouse top), roofs (eaves, dormers, walkway roofs), carry (posts,
  brackets, joists, tie rods, undersides) and walls (wall face, occlusion bands, everything on a
  wall). Each module is a factory taking the build context (emitter tools, town, verts, units,
  infoOf) plus the parts made before it; the code moved verbatim with `this` becoming `town`.
  emitQuad (the per-quad orchestrator with the roof slopes, spires and nooks) stays in town.js for
  now: its locals are shared too tightly to split mechanically, so pieces come out when a style
  needs them. town.js went from 2403 to 1324 lines. Snapshot identical; checked with ESLint
  no-undef as well, since a missing import would only fail on the branch that uses it.
