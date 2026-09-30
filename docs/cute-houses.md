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

- [x] Glass with a sky gradient and slanted glints
- [x] Tied-back curtains in some windows
- [x] Ivy climbing some ground-floor walls

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
 - Glass: `skyGlass()` brightens panes towards the top through `shadeFn`; `glint()` adds two slanted
   `GLINT` strips on one world-consistent side of each window (plain, arched). Portholes get the
   gradient only. Glints and curtains glow with the window at night.
 - Curtains: ~40% of the plain and ~30% of the arched windows get tied-back `CURTAINS` drapes at both
   outer pane edges.
 - Ivy: ~22% of the outer ground-floor walls get a patch of `IVY` leaf blobs near one corner, wide at
   the foot and narrowing upwards, reaching into the next floor when there is one.
